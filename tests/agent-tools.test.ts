import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Actor, Workspace } from "../src/cloudflare/workspace";
import { base64url, workspaceResourceUri } from "../src/domain/mcp-oauth";

const NOW = 1_800_000_000_000;
const ORIGIN = "https://lepidy.test";
const VERIFIER = "agent-tools-verifier".padEnd(64, "x");

type Seeded = {
  stub: DurableObjectStub<Workspace>;
  slug: string;
  owner: Actor;
  secondOwner: Actor;
  channelId: string;
  connectionId: string;
};

let ordinal = 0;

async function seed(label: string, storageMode: "cloud" | "local_host" = "cloud"): Promise<Seeded> {
  ordinal += 1;
  const slug = `${label}-${ordinal}`;
  const stub = env.WORKSPACE.getByName(slug);
  await stub.initializeWorkspace({ storageMode, hostEpoch: 0, routingEpoch: 1, workspaceSlug: slug, now: NOW });
  const owner: Actor = { memberId: "member-owner", authorizationEpoch: 1 };
  const secondOwner: Actor = { memberId: "member-two", authorizationEpoch: 1 };
  for (const [memberId, handle, displayName, role] of [
    [owner.memberId, "maya", "Maya Chen", "owner"],
    [secondOwner.memberId, "daniel", "Daniel Park", "owner"],
  ] as const) {
    await stub.applyMembership({
      operationId: `${slug}-${memberId}`,
      memberId,
      accountId: `account-${slug}-${memberId}`,
      handle,
      displayName,
      role,
      status: "active",
      authorizationEpoch: 1,
      version: 1,
      now: NOW,
    });
  }
  const channelId = storageMode === "cloud"
    ? (await stub.createChannel({
        actor: owner,
        idempotencyKey: `channel:create:${slug}:0001`,
        kind: "public",
        slug: "work",
        memberIds: [secondOwner.memberId],
        now: NOW,
      })).channelId
    : "host-channel";
  const connectionId = await connect(stub, slug, owner);
  return { stub, slug, owner, secondOwner, channelId, connectionId };
}

async function connect(stub: DurableObjectStub<Workspace>, slug: string, actor: Actor): Promise<string> {
  const resource = workspaceResourceUri(ORIGIN, slug);
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(VERIFIER))));
  const authorized = await stub.beginOauthAuthorization({
    actor,
    workspaceSlug: slug,
    clientId: "client-agent-tools",
    clientName: "Codex",
    redirectUri: "http://127.0.0.1:1234/callback",
    codeChallenge: challenge,
    scope: "chat:read chat:write agent",
    resource,
    now: NOW,
  });
  if (!authorized.ok) throw new Error(authorized.description);
  const exchanged = await stub.exchangeOauthCode({
    workspaceSlug: slug,
    code: authorized.code,
    clientId: "client-agent-tools",
    clientName: "Codex",
    redirectUri: "http://127.0.0.1:1234/callback",
    codeVerifier: VERIFIER,
    resource,
    now: NOW,
  });
  if (!exchanged.ok) throw new Error(exchanged.description);
  return exchanged.grant.connectionId;
}

async function makeAgent(seeded: Seeded, handle = "releasebot") {
  return seeded.stub.createAgent({
    actor: seeded.owner,
    idempotencyKey: `agent:create:${handle}:000001`,
    handle,
    now: NOW,
  });
}

async function enqueue(seeded: Seeded, handle: string, suffix: string, now: number) {
  return seeded.stub.sendMessage({
    actor: seeded.secondOwner,
    idempotencyKey: `message:agent-tools:${suffix}`,
    channelId: seeded.channelId,
    bodyMarkdown: `@a.${handle} work ${suffix}`,
    now,
  });
}

describe("A03 agent queue execution", () => {
  it("AGENT-QUEUE-INT-001 pages without offsets and keeps display reads separate from execution", async () => {
    const seeded = await seed("queue-page");
    const agent = await makeAgent(seeded);
    await enqueue(seeded, "releasebot", "page000000000001", NOW + 1);
    await enqueue(seeded, "releasebot", "page000000000002", NOW + 2);
    await enqueue(seeded, "releasebot", "page000000000003", NOW + 3);
    const hidden = await seeded.stub.createChannel({
      actor: seeded.secondOwner,
      idempotencyKey: "channel:create:hidden:0001",
      kind: "private",
      slug: "hidden",
      now: NOW + 4,
    });
    await seeded.stub.sendMessage({
      actor: seeded.secondOwner,
      idempotencyKey: "message:agent-tools:hidden01",
      channelId: hidden.channelId,
      bodyMarkdown: "@a.releasebot private work",
      now: NOW + 4,
    });

    const first = await seeded.stub.readAgentQueuePage({
      actor: seeded.owner,
      agent: agent.agentId,
      limit: 2,
      unreadOnly: true,
      order: "oldest",
      peek: true,
      now: NOW + 5,
    });
    expect(first.items.map((item) => item.bodyMarkdown)).toEqual([
      "@a.releasebot work page000000000001",
      "@a.releasebot work page000000000002",
    ]);
    expect(first.nextCursor).not.toBeNull();
    const second = await seeded.stub.readAgentQueuePage({
      actor: seeded.owner,
      agent: "@a.releasebot",
      limit: 2,
      unreadOnly: true,
      order: "oldest",
      cursor: first.nextCursor,
      now: NOW + 6,
    });
    expect(second.items.map((item) => item.bodyMarkdown)).toEqual(["@a.releasebot work page000000000003"]);

    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      const rows = state.storage.sql
        .exec<{ read_at: number | null; execution_state: string }>(
          "SELECT read_at, execution_state FROM agent_queue ORDER BY enqueued_at",
        )
        .toArray();
      expect(rows).toEqual([
        { read_at: null, execution_state: "pending" },
        { read_at: null, execution_state: "pending" },
        { read_at: NOW + 6, execution_state: "pending" },
        { read_at: null, execution_state: "pending" },
      ]);
    });
    expect((await seeded.stub.listAgents({ actor: seeded.owner })).agents[0].queueDepth).toBe(2);
  });

  it("AGENT-QUEUE-INT-002 gives concurrent claimers one fenced lease and replays exact requests", async () => {
    const seeded = await seed("queue-claim");
    const agent = await makeAgent(seeded);
    await enqueue(seeded, "releasebot", "claim00000000001", NOW + 1);
    const firstInput = {
      actor: seeded.owner,
      connectionId: seeded.connectionId,
      agent: agent.agentId,
      claimId: "claim-request-0001",
      leaseToken: "lease-token-a".padEnd(40, "a"),
      sessionId: "session-a",
      now: NOW + 2,
    };
    const [first, second] = await Promise.all([
      seeded.stub.claimAgentWork(firstInput),
      seeded.stub.claimAgentWork({ ...firstInput, claimId: "claim-request-0002", leaseToken: "lease-token-b".padEnd(40, "b"), sessionId: "session-b" }),
    ]);
    expect([first.lease, second.lease].filter(Boolean)).toHaveLength(1);
    const winner = first.lease ? first : second;
    const winnerInput = first.lease
      ? firstInput
      : { ...firstInput, claimId: "claim-request-0002", leaseToken: "lease-token-b".padEnd(40, "b"), sessionId: "session-b" };
    expect(await seeded.stub.claimAgentWork(winnerInput)).toMatchObject({ replayed: true, lease: winner.lease });
    if (!winner.lease) throw new Error("expected lease");

    const proof = {
      actor: seeded.owner,
      connectionId: seeded.connectionId,
      agent: agent.agentId,
      itemId: winner.lease.itemId,
      sessionId: winner.lease.sessionId,
      leaseGeneration: winner.lease.leaseGeneration,
      leaseToken: winnerInput.leaseToken,
    };
    await seeded.stub.markAgentExecutionStarted({ ...proof, now: NOW + 3 });
    expect(
      await seeded.stub.completeAgentWork({
        ...proof,
        completionId: "completion-0001",
        outputDigest: "sha256:answer-one",
        result: { reply: "ok" },
        now: NOW + 4,
      }),
    ).toEqual({ completedAt: NOW + 4, replayed: false });
    expect(
      await seeded.stub.completeAgentWork({
        ...proof,
        completionId: "completion-0001",
        outputDigest: "sha256:answer-one",
        result: { reply: "ok" },
        now: NOW + 5,
      }),
    ).toEqual({ completedAt: NOW + 4, replayed: true });

    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      await expect(instance.renewAgentLease({ ...proof, now: NOW + 6 })).rejects.toThrow("stale agent lease");
      await expect(
        instance.completeAgentWork({
          ...proof,
          leaseToken: "wrong-lease-token".padEnd(40, "x"),
          completionId: "completion-0001",
          outputDigest: "sha256:answer-one",
          now: NOW + 6,
        }),
      ).rejects.toThrow("stale agent lease");
      await expect(
        instance.completeAgentWork({
          ...proof,
          completionId: "completion-other",
          outputDigest: "sha256:other",
          now: NOW + 6,
        }),
      ).rejects.toThrow("completion id or digest conflicts");
    });
    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      const audit = state.storage.sql
        .exec<{ event_type: string; requester_id: string; metadata_json: string }>(
          "SELECT event_type, requester_id, metadata_json FROM audit_events WHERE event_type LIKE 'agent.work_%' ORDER BY sequence",
        )
        .toArray();
      expect(audit.map((entry) => entry.event_type)).toEqual(["agent.work_claimed", "agent.work_completed"]);
      expect(audit.every((entry) => entry.requester_id === seeded.owner.memberId)).toBe(true);
      expect(audit[0].metadata_json).toContain(seeded.connectionId);
      expect(JSON.stringify(audit)).not.toContain(winnerInput.leaseToken);
    });
  });

  it("AGENT-QUEUE-INT-003 retries only pre-start loss and holds ambiguous post-start work", async () => {
    const seeded = await seed("queue-retry");
    const agent = await makeAgent(seeded);
    await enqueue(seeded, "releasebot", "retry00000000001", NOW + 1);
    const claim = await seeded.stub.claimAgentWork({
      actor: seeded.owner,
      connectionId: seeded.connectionId,
      agent: agent.agentId,
      claimId: "retry-claim-0001",
      leaseToken: "retry-token-a".padEnd(40, "a"),
      sessionId: "session-a",
      now: NOW + 2,
    });
    expect(claim.lease?.attemptCount).toBe(1);
    expect(
      (await seeded.stub.claimAgentWork({
        actor: seeded.owner,
        connectionId: seeded.connectionId,
        agent: agent.agentId,
        claimId: "retry-claim-too-soon",
        leaseToken: "retry-token-b".padEnd(40, "b"),
        sessionId: "session-b",
        now: NOW + 62_001,
      })).lease,
    ).toBeNull();
    const retried = await seeded.stub.claimAgentWork({
      actor: seeded.owner,
      connectionId: seeded.connectionId,
      agent: agent.agentId,
      claimId: "retry-claim-0002",
      leaseToken: "retry-token-c".padEnd(40, "c"),
      sessionId: "session-c",
      now: NOW + 67_002,
    });
    expect(retried.lease).toMatchObject({ attemptCount: 2, leaseGeneration: 2 });
    if (!retried.lease) throw new Error("expected retry lease");
    await seeded.stub.markAgentExecutionStarted({
      actor: seeded.owner,
      connectionId: seeded.connectionId,
      agent: agent.agentId,
      itemId: retried.lease.itemId,
      sessionId: retried.lease.sessionId,
      leaseGeneration: retried.lease.leaseGeneration,
      leaseToken: "retry-token-c".padEnd(40, "c"),
      now: NOW + 67_003,
    });
    expect(
      (await seeded.stub.claimAgentWork({
        actor: seeded.owner,
        connectionId: seeded.connectionId,
        agent: agent.agentId,
        claimId: "retry-claim-0003",
        leaseToken: "retry-token-d".padEnd(40, "d"),
        sessionId: "session-d",
        now: NOW + 127_003,
      })).lease,
    ).toBeNull();
    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ execution_state: string }>("SELECT execution_state FROM agent_queue").one().execution_state).toBe("needs_attention");
    });
  });

  it("AGENT-TOOLS-INT-001 enforces live ownership and scope and persists unforgeable attribution", async () => {
    const seeded = await seed("agent-post");
    const first = await makeAgent(seeded, "releasebot");
    const second = await makeAgent(seeded, "triage");
    await seeded.stub.setAgentScope({ actor: seeded.owner, agentId: first.agentId, mode: "listed", channelIds: [seeded.channelId], now: NOW + 1 });
    const root = await enqueue(seeded, "releasebot", "post000000000001", NOW + 2);
    const posted = await seeded.stub.postMcpAgentMessage({
      actor: seeded.owner,
      connectionId: seeded.connectionId,
      agent: first.agentId,
      idempotencyKey: "mcp:agent:post:000001",
      channelId: seeded.channelId,
      threadParentId: root.messageId,
      bodyMarkdown: "Done. @a.triage please do not loop.",
      now: NOW + 3,
    });
    const history = await seeded.stub.readThreadHistory({ actor: seeded.owner, threadRootId: root.messageId });
    expect(history.messages[0]).toMatchObject({
      id: posted.messageId,
      authorKind: "agent",
      authorId: first.agentId,
      mcpAttribution: {
        connectionId: seeded.connectionId,
        operatingMemberId: seeded.owner.memberId,
        agentId: first.agentId,
        clientName: "Codex",
      },
    });
    expect((await seeded.stub.readAgentQueue({ actor: seeded.owner, agentId: second.agentId })).depth).toBe(0);

    await seeded.stub.addAgentOwner({ actor: seeded.owner, agentId: first.agentId, memberId: seeded.secondOwner.memberId, now: NOW + 4 });
    await seeded.stub.removeAgentOwner({ actor: seeded.owner, agentId: first.agentId, memberId: seeded.owner.memberId, now: NOW + 5 });
    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      await expect(
        instance.postMcpAgentMessage({
          actor: seeded.owner,
          connectionId: seeded.connectionId,
          agent: first.agentId,
          idempotencyKey: "mcp:agent:post:000002",
          channelId: seeded.channelId,
          bodyMarkdown: "should fail",
          now: NOW + 6,
        }),
      ).rejects.toThrow("agent not found");
    });
  });

  it("AGENT-TOOLS-INT-002 keeps Solo content out of the cloud object", async () => {
    const seeded = await seed("agent-solo", "local_host");
    const agent = await makeAgent(seeded);
    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      await expect(
        instance.postMcpAgentMessage({
          actor: seeded.owner,
          connectionId: seeded.connectionId,
          agent: agent.agentId,
          idempotencyKey: "mcp:agent:solo:000001",
          channelId: seeded.channelId,
          bodyMarkdown: "must stay local",
          now: NOW + 1,
        }),
      ).rejects.toThrow("content_is_host_owned");
    });
  });

  it("AGENT-TOOLS-INT-003 applies scope and a strongly consistent per-connection-agent write brake", async () => {
    const seeded = await seed("agent-rate");
    const first = await makeAgent(seeded, "releasebot");
    const second = await makeAgent(seeded, "triage");
    await seeded.stub.setAgentScope({
      actor: seeded.owner,
      agentId: first.agentId,
      mode: "listed",
      channelIds: [seeded.channelId],
      now: NOW + 1,
    });
    const outside = await seeded.stub.createChannel({
      actor: seeded.owner,
      idempotencyKey: "channel:create:outside:0001",
      kind: "public",
      slug: "outside",
      now: NOW + 2,
    });
    await runInDurableObject<Workspace, void>(seeded.stub, async (instance, state) => {
      const before = state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages").one().n;
      await expect(
        instance.postMcpAgentMessage({
          actor: seeded.owner,
          connectionId: seeded.connectionId,
          agent: first.agentId,
          idempotencyKey: "mcp:agent:outside:0001",
          channelId: outside.channelId,
          bodyMarkdown: "scope must refuse this",
          now: NOW + 3,
        }),
      ).rejects.toThrow("agent cannot post in this room");
      expect(state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages").one().n).toBe(before);
    });

    for (let index = 0; index < 20; index += 1) {
      await seeded.stub.postMcpAgentMessage({
        actor: seeded.owner,
        connectionId: seeded.connectionId,
        agent: first.agentId,
        idempotencyKey: `mcp:agent:rate:${String(index).padStart(4, "0")}`,
        channelId: seeded.channelId,
        bodyMarkdown: `bounded write ${index}`,
        now: NOW + 10 + index,
      });
    }
    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      await expect(
        instance.postMcpAgentMessage({
          actor: seeded.owner,
          connectionId: seeded.connectionId,
          agent: first.agentId,
          idempotencyKey: "mcp:agent:rate:over",
          channelId: seeded.channelId,
          bodyMarkdown: "one too many",
          now: NOW + 40,
        }),
      ).rejects.toThrow("rate limited");
    });
    // A second agent has its own bucket under the same connection.
    await expect(
      seeded.stub.postMcpAgentMessage({
        actor: seeded.owner,
        connectionId: seeded.connectionId,
        agent: second.agentId,
        idempotencyKey: "mcp:agent:rate:second",
        channelId: seeded.channelId,
        bodyMarkdown: "independent bucket",
        now: NOW + 41,
      }),
    ).resolves.toMatchObject({ replayed: false });
  });
});
