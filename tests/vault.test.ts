import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Actor, Workspace } from "../src/cloudflare/workspace";
import { decryptVaultValue, encryptVaultValue, unwrapVaultDek, wrapVaultDek } from "../src/domain/vault-client-crypto";
import { VAULT_APPROVAL_TTL_MS, canonicalApprovalDigest } from "../src/domain/vault-approval";
import { VAULT_WRAP_SUITE, encodeVaultBytes, type VaultKeyWrap } from "../src/domain/vault-envelope";

const NOW = 1_800_000_000_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function seed(name: string, storageMode: "cloud" | "local_host" = "cloud") {
  const stub = env.WORKSPACE.getByName(name);
  await stub.initializeWorkspace({ storageMode, hostEpoch: 0, routingEpoch: 1, now: NOW });
  for (const [index, memberId] of ["owner", "member", "outsider"].entries()) {
    await stub.applyMembership({
      operationId: `${name}:${memberId}:v1`, memberId, accountId: `${name}:${memberId}`,
      handle: memberId, displayName: memberId, role: index === 0 ? "owner" : "member",
      status: "active", authorizationEpoch: 1, version: 1, now: NOW,
    });
  }
  const owner: Actor = { memberId: "owner", authorizationEpoch: 1 };
  if (storageMode === "local_host") {
    return { stub, owner, member: { memberId: "member", authorizationEpoch: 1 } satisfies Actor, outsider: { memberId: "outsider", authorizationEpoch: 1 } satisfies Actor, channelId: "host-channel", messageId: "host-message" };
  }
  const channel = await stub.createChannel({ actor: owner, idempotencyKey: `vault:channel:${name}:0001`, kind: "public", slug: "vault", memberIds: ["member", "outsider"], now: NOW });
  const message = await stub.sendMessage({ actor: owner, idempotencyKey: `vault:message:${name}:0001`, channelId: channel.channelId, bodyMarkdown: "Use the configured credential.", now: NOW + 1 });
  return { stub, owner, member: { memberId: "member", authorizationEpoch: 1 } satisfies Actor, outsider: { memberId: "outsider", authorizationEpoch: 1 } satisfies Actor, channelId: channel.channelId, messageId: message.messageId };
}

/**
 * A real custodian wrapping key pair. The private half stays in the test, which
 * is the point: the workspace only ever sees the public half and the sealed
 * wrap, exactly as it only ever sees a real client's.
 */
async function custodianKey() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits", "deriveKey"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { privateKey: pair.privateKey, raw, encoded: encodeVaultBytes(raw) };
}

function wrap(memberId = "owner"): VaultKeyWrap {
  return { custodianMemberId: memberId, recipientKeyEpoch: 1, wrapSuite: "P256-HKDF-SHA256-AES256GCM", ephemeralPublicKey: encodeVaultBytes(new Uint8Array(65).fill(7)), iv: encodeVaultBytes(new Uint8Array(12).fill(8)), wrappedDek: encodeVaultBytes(new Uint8Array(48).fill(9)) };
}

async function createCredential(seeded: Awaited<ReturnType<typeof seed>>, suffix: string, options: { mode?: "ask" | "auto"; maxUsesPerHour?: number; aclMember?: boolean; plaintext?: string } = {}) {
  const credentialId = `credential-${suffix}`;
  const encrypted = await encryptVaultValue({ workspaceId: seeded.stub.id.toString(), credentialId, version: 1, keyEpoch: 1, plaintext: encoder.encode(options.plaintext ?? `canary-${suffix}`) });
  const acl = [
    { subjectType: "member" as const, subjectId: "owner", verb: "manage" as const },
    { subjectType: "member" as const, subjectId: "owner", verb: "use" as const },
    ...(options.aclMember ? [{ subjectType: "member" as const, subjectId: "member", verb: "use" as const }] : []),
  ];
  const created = await seeded.stub.createVaultCredential({
    actor: seeded.owner, idempotencyKey: `vault:create:${suffix}:000001`, credentialId,
    metadata: { name: `TOKEN_${suffix.toUpperCase()}`, description: "Test token", envVar: "TOKEN", tags: ["test"], commands: ["tool"], proxyHosts: ["api.example.test"] },
    policy: { mode: options.mode ?? "ask", allowedDeliveries: ["inject"], projectIds: ["project-a"], grantTtlMs: 60_000, ...(options.maxUsesPerHour === undefined ? {} : { maxUsesPerHour: options.maxUsesPerHour }), highRisk: true },
    envelope: encrypted.envelope, wraps: [wrap()], acl, freshUserVerification: true, localVaultUnlocked: true, now: NOW + 2,
  });
  return { credentialId, encrypted, created };
}

/** A credential two people manage, so a card has two possible answerers. */
async function sharedCredential(seeded: Awaited<ReturnType<typeof seed>>, suffix: string) {
  const credentialId = `credential-${suffix}`;
  const encrypted = await encryptVaultValue({
    workspaceId: seeded.stub.id.toString(), credentialId, version: 1, keyEpoch: 1,
    plaintext: encoder.encode(`canary-${suffix}`),
  });
  await seeded.stub.createVaultCredential({
    actor: seeded.owner, idempotencyKey: `vault:create:${suffix}:000001`, credentialId,
    metadata: { name: `TOKEN_${suffix.toUpperCase()}`, description: "Shared token", envVar: "TOKEN", tags: [], commands: [], proxyHosts: [] },
    policy: { mode: "ask", allowedDeliveries: ["inject"], projectIds: ["project-a"], highRisk: false },
    envelope: encrypted.envelope, wraps: [wrap("owner"), wrap("member")],
    acl: [
      { subjectType: "member", subjectId: "owner", verb: "manage" },
      { subjectType: "member", subjectId: "member", verb: "manage" },
      { subjectType: "member", subjectId: "owner", verb: "use" },
    ],
    freshUserVerification: true, localVaultUnlocked: true, now: NOW + 2,
  });
  return { credentialId, encrypted };
}

function requestApproval(seeded: Awaited<ReturnType<typeof seed>>, credentialIds: readonly string[], now: number) {
  return seeded.stub.requestVaultApproval({
    actor: seeded.owner, credentialIds,
    device: { id: "device-a", active: true, ownedByMember: true, signatureVerified: true, nonceFresh: true },
    origin: { channelId: seeded.channelId, messageId: seeded.messageId },
    projectId: "project-a", delivery: "inject", reason: "run the deploy", now,
  });
}

describe("encrypted credential vault", () => {
  it("VAULT-INT-001 stores client ciphertext, exposes metadata separately, and refuses Solo cloud content", async () => {
    const seeded = await seed("vault-crud");
    const made = await createCredential(seeded, "CRUD", { aclMember: true, plaintext: "vault-plaintext-canary" });
    expect(made.created).toMatchObject({ created: true, credential: { name: "TOKEN_CRUD", version: 1 } });
    expect((await seeded.stub.listVaultCredentials({ actor: seeded.member, now: NOW + 3 })).credentials[0]).not.toHaveProperty("ciphertext");
    expect((await seeded.stub.listVaultCredentials({ actor: seeded.outsider, now: NOW + 3 })).credentials).toEqual([]);
    const stored = await seeded.stub.getVaultCredentialCiphertext({ actor: seeded.owner, credentialId: made.credentialId, freshUserVerification: true, localVaultUnlocked: true });
    expect(decoder.decode(await decryptVaultValue({ workspaceId: seeded.stub.id.toString(), credentialId: made.credentialId, envelope: stored.envelope, dek: made.encrypted.dek }))).toBe("vault-plaintext-canary");

    const dekMarker = encodeVaultBytes(made.encrypted.dek);
    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      const tables = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'").toArray();
      const durableDump = tables.map(({ name }) => JSON.stringify(state.storage.sql.exec(`SELECT * FROM ${name}`).toArray())).join("\n");
      expect(durableDump).not.toContain("vault-plaintext-canary");
      expect(durableDump).not.toContain(dekMarker);
    });

    const solo = await seed("vault-solo", "local_host");
    const soloEncrypted = await encryptVaultValue({ workspaceId: solo.stub.id.toString(), credentialId: "credential-solo", version: 1, keyEpoch: 1, plaintext: encoder.encode("never-cloud") });
    await runInDurableObject<Workspace, void>(solo.stub, async (instance) => {
      await expect(instance.createVaultCredential({ actor: solo.owner, idempotencyKey: "vault:create:solo:000001", credentialId: "credential-solo", metadata: { name: "SOLO_TOKEN", description: "", tags: [], commands: [], proxyHosts: [] }, policy: { mode: "ask", allowedDeliveries: ["inject"], projectIds: [], highRisk: false }, envelope: soloEncrypted.envelope, wraps: [wrap()], acl: [{ subjectType: "member", subjectId: "owner", verb: "manage" }], freshUserVerification: true, localVaultUnlocked: true, now: NOW + 2 })).rejects.toThrow("content_is_host_owned");
    });
  });

  it("VAULT-INT-002 consumes exact one-use grants and treats expiry as exclusive", async () => {
    const seeded = await seed("vault-grants");
    const made = await createCredential(seeded, "GRANT");
    const request = { actor: seeded.owner, credentialId: made.credentialId, device: { id: "device-a", active: true, ownedByMember: true, signatureVerified: true, nonceFresh: true }, origin: { channelId: seeded.channelId, messageId: seeded.messageId }, projectId: "project-a", delivery: "inject" as const, now: NOW + 5 };
    await expect(seeded.stub.authorizeVaultUse(request)).resolves.toEqual({ decision: { kind: "needs_approval" } });
    await seeded.stub.issueVaultGrant({ actor: seeded.owner, credentialId: made.credentialId, memberId: "owner", deviceId: "device-a", projectId: "project-a", delivery: "inject", originChannelId: seeded.channelId, originMessageId: seeded.messageId, approvalVerified: true, freshUserVerification: true, now: NOW + 4 });
    await expect(seeded.stub.authorizeVaultUse(request)).resolves.toEqual({ decision: { kind: "allow", via: "grant" } });
    await expect(seeded.stub.authorizeVaultUse({ ...request, now: NOW + 6 })).resolves.toEqual({ decision: { kind: "needs_approval" } });
    await seeded.stub.issueVaultGrant({ actor: seeded.owner, credentialId: made.credentialId, memberId: "owner", deviceId: "device-a", projectId: "project-a", delivery: "inject", originChannelId: seeded.channelId, originMessageId: seeded.messageId, expiresAt: NOW + 10, approvalVerified: true, freshUserVerification: true, now: NOW + 7 });
    await expect(seeded.stub.authorizeVaultUse({ ...request, now: NOW + 10 })).resolves.toEqual({ decision: { kind: "needs_approval" } });
  });

  it("VAULT-INT-003 enforces mandatory project, origin, device and sliding-rate refusals", async () => {
    const seeded = await seed("vault-policy");
    const made = await createCredential(seeded, "POLICY", { mode: "auto", maxUsesPerHour: 1 });
    const request = { actor: seeded.owner, credentialId: made.credentialId, device: { id: "device-a", active: true, ownedByMember: true, signatureVerified: true, nonceFresh: true }, origin: { channelId: seeded.channelId, messageId: seeded.messageId }, projectId: "project-a", delivery: "inject" as const, now: NOW + 5 };
    await expect(seeded.stub.authorizeVaultUse({ ...request, projectId: "project-b" })).resolves.toMatchObject({ decision: { kind: "deny", reason: "project_refused" } });
    await expect(seeded.stub.authorizeVaultUse({ ...request, device: { ...request.device, signatureVerified: false } })).resolves.toMatchObject({ decision: { kind: "deny", reason: "request_unverified" } });
    await expect(seeded.stub.authorizeVaultUse({ ...request, origin: { ...request.origin, messageId: "missing" } })).resolves.toMatchObject({ decision: { kind: "deny", reason: "origin_unverified" } });
    await expect(seeded.stub.authorizeVaultUse(request)).resolves.toEqual({ decision: { kind: "allow", via: "automatic" } });
    await expect(seeded.stub.authorizeVaultUse({ ...request, now: NOW + 6 })).resolves.toMatchObject({ decision: { kind: "deny", reason: "rate_limited" } });
  });

  it("VAULT-INT-004 revokes grants on credential change and never restores them after the kill switch", async () => {
    const seeded = await seed("vault-revocation");
    const made = await createCredential(seeded, "REVOKE");
    await seeded.stub.issueVaultGrant({ actor: seeded.owner, credentialId: made.credentialId, memberId: "owner", deviceId: "device-a", projectId: "project-a", delivery: "inject", originChannelId: seeded.channelId, originMessageId: seeded.messageId, expiresAt: NOW + 50_000, approvalVerified: true, freshUserVerification: true, now: NOW + 3 });
    await seeded.stub.setVaultAgentAccess({ actor: seeded.owner, enabled: false, freshUserVerification: false, now: NOW + 4 });
    await seeded.stub.setVaultAgentAccess({ actor: seeded.owner, enabled: true, freshUserVerification: true, now: NOW + 5 });
    const request = { actor: seeded.owner, credentialId: made.credentialId, device: { id: "device-a", active: true, ownedByMember: true, signatureVerified: true, nonceFresh: true }, origin: { channelId: seeded.channelId, messageId: seeded.messageId }, projectId: "project-a", delivery: "inject" as const, agentId: "missing-agent", delegationId: "missing-delegation", now: NOW + 6 };
    await expect(seeded.stub.authorizeVaultUse(request)).resolves.toMatchObject({ decision: { kind: "deny", reason: "delegation_refused" } });
    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ revoked_at: number | null }>("SELECT revoked_at FROM vault_grants").one().revoked_at).toBe(NOW + 4);
    });
  });

  it("VAULT-INT-005 rotates ciphertext and wraps atomically, requires step-up, and tombstones deletion", async () => {
    const seeded = await seed("vault-rotate");
    const made = await createCredential(seeded, "ROTATE");
    const rotated = await encryptVaultValue({ workspaceId: seeded.stub.id.toString(), credentialId: made.credentialId, version: 2, keyEpoch: 2, plaintext: encoder.encode("rotated-canary") });
    const update = {
      actor: seeded.owner, credentialId: made.credentialId,
      metadata: { name: "TOKEN_ROTATE", description: "Rotated", tags: ["test"], commands: [], proxyHosts: [] },
      policy: { mode: "ask" as const, allowedDeliveries: ["inject" as const], projectIds: ["project-a"], grantTtlMs: 60_000, highRisk: true },
      envelope: rotated.envelope, wraps: [{ ...wrap(), recipientKeyEpoch: 2 }],
      acl: [{ subjectType: "member" as const, subjectId: "owner", verb: "manage" as const }, { subjectType: "member" as const, subjectId: "owner", verb: "use" as const }],
      freshUserVerification: true, localVaultUnlocked: true, now: NOW + 4,
    };
    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      await expect(instance.updateVaultCredential({ ...update, freshUserVerification: false })).rejects.toThrow("fresh user verification");
    });
    await expect(seeded.stub.updateVaultCredential(update)).resolves.toMatchObject({ credential: { version: 2, keyEpoch: 2, policyEpoch: 2 } });
    const stored = await seeded.stub.getVaultCredentialCiphertext({ actor: seeded.owner, credentialId: made.credentialId, freshUserVerification: true, localVaultUnlocked: true });
    expect(decoder.decode(await decryptVaultValue({ workspaceId: seeded.stub.id.toString(), credentialId: made.credentialId, envelope: stored.envelope, dek: rotated.dek }))).toBe("rotated-canary");
    await expect(seeded.stub.deleteVaultCredential({ actor: seeded.owner, credentialId: made.credentialId, freshUserVerification: true, localVaultUnlocked: true, now: NOW + 5 })).resolves.toEqual({ deleted: true });
    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ deletion_epoch: number }>("SELECT deletion_epoch FROM vault_credential_deletions WHERE credential_id = ?", made.credentialId).one().deletion_epoch).toBe(3);
      expect(state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM vault_credentials WHERE id = ?", made.credentialId).one().count).toBe(0);
    });
  });

  it("VAULT-INT-006 revokes live grants on device and membership authority changes", async () => {
    const seeded = await seed("vault-authority-revoke");
    const made = await createCredential(seeded, "AUTHORITY");
    const issue = (deviceId: string, now: number) => seeded.stub.issueVaultGrant({ actor: seeded.owner, credentialId: made.credentialId, memberId: "owner", deviceId, projectId: "project-a", delivery: "inject", originChannelId: seeded.channelId, originMessageId: seeded.messageId, expiresAt: now + 10_000, approvalVerified: true, freshUserVerification: true, now });
    await issue("device-a", NOW + 3);
    await expect(seeded.stub.revokeVaultGrantsForDevice({ deviceId: "device-a", now: NOW + 4 })).resolves.toEqual({ revoked: 1 });
    await issue("device-b", NOW + 5);
    await seeded.stub.applyMembership({ operationId: "vault-authority-revoke:owner:v2", memberId: "owner", accountId: "vault-authority-revoke:owner", handle: "owner", displayName: "owner", role: "owner", status: "active", authorizationEpoch: 2, version: 2, now: NOW + 6 });
    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      const reasons = state.storage.sql.exec<{ revoked_reason: string | null }>("SELECT revoked_reason FROM vault_grants ORDER BY created_at").toArray().map((row) => row.revoked_reason);
      expect(reasons).toEqual(["device_revoked", "member_authority_changed"]);
    });
  });

  it("VAULT-INT-007 registers one custodian wrapping key per member and refuses to replace it", async () => {
    const seeded = await seed("vault-member-keys");
    const owner = await custodianKey();
    const replacement = await custodianKey();

    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      await expect(
        instance.publishVaultMemberKey({ actor: seeded.owner, publicKey: owner.encoded, deviceId: "device-a", freshUserVerification: false, now: NOW + 2 }),
      ).rejects.toThrow(/fresh user verification/);
      await expect(
        instance.publishVaultMemberKey({ actor: seeded.owner, publicKey: encodeVaultBytes(new Uint8Array(65).fill(9)), deviceId: "device-a", freshUserVerification: true, now: NOW + 2 }),
      ).rejects.toThrow(/uncompressed P-256 point/);
    });

    await expect(
      seeded.stub.publishVaultMemberKey({ actor: seeded.owner, publicKey: owner.encoded, deviceId: "device-a", freshUserVerification: true, now: NOW + 3 }),
    ).resolves.toEqual({ memberId: "owner", keyEpoch: 1, published: true });
    // The same client re-enrolling is idempotent; a different key is not, because
    // replacing it would strand every credential already wrapped to the first.
    await expect(
      seeded.stub.publishVaultMemberKey({ actor: seeded.owner, publicKey: owner.encoded, deviceId: "device-b", freshUserVerification: true, now: NOW + 4 }),
    ).resolves.toEqual({ memberId: "owner", keyEpoch: 1, published: true });
    await expect(
      seeded.stub.publishVaultMemberKey({ actor: seeded.owner, publicKey: replacement.encoded, deviceId: "device-b", freshUserVerification: true, now: NOW + 5 }),
    ).resolves.toEqual({ memberId: "owner", keyEpoch: 1, published: false });

    // Only public halves are ever stored, and only for members who enrolled.
    const keys = await seeded.stub.getVaultMemberKeys({ actor: seeded.member, memberIds: ["owner", "member"] });
    expect(keys.keys).toEqual([{ memberId: "owner", keyEpoch: 1, wrapSuite: VAULT_WRAP_SUITE, publicKey: owner.encoded }]);
    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      const stored = state.storage.sql.exec<{ public_key: string }>("SELECT public_key FROM vault_member_keys").toArray();
      expect(stored).toEqual([{ public_key: owner.encoded }]);
    });
  });

  it("VAULT-INT-008 releases ciphertext only to an allowed custodian, and only they can open it", async () => {
    const seeded = await seed("vault-release");
    const custodian = await custodianKey();
    await seeded.stub.publishVaultMemberKey({ actor: seeded.owner, publicKey: custodian.encoded, deviceId: "device-a", freshUserVerification: true, now: NOW + 2 });

    const credentialId = "credential-RELEASE";
    const workspaceId = seeded.stub.id.toString();
    const encrypted = await encryptVaultValue({ workspaceId, credentialId, version: 1, keyEpoch: 1, plaintext: encoder.encode("release-plaintext-canary") });
    const sealed = await wrapVaultDek({
      workspaceId, credentialId, version: 1, custodianMemberId: "owner", recipientKeyEpoch: 1,
      recipientPublicKey: custodian.raw, dek: encrypted.dek,
    });
    await seeded.stub.createVaultCredential({
      actor: seeded.owner, idempotencyKey: "vault:create:RELEASE:000001", credentialId,
      metadata: { name: "TOKEN_RELEASE", description: "Released to a local client", envVar: "TOKEN", tags: [], commands: [], proxyHosts: [] },
      policy: { mode: "auto", allowedDeliveries: ["inject"], projectIds: ["project-a"], highRisk: false },
      envelope: encrypted.envelope, wraps: [sealed],
      acl: [
        { subjectType: "member", subjectId: "owner", verb: "manage" },
        { subjectType: "member", subjectId: "owner", verb: "use" },
        { subjectType: "member", subjectId: "member", verb: "use" },
      ],
      freshUserVerification: true, localVaultUnlocked: true, now: NOW + 3,
    });

    const request = (actor: Actor, now: number, overrides: Partial<Parameters<typeof seeded.stub.releaseVaultCredential>[0]> = {}) =>
      seeded.stub.releaseVaultCredential({
        actor, credentialId,
        device: { id: "device-a", active: true, ownedByMember: true, signatureVerified: true, nonceFresh: true },
        origin: { channelId: seeded.channelId, messageId: seeded.messageId },
        projectId: "project-a", delivery: "inject", now, ...overrides,
      });

    const released = await request(seeded.owner, NOW + 4);
    expect(released.decision).toEqual({ kind: "allow", via: "automatic" });
    const dek = await unwrapVaultDek({
      workspaceId, credentialId, version: released.envelope!.version,
      wrap: released.wrap!, recipientPrivateKey: custodian.privateKey,
    });
    expect(decoder.decode(await decryptVaultValue({ workspaceId, credentialId, envelope: released.envelope!, dek }))).toBe("release-plaintext-canary");

    // A use-authorized member who is not a custodian gets no ciphertext at all,
    // rather than somebody else's sealed key to fail on.
    const other = await request(seeded.member, NOW + 5);
    expect(other.decision).toEqual({ kind: "deny", reason: "no_custodian_wrap" });
    expect(other).not.toHaveProperty("envelope");
    expect(other).not.toHaveProperty("wrap");

    // Every mandatory refusal still returns a decision and nothing else.
    for (const overrides of [
      { projectId: "project-b" },
      { device: { id: "device-a", active: true, ownedByMember: true, signatureVerified: false, nonceFresh: true } },
      { origin: { channelId: seeded.channelId, messageId: "not-a-message" } },
      { delivery: "file" as const },
    ]) {
      const refused = await request(seeded.owner, NOW + 6, overrides);
      expect(refused.decision.kind).toBe("deny");
      expect(refused).not.toHaveProperty("envelope");
      expect(refused.hint).toBeTypeOf("string");
    }

    // One release, one usage event: a refusal never counts as a use.
    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      const usage = state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM vault_usage_events").one();
      expect(usage.count).toBe(1);
    });
  });

  /* -- conversational approvals and the kill switch (V03) ---------------- */

  it("VAULT-INT-009 turns an ask into a card in every owner's vault DM and nothing else", async () => {
    const seeded = await seed("vault-approval-card");
    const ask = await createCredential(seeded, "ASK", { plaintext: "approval-plaintext-canary" });
    const auto = await createCredential(seeded, "AUTO", { mode: "auto" });

    const requested = await seeded.stub.requestVaultApproval({
      actor: seeded.owner,
      credentialIds: [ask.credentialId, auto.credentialId],
      device: { id: "device-a", active: true, ownedByMember: true, signatureVerified: true, nonceFresh: true },
      origin: { channelId: seeded.channelId, messageId: seeded.messageId },
      projectId: "project-a", delivery: "inject", reason: "deploy the staging migration", now: NOW + 10,
    });

    // Only what the policy leaves to a human becomes a card; an automatic
    // allow is answered on the spot rather than waking somebody up.
    expect(requested.approvals).toHaveLength(1);
    expect(requested.approvals[0].credentialIds).toEqual([ask.credentialId]);
    expect(requested.approvals[0].expiresAt).toBe(NOW + 10 + VAULT_APPROVAL_TTL_MS);
    expect(requested.decisions).toEqual([
      { credentialId: auto.credentialId, decision: { kind: "allow", via: "automatic" } },
    ]);
    expect(requested.approvals[0].hint).toContain("do not retry in a loop");

    // The card is a real message from a real identity in a real conversation.
    const listed = await seeded.stub.listVaultApprovals({ actor: seeded.owner, now: NOW + 11 });
    expect(listed.approvals).toHaveLength(1);
    expect(listed.approvals[0]).toMatchObject({
      status: "pending", requesterHandle: "owner", reason: "deploy the staging migration", viewerMayDecide: true,
    });
    expect(listed.approvals[0].items[0]).toMatchObject({ name: "TOKEN_ASK", windows: ["once"] });

    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      const card = state.storage.sql.exec<{ body_markdown: string; author_kind: string; author_display_snapshot: string; kind: string }>(
        `SELECT m.body_markdown, m.author_kind, m.author_display_snapshot, c.kind
         FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.dm_key = ?`,
        "vault-dm:owner",
      ).one();
      expect(card.author_kind).toBe("agent");
      expect(card.author_display_snapshot).toBe("a.vault");
      expect(card.kind).toBe("dm");
      expect(card.body_markdown).toContain("deploy the staging migration");
      expect(card.body_markdown).toContain("TOKEN_ASK");
      expect(card.body_markdown).toContain("@owner");
      expect(card.body_markdown).toContain("No answer is a denial");
      // A card carries the question, never the answer's material.
      expect(card.body_markdown).not.toContain("approval-plaintext-canary");
      expect(card.body_markdown).not.toContain(ask.encrypted.envelope.ciphertext);

      // Somebody who does not own the credential is not shown the card at all.
      expect(
        state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM channels WHERE dm_key = ?", "vault-dm:member").one().count,
      ).toBe(0);
      const stored = state.storage.sql.exec<{ reason: string; status: string }>("SELECT reason, status FROM vault_approvals").one();
      expect(stored).toEqual({ reason: "deploy the staging migration", status: "pending" });
    });

    // The requester's push carries the facts a phone needs, and no value.
    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      const queued = state.storage.sql.exec<{ kind: string; payload_json: string }>(
        "SELECT kind, payload_json FROM pending_events WHERE kind = 'vault_approval_requested'",
      ).toArray();
      expect(queued).toHaveLength(1);
      expect(JSON.parse(queued[0].payload_json)).toMatchObject({ urgent: true, credentialNames: ["TOKEN_ASK"] });
      expect(queued[0].payload_json).not.toContain("approval-plaintext-canary");
    });
  });

  it("VAULT-INT-010 lets the first answer win, binds the gesture, and issues exactly one grant", async () => {
    const seeded = await seed("vault-approval-race");
    const made = await sharedCredential(seeded, "RACE");
    const requested = await requestApproval(seeded, [made.credentialId], NOW + 10);
    const approvalId = requested.approvals[0].approvalId;
    const decisions = [{ credentialId: made.credentialId, outcome: "allowed" as const, window: "once" as const }];
    const digest = canonicalApprovalDigest({
      approvalId,
      items: [{ credentialId: made.credentialId, name: "TOKEN_RACE", version: 1, policyEpoch: 1 }],
      decisions,
    });

    // Allowing without a verified gesture, or with one bound to a different
    // decision, is refused before anything is written.
    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      await expect(
        instance.decideVaultApproval({ actor: seeded.owner, approvalId, decisions, now: NOW + 11 }),
      ).rejects.toThrow(/verified approval gesture/);
      await expect(
        instance.decideVaultApproval({ actor: seeded.owner, approvalId, decisions, stepUp: { verified: true, digest: "another-digest" }, now: NOW + 11 }),
      ).rejects.toThrow(/authorises a different decision/);
      // Somebody who is not an eligible approver is told it does not exist
      // rather than that it is none of their business.
      await expect(
        instance.decideVaultApproval({ actor: seeded.outsider, approvalId, decisions, stepUp: { verified: true, digest }, now: NOW + 11 }),
      ).rejects.toThrow(/does not exist/);
    });

    const first = await seeded.stub.decideVaultApproval({
      actor: seeded.owner, approvalId, decisions, stepUp: { verified: true, digest }, now: NOW + 12,
    });
    expect(first).toMatchObject({ status: "allowed", accepted: true, decidedByMemberId: "owner" });
    expect(first.decisions[0].grantId).toEqual(expect.any(String));

    // The second owner's answer is refused and told what happened, rather than
    // silently overwriting the first or issuing a second grant.
    const second = await seeded.stub.decideVaultApproval({
      actor: seeded.member, approvalId,
      decisions: [{ credentialId: made.credentialId, outcome: "denied", window: "once" }],
      now: NOW + 13,
    });
    expect(second).toMatchObject({ status: "allowed", accepted: false, reason: "that request was already allowed", decidedByMemberId: "owner" });

    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM vault_grants").one().count).toBe(1);
      const grant = state.storage.sql.exec<{ remaining_uses: number | null; expires_at: number | null; approved_by_member_id: string }>(
        "SELECT remaining_uses, expires_at, approved_by_member_id FROM vault_grants",
      ).one();
      // "Allow once" is a grant with no expiry, which the grant rules spend on
      // one use.
      expect(grant).toEqual({ remaining_uses: 1, expires_at: null, approved_by_member_id: "owner" });
      // Both owners' copies of the card carry the answer, so neither is left
      // looking at an open request.
      const answers = state.storage.sql.exec<{ body_markdown: string }>(
        "SELECT body_markdown FROM messages WHERE body_markdown LIKE '%Answered by%'",
      ).toArray();
      expect(answers).toHaveLength(2);
      expect(answers[0].body_markdown).toContain("Answered by @owner");
      expect(answers[0].body_markdown).toContain("**TOKEN_RACE** — allowed once");
    });

    // And the grant the approval issued is the one the release path honours.
    const released = await seeded.stub.releaseVaultCredential({
      actor: seeded.owner, credentialId: made.credentialId,
      device: { id: "device-a", active: true, ownedByMember: true, signatureVerified: true, nonceFresh: true },
      origin: { channelId: seeded.channelId, messageId: seeded.messageId },
      projectId: "project-a", delivery: "inject", now: NOW + 14,
    });
    expect(released.decision).toEqual({ kind: "allow", via: "grant" });
  });

  it("VAULT-INT-011 denies by timing out at five minutes and tells the agent to stop", async () => {
    const seeded = await seed("vault-approval-expiry");
    const made = await createCredential(seeded, "EXPIRE");
    const requested = await requestApproval(seeded, [made.credentialId], NOW + 10);
    const approvalId = requested.approvals[0].approvalId;
    const expiresAt = requested.approvals[0].expiresAt;

    // A second before the deadline the card is still answerable.
    await expect(seeded.stub.expireVaultApprovals(expiresAt - 1)).resolves.toEqual({ expired: 0 });
    expect((await seeded.stub.listVaultApprovals({ actor: seeded.owner, now: expiresAt - 1 })).approvals).toHaveLength(1);

    await expect(seeded.stub.expireVaultApprovals(expiresAt)).resolves.toEqual({ expired: 1 });
    // Sweeping again is a no-op rather than a second denial.
    await expect(seeded.stub.expireVaultApprovals(expiresAt + 1)).resolves.toEqual({ expired: 0 });
    expect((await seeded.stub.listVaultApprovals({ actor: seeded.owner, now: expiresAt + 1 })).approvals).toEqual([]);

    // Answering afterwards cannot resurrect it.
    const late = await seeded.stub.decideVaultApproval({
      actor: seeded.owner, approvalId,
      decisions: [{ credentialId: made.credentialId, outcome: "denied", window: "once" }],
      now: expiresAt + 2,
    });
    expect(late).toMatchObject({ status: "expired", accepted: false });

    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ status: string }>("SELECT status FROM vault_approvals").one().status).toBe("expired");
      // A timeout is a denial in the row as well as in the wording.
      expect(state.storage.sql.exec<{ outcome: string }>("SELECT outcome FROM vault_approval_items").one().outcome).toBe("denied");
      expect(state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM vault_grants").one().count).toBe(0);
      const timedOut = state.storage.sql.exec<{ body_markdown: string }>(
        "SELECT body_markdown FROM messages WHERE body_markdown LIKE '%Timed out%'",
      ).one();
      expect(timedOut.body_markdown).toContain("TOKEN_EXPIRE");
      const queued = state.storage.sql.exec<{ payload_json: string }>(
        "SELECT payload_json FROM pending_events WHERE kind = 'vault_approval_expired'",
      ).one();
      expect(JSON.parse(queued.payload_json).hint).toContain("counts as a denial");
    });
  });

  it("VAULT-INT-012 coalesces one command into one card, and never across owners", async () => {
    const seeded = await seed("vault-approval-batch");
    const mine = await createCredential(seeded, "BATCH_A");
    const alsoMine = await createCredential(seeded, "BATCH_B");
    const shared = await sharedCredential(seeded, "BATCH_C");

    const requested = await requestApproval(
      seeded, [mine.credentialId, alsoMine.credentialId, shared.credentialId], NOW + 10,
    );

    // Two credentials only the owner manages are one question; the one a second
    // person also owns is a different question with a different answerer.
    expect(requested.approvals).toHaveLength(2);
    const solo = requested.approvals.find((approval) => approval.approverMemberIds.length === 1)!;
    const both = requested.approvals.find((approval) => approval.approverMemberIds.length === 2)!;
    expect([...solo.credentialIds].sort()).toEqual([mine.credentialId, alsoMine.credentialId].sort());
    expect(both.credentialIds).toEqual([shared.credentialId]);
    expect(both.approverMemberIds).toEqual(["member", "owner"]);

    // The owner sees both cards; the second person sees only the one they can
    // actually answer.
    expect((await seeded.stub.listVaultApprovals({ actor: seeded.owner, now: NOW + 11 })).approvals).toHaveLength(2);
    const theirs = (await seeded.stub.listVaultApprovals({ actor: seeded.member, now: NOW + 11 })).approvals;
    expect(theirs).toHaveLength(1);
    expect(theirs[0].approvalId).toBe(both.approvalId);

    // One card, one message, listing everything it is asking for.
    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      const card = state.storage.sql.exec<{ body_markdown: string }>(
        `SELECT m.body_markdown FROM messages m JOIN channels c ON c.id = m.channel_id
         WHERE c.dm_key = 'vault-dm:owner' AND m.body_markdown LIKE '%TOKEN_BATCH_A%'`,
      ).one();
      expect(card.body_markdown).toContain("TOKEN_BATCH_B");
      expect(card.body_markdown).not.toContain("TOKEN_BATCH_C");
    });

    // Mixed per-item answers are atomic: one is allowed, the other denied, and
    // exactly one grant exists.
    const items = [
      { credentialId: mine.credentialId, outcome: "allowed" as const, window: "once" as const },
      { credentialId: alsoMine.credentialId, outcome: "denied" as const, window: "once" as const },
    ];
    const digest = canonicalApprovalDigest({
      approvalId: solo.approvalId,
      items: [
        { credentialId: mine.credentialId, name: "TOKEN_BATCH_A", version: 1, policyEpoch: 1 },
        { credentialId: alsoMine.credentialId, name: "TOKEN_BATCH_B", version: 1, policyEpoch: 1 },
      ],
      decisions: items,
    });
    const answered = await seeded.stub.decideVaultApproval({
      actor: seeded.owner, approvalId: solo.approvalId, decisions: items, stepUp: { verified: true, digest }, now: NOW + 12,
    });
    expect(answered.accepted).toBe(true);
    expect(answered.decisions.filter((decision) => decision.grantId !== undefined)).toHaveLength(1);
    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM vault_grants").one().count).toBe(1);
    });
  });

  it("VAULT-INT-013 gives each kill-switch scope an immediate, announced, non-restoring effect", async () => {
    const seeded = await seed("vault-kill-switch");
    const made = await createCredential(seeded, "SWITCH");
    // The live grant belongs to another device, so the request from this one
    // still has to ask: the scenario needs both a grant to revoke and a card to
    // end.
    await seeded.stub.issueVaultGrant({
      actor: seeded.owner, credentialId: made.credentialId, memberId: "owner", deviceId: "device-b",
      projectId: "project-a", delivery: "inject", originChannelId: seeded.channelId, originMessageId: seeded.messageId,
      approvalVerified: true, freshUserVerification: true, now: NOW + 10,
    });
    const requested = await requestApproval(seeded, [made.credentialId], NOW + 11);
    expect(requested.approvals).toHaveLength(1);

    // Switching one credential off takes no step-up, revokes what is live and
    // ends what is pending.
    const off = await seeded.stub.setVaultCredentialFreeze({
      actor: seeded.owner, credentialId: made.credentialId, frozen: true, now: NOW + 12,
    });
    expect(off).toEqual({ frozen: true, revokedGrants: 1, expiredApprovals: 1 });
    expect((await seeded.stub.listVaultApprovals({ actor: seeded.owner, now: NOW + 13 })).approvals).toEqual([]);

    // It outranks every policy, including a request that would otherwise be
    // allowed automatically.
    const refused = await seeded.stub.releaseVaultCredential({
      actor: seeded.owner, credentialId: made.credentialId,
      device: { id: "device-a", active: true, ownedByMember: true, signatureVerified: true, nonceFresh: true },
      origin: { channelId: seeded.channelId, messageId: seeded.messageId },
      projectId: "project-a", delivery: "inject", now: NOW + 14,
    });
    expect(refused.decision).toEqual({ kind: "deny", reason: "credential_frozen" });
    expect(refused).not.toHaveProperty("envelope");

    // Turning it back on does not bring the revoked grant back.
    await expect(
      seeded.stub.setVaultCredentialFreeze({ actor: seeded.owner, credentialId: made.credentialId, frozen: false, now: NOW + 15 }),
    ).resolves.toEqual({ frozen: false, revokedGrants: 0, expiredApprovals: 0 });
    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ revoked_reason: string }>("SELECT revoked_reason FROM vault_grants").one().revoked_reason)
        .toBe("credential_switched_off");
      // Both flips were announced to everyone who could be surprised by them.
      const announcements = state.storage.sql.exec<{ body_markdown: string }>(
        "SELECT body_markdown FROM messages WHERE body_markdown LIKE '%switched%' ORDER BY created_at",
      ).toArray();
      expect(announcements[0].body_markdown).toContain("The credential TOKEN_SWITCH was switched off by @owner");
      expect(announcements[0].body_markdown).toContain("1 active grant was revoked");
      expect(announcements.at(-1)!.body_markdown).toContain("were not restored");
    });

    // The per-agent scope cuts an agent off without silencing it.
    const agent = await seeded.stub.createAgent({ actor: seeded.owner, idempotencyKey: "vault:switch:agent:0001", handle: "switchbot", now: NOW + 16 });
    const agentOff = await seeded.stub.setAgentVaultAccess({ actor: seeded.owner, agentId: agent.agentId, enabled: false, now: NOW + 17 });
    expect(agentOff).toMatchObject({ enabled: false });
    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      const row = state.storage.sql.exec<{ status: string; vault_access_off_at: number | null }>(
        "SELECT status, vault_access_off_at FROM agents WHERE id = ?", agent.agentId,
      ).one();
      // Still active: it may keep working, it may not touch credentials.
      expect(row.status).toBe("active");
      expect(row.vault_access_off_at).toBe(NOW + 17);
      expect(
        state.storage.sql.exec<{ body_markdown: string }>(
          "SELECT body_markdown FROM messages WHERE body_markdown LIKE '%@a.switchbot%' ORDER BY created_at DESC",
        ).toArray()[0].body_markdown,
      ).toContain("was switched off by @owner");
    });

    // The workspace scope ends every pending card at once.
    const stillPending = await requestApproval(seeded, [made.credentialId], NOW + 18);
    expect(stillPending.approvals).toHaveLength(1);
    await seeded.stub.setVaultAgentAccess({ actor: seeded.owner, enabled: false, freshUserVerification: false, now: NOW + 19 });
    expect((await seeded.stub.listVaultApprovals({ actor: seeded.owner, now: NOW + 20 })).approvals).toEqual([]);
  });

  it("VAULT-INT-014 refuses to honour a card after the credential it described changed", async () => {
    const seeded = await seed("vault-approval-stale");
    const made = await createCredential(seeded, "STALE");
    const requested = await requestApproval(seeded, [made.credentialId], NOW + 10);
    const approvalId = requested.approvals[0].approvalId;
    const decisions = [{ credentialId: made.credentialId, outcome: "allowed" as const, window: "once" as const }];
    const digest = canonicalApprovalDigest({
      approvalId, items: [{ credentialId: made.credentialId, name: "TOKEN_STALE", version: 1, policyEpoch: 1 }], decisions,
    });

    // Rotating the value moves the credential past the version the approver read.
    const rotated = await encryptVaultValue({
      workspaceId: seeded.stub.id.toString(), credentialId: made.credentialId, version: 2, keyEpoch: 2,
      plaintext: encoder.encode("rotated-canary"),
    });
    await seeded.stub.updateVaultCredential({
      actor: seeded.owner, credentialId: made.credentialId,
      metadata: { name: "TOKEN_STALE", description: "Test token", envVar: "TOKEN", tags: ["test"], commands: ["tool"], proxyHosts: ["api.example.test"] },
      policy: { mode: "ask", allowedDeliveries: ["inject"], projectIds: ["project-a"], grantTtlMs: 60_000, highRisk: true },
      envelope: rotated.envelope, wraps: [wrap()],
      acl: [
        { subjectType: "member", subjectId: "owner", verb: "manage" },
        { subjectType: "member", subjectId: "owner", verb: "use" },
      ],
      freshUserVerification: true, localVaultUnlocked: true, now: NOW + 11,
    });

    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      await expect(
        instance.decideVaultApproval({ actor: seeded.owner, approvalId, decisions, stepUp: { verified: true, digest }, now: NOW + 12 }),
      ).rejects.toThrow(/changed after the request was made/);
    });
    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      // Nothing was written: no grant, and the card is still open for a fresh
      // request to replace.
      expect(state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM vault_grants").one().count).toBe(0);
      expect(state.storage.sql.exec<{ status: string }>("SELECT status FROM vault_approvals").one().status).toBe("pending");
    });
  });

  /* -- the vault and agent activity surfaces (V04) ----------------------- */

  it("VAULT-INT-015 lists live grants with all three parties, and never a credential the reader cannot see", async () => {
    const seeded = await seed("vault-grant-list");
    const mine = await createCredential(seeded, "MINE", { aclMember: true });
    const theirs = await createCredential(seeded, "THEIRS");
    for (const credentialId of [mine.credentialId, theirs.credentialId]) {
      await seeded.stub.issueVaultGrant({
        actor: seeded.owner, credentialId, memberId: "owner", deviceId: "device-a", projectId: "project-a",
        delivery: "inject", originChannelId: seeded.channelId, originMessageId: seeded.messageId,
        expiresAt: NOW + 50_000, approvalVerified: true, freshUserVerification: true, now: NOW + 3,
      });
    }

    const owner = await seeded.stub.listVaultGrants({ actor: seeded.owner, now: NOW + 4 });
    expect(owner.grants).toHaveLength(2);
    expect(owner.grants[0]).toMatchObject({
      memberHandle: "owner", approverHandle: "owner", agentHandle: null,
      deviceId: "device-a", projectId: "project-a", delivery: "inject", singleUse: false, viewerMayRevoke: true,
    });

    // A member who can only see one credential sees only its grant, and cannot
    // revoke it: seeing a grant is not holding authority over it.
    const member = await seeded.stub.listVaultGrants({ actor: seeded.member, now: NOW + 4 });
    expect(member.grants.map((grant) => grant.credentialName)).toEqual(["TOKEN_MINE"]);
    expect(member.grants[0].viewerMayRevoke).toBe(false);
    expect((await seeded.stub.listVaultGrants({ actor: seeded.outsider, now: NOW + 4 })).grants).toEqual([]);

    // Revoking is refused for the member who may not, reported as missing, and
    // the grant survives.
    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      await expect(
        instance.revokeVaultGrant({ actor: seeded.member, grantId: member.grants[0].grantId, now: NOW + 5 }),
      ).rejects.toThrow(/not found/);
      await expect(
        instance.revokeVaultGrant({ actor: seeded.outsider, grantId: member.grants[0].grantId, now: NOW + 5 }),
      ).rejects.toThrow(/not found/);
    });
    expect((await seeded.stub.listVaultGrants({ actor: seeded.member, now: NOW + 6 })).grants).toHaveLength(1);

    // The manager may, once, and the row disappears from the live list.
    await expect(
      seeded.stub.revokeVaultGrant({ actor: seeded.owner, grantId: member.grants[0].grantId, now: NOW + 7 }),
    ).resolves.toEqual({ revoked: true });
    await expect(
      seeded.stub.revokeVaultGrant({ actor: seeded.owner, grantId: member.grants[0].grantId, now: NOW + 8 }),
    ).resolves.toEqual({ revoked: false });
    expect((await seeded.stub.listVaultGrants({ actor: seeded.member, now: NOW + 9 })).grants).toEqual([]);
    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      expect(
        state.storage.sql.exec<{ revoked_reason: string }>(
          "SELECT revoked_reason FROM vault_grants WHERE id = ?", member.grants[0].grantId,
        ).one().revoked_reason,
      ).toBe("revoked_by_member");
    });
  });

  it("VAULT-INT-016 describes a credential as metadata and rights, never as a value", async () => {
    const seeded = await seed("vault-describe");
    const made = await createCredential(seeded, "DESCRIBE", { aclMember: true, plaintext: "describe-plaintext-canary" });

    const detail = await seeded.stub.describeVaultCredential({
      actor: seeded.owner, credentialId: made.credentialId, now: NOW + 3,
    });
    expect(detail.credential).toMatchObject({ name: "TOKEN_DESCRIBE", version: 1 });
    expect(detail.createdByHandle).toBe("owner");
    expect(detail.frozen).toBe(false);
    expect(detail.manage.map((subject) => subject.label)).toEqual(["@owner"]);
    expect(detail.use.map((subject) => subject.label).sort()).toEqual(["@member", "@owner"]);
    expect(detail.viewer).toEqual({ mayUse: true, mayReveal: false, mayManage: true });
    // There is no field for any of these, so nothing downstream can serialise one.
    const serialised = JSON.stringify(detail);
    expect(serialised).not.toContain("describe-plaintext-canary");
    expect(serialised).not.toContain(made.encrypted.envelope.ciphertext);
    expect(serialised).not.toContain("wrappedDek");

    // A member with use but not manage sees the same facts and different rights.
    const asMember = await seeded.stub.describeVaultCredential({
      actor: seeded.member, credentialId: made.credentialId, now: NOW + 3,
    });
    expect(asMember.viewer).toEqual({ mayUse: true, mayReveal: false, mayManage: false });

    // Somebody with no rights is told it does not exist rather than that it is
    // forbidden, so the page cannot be used to enumerate credentials.
    // Synchronous reads, so they throw rather than returning a rejected promise.
    await runInDurableObject<Workspace, void>(seeded.stub, (instance) => {
      expect(() =>
        instance.describeVaultCredential({ actor: seeded.outsider, credentialId: made.credentialId, now: NOW + 3 }),
      ).toThrow(/not found/);
      expect(() =>
        instance.describeVaultCredential({ actor: seeded.owner, credentialId: "credential-nope", now: NOW + 3 }),
      ).toThrow(/not found/);
    });
  });

  it("VAULT-INT-017 keeps requester, operating owner and approver apart in the activity log", async () => {
    const seeded = await seed("vault-activity");
    const made = await sharedCredential(seeded, "ACTIVITY");
    const requested = await requestApproval(seeded, [made.credentialId], NOW + 10);
    const approvalId = requested.approvals[0].approvalId;
    const decisions = [{ credentialId: made.credentialId, outcome: "allowed" as const, window: "once" as const }];
    // The second owner answers, so the approver is demonstrably not the person
    // who asked.
    await seeded.stub.decideVaultApproval({
      actor: seeded.member, approvalId, decisions, now: NOW + 11,
      stepUp: {
        verified: true,
        digest: canonicalApprovalDigest({
          approvalId,
          items: [{ credentialId: made.credentialId, name: "TOKEN_ACTIVITY", version: 1, policyEpoch: 1 }],
          decisions,
        }),
      },
    });
    await seeded.stub.releaseVaultCredential({
      actor: seeded.owner, credentialId: made.credentialId,
      device: { id: "device-a", active: true, ownedByMember: true, signatureVerified: true, nonceFresh: true },
      origin: { channelId: seeded.channelId, messageId: seeded.messageId },
      projectId: "project-a", delivery: "inject", now: NOW + 12,
    });

    const activity = await seeded.stub.listVaultActivity({ actor: seeded.owner, credentialId: made.credentialId, now: NOW + 13 });
    const used = activity.activity.find((row) => row.kind === "used")!;
    const decided = activity.activity.find((row) => row.kind === "decided")!;
    // Asked by one owner, allowed by the other, used by the first: three fields,
    // three answers, and the log says which is which.
    expect(used).toMatchObject({ memberHandle: "owner", approverHandle: "member", detail: "under a grant" });
    expect(decided).toMatchObject({ memberHandle: "owner", approverHandle: "member", outcome: "allowed", detail: "run the deploy" });
    expect(activity.activity.every((row) => row.at <= NOW + 13)).toBe(true);
    expect(JSON.stringify(activity)).not.toContain("canary-ACTIVITY");

    // The log is filtered by what the reader may see, like everything else.
    expect((await seeded.stub.listVaultActivity({ actor: seeded.outsider, now: NOW + 13 })).activity).toEqual([]);
  });

  it("VAULT-INT-018 describes an agent with its vault switch and hides somebody else's", async () => {
    const seeded = await seed("vault-agent-detail");
    const agent = await seeded.stub.createAgent({
      actor: seeded.owner, idempotencyKey: "vault:agent:detail:0001", handle: "activitybot",
      description: "Watches deploys", now: NOW + 3,
    });

    const detail = await seeded.stub.describeAgent({ actor: seeded.owner, agentId: agent.agentId, now: NOW + 4 });
    expect(detail).toMatchObject({
      handle: "a.activitybot", status: "active", vaultAccessOff: false, isOwner: true, ownerHandles: ["owner"],
    });

    await seeded.stub.setAgentVaultAccess({ actor: seeded.owner, agentId: agent.agentId, enabled: false, now: NOW + 5 });
    const off = await seeded.stub.describeAgent({ actor: seeded.owner, agentId: agent.agentId, now: NOW + 6 });
    // Cut off from credentials, still active: the two switches are separate.
    expect(off).toMatchObject({ vaultAccessOff: true, vaultAccessOffAt: NOW + 5, status: "active" });

    // A member who does not own it still sees it — agents are public in the
    // workspace — but is not shown as an owner.
    const asMember = await seeded.stub.describeAgent({ actor: seeded.member, agentId: agent.agentId, now: NOW + 6 });
    expect(asMember.isOwner).toBe(false);
    await runInDurableObject<Workspace, void>(seeded.stub, (instance) => {
      expect(() => instance.describeAgent({ actor: seeded.owner, agentId: "agent-nope", now: NOW + 6 })).toThrow(
        /not found/,
      );
    });
  });
});
