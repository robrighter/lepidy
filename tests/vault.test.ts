import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Actor, Workspace } from "../src/cloudflare/workspace";
import { decryptVaultValue, encryptVaultValue } from "../src/domain/vault-client-crypto";
import { encodeVaultBytes, type VaultKeyWrap } from "../src/domain/vault-envelope";

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
});
