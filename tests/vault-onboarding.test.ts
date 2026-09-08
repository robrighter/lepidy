import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Actor, Workspace } from "../src/cloudflare/workspace";
import { base64url, workspaceResourceUri } from "../src/domain/mcp-oauth";
import { encryptVaultValue } from "../src/domain/vault-client-crypto";
import { encodeVaultBytes, type VaultKeyWrap } from "../src/domain/vault-envelope";
import { canaryMarkerFor, canaryValue, scanDigestPreimage } from "../src/domain/vault-canary";

/**
 * V08 — the leak-detection half of agent onboarding, against a real Durable
 * Object with real SQLite.
 *
 * Every scenario is paired: something that must be served or refused, and a
 * valid counterpart that must not be. The canary cases assert what the refusal
 * did *not* leave behind as well as what it did — a message row, a queue item,
 * a proxy row — because a tripwire that alerts after the write has not
 * prevented anything.
 */

const NOW = 1_800_000_000_000;
const ORIGIN = "https://lepidy.test";
const VERIFIER = "vault-onboarding-verifier".padEnd(64, "x");
const encoder = new TextEncoder();

let ordinal = 0;

type Seeded = {
  stub: DurableObjectStub<Workspace>;
  slug: string;
  owner: Actor;
  other: Actor;
  channelId: string;
  connectionId: string;
};

async function seed(label: string): Promise<Seeded> {
  ordinal += 1;
  const slug = `${label}-${ordinal}`;
  const stub = env.WORKSPACE.getByName(slug);
  await stub.initializeWorkspace({ storageMode: "cloud", hostEpoch: 0, routingEpoch: 1, workspaceSlug: slug, now: NOW });
  const owner: Actor = { memberId: "member-owner", authorizationEpoch: 1 };
  const other: Actor = { memberId: "member-other", authorizationEpoch: 1 };
  for (const [memberId, handle, role] of [
    [owner.memberId, "maya", "owner"],
    [other.memberId, "daniel", "member"],
  ] as const) {
    await stub.applyMembership({
      operationId: `${slug}-${memberId}`, memberId, accountId: `account-${slug}-${memberId}`,
      handle, displayName: handle, role, status: "active", authorizationEpoch: 1, version: 1, now: NOW,
    });
  }
  const channel = await stub.createChannel({
    actor: owner, idempotencyKey: `channel:${slug}:0001`, kind: "public", slug: "work",
    memberIds: [other.memberId], now: NOW,
  });
  return { stub, slug, owner, other, channelId: channel.channelId, connectionId: await connect(stub, slug, owner) };
}

async function connect(stub: DurableObjectStub<Workspace>, slug: string, actor: Actor): Promise<string> {
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(VERIFIER))));
  const authorized = await stub.beginOauthAuthorization({
    actor, workspaceSlug: slug, clientId: "client-onboarding", clientName: "Codex",
    redirectUri: "http://127.0.0.1:1234/callback", codeChallenge: challenge,
    scope: "chat:read chat:write agent vault", resource: workspaceResourceUri(ORIGIN, slug), now: NOW,
  });
  if (!authorized.ok) throw new Error(authorized.description);
  const exchanged = await stub.exchangeOauthCode({
    workspaceSlug: slug, code: authorized.code, clientId: "client-onboarding", clientName: "Codex",
    redirectUri: "http://127.0.0.1:1234/callback", codeVerifier: VERIFIER,
    resource: workspaceResourceUri(ORIGIN, slug), now: NOW,
  });
  if (!exchanged.ok) throw new Error(exchanged.description);
  return exchanged.grant.connectionId;
}

function wrap(memberId: string): VaultKeyWrap {
  return {
    custodianMemberId: memberId, recipientKeyEpoch: 1, wrapSuite: "P256-HKDF-SHA256-AES256GCM",
    ephemeralPublicKey: encodeVaultBytes(new Uint8Array(65).fill(7)),
    iv: encodeVaultBytes(new Uint8Array(12).fill(8)),
    wrappedDek: encodeVaultBytes(new Uint8Array(48).fill(9)),
  };
}

async function digestOf(workspaceId: string, credentialId: string, version: number, value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(scanDigestPreimage({ workspaceId, credentialId, version, value }))),
  );
  return encodeVaultBytes(bytes);
}

/** One credential, sealed by the test the way a real client seals one. */
async function createCredential(
  seeded: Seeded,
  suffix: string,
  options: { value?: string; scannable?: boolean; canaryMarker?: string; aclOther?: boolean; name?: string } = {},
) {
  const credentialId = `credential-${suffix}`;
  const workspaceId = seeded.stub.id.toString();
  const value = options.value ?? `lepidy-onboarding-canary-${suffix}`;
  const encrypted = await encryptVaultValue({
    workspaceId, credentialId, version: 1, keyEpoch: 1, plaintext: encoder.encode(value),
  });
  await seeded.stub.createVaultCredential({
    actor: seeded.owner, idempotencyKey: `vault:create:${suffix}`, credentialId,
    metadata: {
      name: options.name ?? `TOKEN_${suffix.toUpperCase().replaceAll("-", "_")}`,
      description: "Onboarding fixture", envVar: "TOKEN", tags: [], commands: ["housectl"], proxyHosts: ["api.example.test"],
    },
    policy: { mode: "auto", allowedDeliveries: ["inject", "device_proxy"], projectIds: [], highRisk: false },
    envelope: encrypted.envelope, wraps: [wrap(seeded.owner.memberId)],
    acl: [
      { subjectType: "member", subjectId: seeded.owner.memberId, verb: "manage" },
      { subjectType: "member", subjectId: seeded.owner.memberId, verb: "use" },
      ...(options.aclOther ? [{ subjectType: "member" as const, subjectId: "member-other", verb: "use" as const }] : []),
    ],
    ...(options.scannable === false
      ? {}
      : { scan: { digest: await digestOf(workspaceId, credentialId, 1, value), length: value.length } }),
    ...(options.canaryMarker === undefined ? {} : { canaryMarker: options.canaryMarker }),
    freshUserVerification: true, localVaultUnlocked: true, now: NOW + 2,
  });
  return { credentialId, value, workspaceId };
}

function rowCounts(stub: DurableObjectStub<Workspace>, sql: string, ...bindings: unknown[]) {
  return runInDurableObject<Workspace, number>(stub, (_instance, state) =>
    state.storage.sql.exec<{ count: number }>(sql, ...(bindings as string[])).one().count,
  );
}

describe("V08 scan targets", () => {
  it("VAULT-ONBOARD-INT-001 serves digests to a member holding a verb and to nobody else", async () => {
    const seeded = await seed("scan-targets");
    const shared = await createCredential(seeded, "shared", { aclOther: true });
    const secret = await createCredential(seeded, "secret");
    const unscannable = await createCredential(seeded, "quiet", { scannable: false });

    const owned = await seeded.stub.listVaultScanTargets({ actor: seeded.owner, now: NOW + 3 });
    expect(owned.targets.map((target) => target.credentialId).sort()).toEqual(
      [shared.credentialId, secret.credentialId].sort(),
    );
    // A credential whose client published no digest simply has no target,
    // rather than an entry with an empty one somebody might treat as a match.
    expect(owned.targets.some((target) => target.credentialId === unscannable.credentialId)).toBe(false);

    // The digest is the one the sealing client computed, so a client can walk
    // its own text and find the value without the value ever leaving.
    const target = owned.targets.find((entry) => entry.credentialId === shared.credentialId);
    expect(target?.digest).toBe(await digestOf(shared.workspaceId, shared.credentialId, 1, shared.value));
    expect(target?.length).toBe(shared.value.length);

    // Deny half, with a valid member rather than a malformed request: this
    // person holds a verb on one credential and must see exactly that one.
    const others = await seeded.stub.listVaultScanTargets({ actor: seeded.other, now: NOW + 3 });
    expect(others.targets.map((entry) => entry.credentialId)).toEqual([shared.credentialId]);

    // Whatever else a target carries, it is never anything that opens a value.
    const serialized = JSON.stringify(owned.targets);
    expect(serialized).not.toContain(shared.value);
    expect(serialized).not.toContain("wrappedDek");
    expect(serialized).not.toContain("ciphertext");
  });

  it("VAULT-ONBOARD-INT-002 replaces a digest on rotation and clears it when none is sent", async () => {
    const seeded = await seed("scan-rotate");
    const created = await createCredential(seeded, "rotating");
    const rotatedValue = "a-completely-different-value";
    const encrypted = await encryptVaultValue({
      workspaceId: created.workspaceId, credentialId: created.credentialId, version: 2, keyEpoch: 2,
      plaintext: encoder.encode(rotatedValue),
    });
    const current = await seeded.stub.describeVaultCredential({ actor: seeded.owner, credentialId: created.credentialId, now: NOW + 3 });
    await seeded.stub.updateVaultCredential({
      actor: seeded.owner, credentialId: created.credentialId,
      metadata: current.credential, policy: current.credential.policy,
      envelope: encrypted.envelope, wraps: [wrap(seeded.owner.memberId)],
      acl: [
        { subjectType: "member", subjectId: seeded.owner.memberId, verb: "manage" },
        { subjectType: "member", subjectId: seeded.owner.memberId, verb: "use" },
      ],
      scan: { digest: await digestOf(created.workspaceId, created.credentialId, 2, rotatedValue), length: rotatedValue.length },
      freshUserVerification: true, localVaultUnlocked: true, now: NOW + 4,
    });
    const rotated = await seeded.stub.listVaultScanTargets({ actor: seeded.owner, now: NOW + 5 });
    expect(rotated.targets[0]?.digest).toBe(await digestOf(created.workspaceId, created.credentialId, 2, rotatedValue));

    // A rotation that sends no target clears the stored one. A target still
    // describing the replaced value would report a dead secret as live and miss
    // the live one, which is worse than having no target at all.
    const third = await encryptVaultValue({
      workspaceId: created.workspaceId, credentialId: created.credentialId, version: 3, keyEpoch: 3,
      plaintext: encoder.encode("third-value-entirely"),
    });
    const now = await seeded.stub.describeVaultCredential({ actor: seeded.owner, credentialId: created.credentialId, now: NOW + 5 });
    await seeded.stub.updateVaultCredential({
      actor: seeded.owner, credentialId: created.credentialId,
      metadata: now.credential, policy: now.credential.policy,
      envelope: third.envelope, wraps: [wrap(seeded.owner.memberId)],
      acl: [
        { subjectType: "member", subjectId: seeded.owner.memberId, verb: "manage" },
        { subjectType: "member", subjectId: seeded.owner.memberId, verb: "use" },
      ],
      freshUserVerification: true, localVaultUnlocked: true, now: NOW + 6,
    });
    expect((await seeded.stub.listVaultScanTargets({ actor: seeded.owner, now: NOW + 7 })).targets).toEqual([]);
  });

  it("VAULT-ONBOARD-INT-003 refuses a malformed digest and a duplicate canary marker", async () => {
    const seeded = await seed("scan-shape");
    const workspaceId = seeded.stub.id.toString();
    const encrypted = await encryptVaultValue({
      workspaceId, credentialId: "credential-bad", version: 1, keyEpoch: 1, plaintext: encoder.encode("value"),
    });
    const base = {
      actor: seeded.owner, credentialId: "credential-bad",
      metadata: { name: "TOKEN_BAD", description: "", envVar: "TOKEN", tags: [], commands: [], proxyHosts: [] },
      policy: { mode: "auto" as const, allowedDeliveries: ["inject" as const], projectIds: [], highRisk: false },
      envelope: encrypted.envelope, wraps: [wrap(seeded.owner.memberId)],
      acl: [
        { subjectType: "member" as const, subjectId: seeded.owner.memberId, verb: "manage" as const },
        { subjectType: "member" as const, subjectId: seeded.owner.memberId, verb: "use" as const },
      ],
      freshUserVerification: true, localVaultUnlocked: true, now: NOW + 3,
    };
    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      await expect(instance.createVaultCredential({
        ...base, idempotencyKey: "vault:create:bad:1", scan: { digest: "too-short", length: 20 },
      })).rejects.toThrow("scan digest");
      await expect(instance.createVaultCredential({
        ...base, idempotencyKey: "vault:create:bad:2",
        scan: { digest: "A".repeat(43), length: 4 },
      })).rejects.toThrow("scan length");
      await expect(instance.createVaultCredential({
        ...base, idempotencyKey: "vault:create:bad:3", canaryMarker: "not-a-canary",
      })).rejects.toThrow("canary marker");
    });
    // Nothing partial survived any of those refusals.
    expect(await rowCounts(seeded.stub, "SELECT COUNT(*) AS count FROM vault_credentials")).toBe(0);

    const marker = canaryMarkerFor("aaaaaaaaaaaa");
    await createCredential(seeded, "trap-one", { canaryMarker: marker, value: canaryValue("aaaaaaaaaaaa", "0".repeat(32)) });
    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      await expect(instance.createVaultCredential({
        ...base, credentialId: "credential-trap-two", idempotencyKey: "vault:create:bad:4", canaryMarker: marker,
      })).rejects.toThrow("already in use");
    });
    expect(await rowCounts(seeded.stub, "SELECT COUNT(*) AS count FROM vault_credentials")).toBe(1);
  });
});

describe("V08 canary tripwire", () => {
  async function withCanary(label: string) {
    const seeded = await seed(label);
    const tag = "b1c2d3e4f5a6";
    const marker = canaryMarkerFor(tag);
    const value = canaryValue(tag, "0123456789abcdef0123456789abcdef");
    const credential = await createCredential(seeded, "trap", { canaryMarker: marker, value, name: "TRAP_TOKEN" });
    return { seeded, marker, value, credential };
  }

  it("VAULT-ONBOARD-INT-004 refuses an agent post carrying a canary and writes nothing", async () => {
    const { seeded, value } = await withCanary("canary-agent");
    const agent = await seeded.stub.createAgent({
      actor: seeded.owner, idempotencyKey: "canary:agent:create", handle: "leaky", now: NOW + 3,
    });
    const before = await rowCounts(seeded.stub, "SELECT COUNT(*) AS count FROM messages");

    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      await expect(instance.postMcpAgentMessage({
        actor: seeded.owner, connectionId: seeded.connectionId, agent: agent.agentId,
        idempotencyKey: "canary:agent:post:1", channelId: seeded.channelId,
        bodyMarkdown: `Here is the token you wanted: ${value}`, now: NOW + 4,
      })).rejects.toThrow("TRAP_TOKEN");
    });

    // The refusal prevented the leak rather than reporting it: no message row
    // for the body, and the idempotency key was never consumed either, so a
    // retry is refused the same way instead of replaying a success.
    const messages = await seeded.stub.readChannelHistory({ actor: seeded.owner, channelId: seeded.channelId, limit: 50 });
    expect(JSON.stringify(messages.messages)).not.toContain(value);

    // One alert per trip: a durable row, an audit entry, and a direct message
    // to the credential's custodian. No excerpt of the body anywhere.
    const trips = await runInDurableObject<Workspace, Record<string, unknown>[]>(seeded.stub, (_instance, state) =>
      state.storage.sql.exec("SELECT * FROM vault_canary_trips").toArray() as Record<string, unknown>[]);
    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({ surface: "mcp_message", member_id: "member-owner", agent_id: agent.agentId, channel_id: seeded.channelId });
    expect(JSON.stringify(trips)).not.toContain(value);

    const audit = await seeded.stub.auditTrail(0, 200);
    const tripped = audit.filter((entry) => entry.eventType === "vault.canary_tripped");
    expect(tripped).toHaveLength(1);
    expect(tripped[0]).toMatchObject({ outcome: "denied", requesterKind: "agent", requesterId: agent.agentId });
    expect(JSON.stringify(audit)).not.toContain(value);

    const alerted = await rowCounts(
      seeded.stub,
      "SELECT COUNT(*) AS count FROM messages WHERE body_markdown LIKE '%TRAP_TOKEN tripped%'",
    );
    expect(alerted).toBe(1);
    // The alert is the only message this attempt produced.
    expect(await rowCounts(seeded.stub, "SELECT COUNT(*) AS count FROM messages")).toBe(before + 1);
  });

  it("VAULT-ONBOARD-INT-005 allows an agent post that names the credential without carrying it", async () => {
    const { seeded, marker } = await withCanary("canary-benign");
    const agent = await seeded.stub.createAgent({
      actor: seeded.owner, idempotencyKey: "canary:benign:create", handle: "tidy", now: NOW + 3,
    });
    const posted = await seeded.stub.postMcpAgentMessage({
      actor: seeded.owner, connectionId: seeded.connectionId, agent: agent.agentId,
      idempotencyKey: "canary:benign:post:1", channelId: seeded.channelId,
      bodyMarkdown: "I used TRAP_TOKEN through `lepidy run --with TRAP_TOKEN` and it worked.",
      now: NOW + 4,
    });
    expect(posted.messageId).toBeTruthy();
    expect(await rowCounts(seeded.stub, "SELECT COUNT(*) AS count FROM vault_canary_trips")).toBe(0);
    // The name is not the marker: talking about a credential is ordinary work,
    // and a tripwire that fired on the name would be unusable.
    expect(marker).not.toContain("TRAP_TOKEN");
  });

  it("VAULT-ONBOARD-INT-006 refuses a person's own message carrying a canary", async () => {
    const { seeded, value } = await withCanary("canary-person");
    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      await expect(instance.sendMessage({
        actor: seeded.owner, idempotencyKey: "canary:person:send:1", channelId: seeded.channelId,
        bodyMarkdown: `found this in a log: ${value}`, now: NOW + 4,
      })).rejects.toThrow("canary credential");
    });
    const trips = await runInDurableObject<Workspace, { surface: string }[]>(seeded.stub, (_instance, state) =>
      state.storage.sql.exec<{ surface: string }>("SELECT surface FROM vault_canary_trips").toArray());
    expect(trips.map((trip) => trip.surface)).toEqual(["message"]);

    // The ordinary path is untouched: a message that carries nothing is sent.
    const fine = await seeded.stub.sendMessage({
      actor: seeded.owner, idempotencyKey: "canary:person:send:2", channelId: seeded.channelId,
      bodyMarkdown: "nothing interesting here", now: NOW + 5,
    });
    expect(fine.messageId).toBeTruthy();
  });

  it("VAULT-ONBOARD-INT-007 refuses a proxy request carrying a canary before any request row exists", async () => {
    const { seeded, value } = await withCanary("canary-proxy");
    const agent = await seeded.stub.createAgent({
      actor: seeded.owner, idempotencyKey: "canary:proxy:create", handle: "prox", now: NOW + 3,
    });
    const delegation = await seeded.stub.createAgentDelegation({
      actor: seeded.owner, agent: agent.agentId, channelIds: [seeded.channelId],
      credentialIds: ["credential-trap"], deliveryModes: ["device_proxy"], projectIds: ["project-a"],
      expiresAt: NOW + 3_600_000, now: NOW + 4,
    });
    const call = {
      actor: seeded.owner, credentialId: "credential-trap", agentId: agent.agentId,
      delegationId: delegation.id, projectId: "project-a",
      origin: { channelId: seeded.channelId, messageId: "message-x" },
      idempotencyKey: "canary:proxy:key:0001", reason: "exfiltrate",
      request: { url: "https://api.example.test/collect", method: "POST", headers: {}, body: `token=${value}` },
      now: NOW + 5,
    };
    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      await expect(instance.requestVaultProxy(call)).rejects.toThrow("canary credential");
      // The same key again is refused the same way rather than replaying a
      // stored result, because nothing was stored.
      await expect(instance.requestVaultProxy(call)).rejects.toThrow("canary credential");
    });
    expect(await rowCounts(seeded.stub, "SELECT COUNT(*) AS count FROM vault_proxy_requests")).toBe(0);
    expect(await rowCounts(seeded.stub, "SELECT COUNT(*) AS count FROM vault_canary_trips")).toBe(2);
  });
});
