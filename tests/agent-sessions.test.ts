import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Actor, Workspace } from "../src/cloudflare/workspace";

const NOW = 1_800_000_000_000;
let ordinal = 0;

async function seed(label: string) {
  ordinal += 1;
  const slug = `${label}-${ordinal}`;
  const stub = env.WORKSPACE.getByName(slug);
  await stub.initializeWorkspace({ storageMode: "cloud", hostEpoch: 0, routingEpoch: 1, workspaceSlug: slug, now: NOW });
  const owner: Actor = { memberId: "member-owner", authorizationEpoch: 1 };
  const second: Actor = { memberId: "member-second", authorizationEpoch: 1 };
  for (const [actor, handle] of [[owner, "maya"], [second, "daniel"]] as const) {
    await stub.applyMembership({
      operationId: `${slug}:${actor.memberId}:1`,
      memberId: actor.memberId,
      accountId: `${slug}:${actor.memberId}`,
      handle,
      displayName: handle,
      role: "owner",
      status: "active",
      authorizationEpoch: 1,
      version: 1,
      now: NOW,
    });
  }
  const allowed = await stub.createChannel({ actor: owner, idempotencyKey: `${slug}:allowed`, kind: "public", slug: "allowed", memberIds: [second.memberId], now: NOW });
  const outside = await stub.createChannel({ actor: owner, idempotencyKey: `${slug}:outside`, kind: "public", slug: "outside", memberIds: [second.memberId], now: NOW });
  const agent = await stub.createAgent({ actor: owner, idempotencyKey: `${slug}:agent`, handle: "runner", now: NOW });
  const delegation = await stub.createAgentDelegation({
    actor: owner,
    agent: agent.agentId,
    channelIds: [allowed.channelId],
    credentialIds: ["credential-test"],
    deliveryModes: ["inject"],
    projectIds: ["project-local"],
    spendCapDailyCents: 2_000,
    rateLimitPerHour: 30,
    expiresAt: NOW + 24 * 60 * 60 * 1000,
    now: NOW,
  });
  const session = await stub.startAgentSession({
    actor: owner,
    delegationId: delegation.id,
    deviceId: "runner-device-1",
    runnerEpoch: 7,
    presetRevision: 3,
    capabilities: ["whoami", "list_channels", "read_channel", "read_thread", "agent_inbox", "agent_next", "agent_start", "agent_renew", "agent_complete", "agent_post"],
    now: NOW,
  });
  return { stub, slug, owner, second, allowed: allowed.channelId, outside: outside.channelId, agent: agent.agentId, delegation, session };
}

describe("A04 delegated session authority", () => {
  it("AGENT-SESSION-INT-001 stores only a digest and grants only explicit non-widening tools", async () => {
    const seeded = await seed("session-capability");
    expect(seeded.session.token).toMatch(new RegExp(`^lpd_st_${seeded.slug}_`));
    expect(
      await seeded.stub.authenticateMcpToken({ token: seeded.session.token, audience: "ignored-for-opaque-session", toolName: "read_thread", now: NOW + 1 }),
    ).toMatchObject({ ok: true, principal: { credentialKind: "session", agentId: seeded.agent, delegationId: seeded.delegation.id, channelIds: [seeded.allowed] } });
    expect(
      await seeded.stub.authenticateMcpToken({ token: seeded.session.token, audience: "", toolName: "post_message", now: NOW + 1 }),
    ).toMatchObject({ ok: false, error: "insufficient_scope" });
    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      const stored = state.storage.sql.exec<{ token_hash: string }>("SELECT token_hash FROM agent_sessions").one();
      expect(stored.token_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(state.storage.sql.exec("SELECT * FROM audit_events").toArray())).not.toContain(seeded.session.token);
    });
  });

  it("AGENT-SESSION-INT-002 intersects posting and claims with the delegated channels", async () => {
    const seeded = await seed("session-channel");
    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      await expect(
        instance.postMcpAgentMessage({ actor: seeded.owner, sessionToken: seeded.session.token, agent: seeded.agent, idempotencyKey: "session:post:outside", channelId: seeded.outside, bodyMarkdown: "should not land", now: NOW + 1 }),
      ).rejects.toThrow("delegation does not include");
    });
    const posted = await seeded.stub.postMcpAgentMessage({ actor: seeded.owner, sessionToken: seeded.session.token, agent: seeded.agent, idempotencyKey: "session:post:allowed", channelId: seeded.allowed, bodyMarkdown: "delegated reply", now: NOW + 2 });
    const history = await seeded.stub.readMcpChannelHistory({ actor: seeded.owner, channelId: seeded.allowed });
    expect(history.messages.find((message) => message.id === posted.messageId)?.mcpAttribution).toMatchObject({
      connectionId: null,
      sessionId: seeded.session.sessionId,
      delegationId: seeded.delegation.id,
      agentId: seeded.agent,
      deviceId: "runner-device-1",
    });

    await seeded.stub.sendMessage({ actor: seeded.second, idempotencyKey: "session:outside:mention", channelId: seeded.outside, bodyMarkdown: "@a.runner outside", now: NOW + 3 });
    await seeded.stub.sendMessage({ actor: seeded.second, idempotencyKey: "session:inside:mention", channelId: seeded.allowed, bodyMarkdown: "@a.runner inside", now: NOW + 4 });
    const claimed = await seeded.stub.claimAgentWork({
      actor: seeded.owner,
      sessionToken: seeded.session.token,
      agent: seeded.agent,
      claimId: "session-claim-0001",
      leaseToken: "session-lease-token".padEnd(40, "x"),
      sessionId: seeded.session.sessionId,
      now: NOW + 5,
    });
    expect(claimed.item?.channelId).toBe(seeded.allowed);
  });

  it("AGENT-SESSION-INT-003 rotates with the exact tuple and invalidates the prior token", async () => {
    const seeded = await seed("session-rotate");
    const rotated = await seeded.stub.rotateAgentSessionToken({
      sessionId: seeded.session.sessionId,
      currentToken: seeded.session.token,
      agentId: seeded.agent,
      ownerMemberId: seeded.owner.memberId,
      delegationId: seeded.delegation.id,
      deviceId: "runner-device-1",
      runnerEpoch: 7,
      presetRevision: 3,
      now: NOW + 1,
    });
    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      await expect(instance.rotateAgentSessionToken({
        sessionId: seeded.session.sessionId,
        currentToken: rotated.token,
        agentId: seeded.agent,
        ownerMemberId: seeded.owner.memberId,
        delegationId: seeded.delegation.id,
        deviceId: "runner-device-1",
        runnerEpoch: 8,
        presetRevision: 3,
        now: NOW + 2,
      })).rejects.toThrow("binding does not match");
    });
    expect(await seeded.stub.authenticateMcpToken({ token: seeded.session.token, audience: "", toolName: "whoami", now: NOW + 2 })).toMatchObject({ ok: false });
    expect(await seeded.stub.authenticateMcpToken({ token: rotated.token, audience: "", toolName: "whoami", now: NOW + 2 })).toMatchObject({ ok: true });
  });

  it("AGENT-SESSION-INT-004 cuts authority off on delegation revoke, owner removal, offboarding, pause and expiry", async () => {
    const revoked = await seed("session-revoke");
    await revoked.stub.revokeAgentDelegation({ actor: revoked.owner, delegationId: revoked.delegation.id, now: NOW + 1 });
    expect(await revoked.stub.authenticateMcpToken({ token: revoked.session.token, audience: "", toolName: "whoami", now: NOW + 2 })).toMatchObject({ ok: false });

    const removed = await seed("session-owner");
    await removed.stub.addAgentOwner({ actor: removed.owner, agentId: removed.agent, memberId: removed.second.memberId, now: NOW + 1 });
    await removed.stub.removeAgentOwner({ actor: removed.second, agentId: removed.agent, memberId: removed.owner.memberId, now: NOW + 2 });
    expect(await removed.stub.authenticateMcpToken({ token: removed.session.token, audience: "", toolName: "whoami", now: NOW + 3 })).toMatchObject({ ok: false });
    await removed.stub.addAgentOwner({ actor: removed.second, agentId: removed.agent, memberId: removed.owner.memberId, now: NOW + 4 });
    expect(await removed.stub.authenticateMcpToken({ token: removed.session.token, audience: "", toolName: "whoami", now: NOW + 5 })).toMatchObject({ ok: false });

    const offboarded = await seed("session-offboard");
    await offboarded.stub.applyMembership({ operationId: "offboard-owner-v2", memberId: offboarded.owner.memberId, accountId: `${offboarded.slug}:owner`, handle: "maya", displayName: "maya", role: "owner", status: "suspended", authorizationEpoch: 2, version: 2, now: NOW + 1 });
    expect(await offboarded.stub.authenticateMcpToken({ token: offboarded.session.token, audience: "", toolName: "whoami", now: NOW + 2 })).toMatchObject({ ok: false });

    const paused = await seed("session-paused");
    await paused.stub.setAgentStatus({ actor: paused.owner, agentId: paused.agent, status: "paused", now: NOW + 1 });
    expect(await paused.stub.authenticateMcpToken({ token: paused.session.token, audience: "", toolName: "whoami", now: NOW + 2 })).toMatchObject({ ok: false });
    await paused.stub.setAgentStatus({ actor: paused.owner, agentId: paused.agent, status: "active", now: NOW + 3 });
    expect(await paused.stub.authenticateMcpToken({ token: paused.session.token, audience: "", toolName: "whoami", now: NOW + 4 })).toMatchObject({ ok: false });

    const expired = await seed("session-expired");
    expect(await expired.stub.authenticateMcpToken({ token: expired.session.token, audience: "", toolName: "whoami", now: expired.session.tokenExpiresAt })).toMatchObject({ ok: false });
  });

  it("AGENT-SESSION-INT-005 replaces the previous live session and refuses a cross-workspace token", async () => {
    const seeded = await seed("session-replace");
    const replacement = await seeded.stub.startAgentSession({ actor: seeded.owner, delegationId: seeded.delegation.id, deviceId: "runner-device-2", runnerEpoch: 8, presetRevision: 4, capabilities: ["whoami"], now: NOW + 1 });
    expect(await seeded.stub.authenticateMcpToken({ token: seeded.session.token, audience: "", toolName: "whoami", now: NOW + 2 })).toMatchObject({ ok: false });
    expect(await seeded.stub.authenticateMcpToken({ token: replacement.token, audience: "", toolName: "whoami", now: NOW + 2 })).toMatchObject({ ok: true });
    const other = await seed("session-other");
    expect(await other.stub.authenticateMcpToken({ token: replacement.token, audience: "", toolName: "whoami", now: NOW + 2 })).toMatchObject({ ok: false });
  });
});
