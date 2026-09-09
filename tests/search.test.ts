import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Actor, Workspace } from "../src/cloudflare/workspace";
import { encryptVaultValue } from "../src/domain/vault-client-crypto";
import { encodeVaultBytes, type VaultKeyWrap } from "../src/domain/vault-envelope";

const NOW = Date.UTC(2027, 0, 15, 12);
const MIB = 1024 * 1024;

async function seed(name: string, storageMode: "cloud" | "local_host" = "cloud") {
  const stub = env.WORKSPACE.getByName(name);
  await stub.initializeWorkspace({ storageMode, hostEpoch: 0, routingEpoch: 1, now: NOW });
  for (const [memberId, handle, displayName, role] of [
    ["owner", "maya", "Maya Chen", "owner"],
    ["member", "lee", "Lee Ortiz", "member"],
    ["outsider", "sam", "Sam Rivera", "member"],
  ] as const) {
    await stub.applyMembership({
      operationId: `${name}-${memberId}`, memberId, accountId: `${name}-${memberId}`,
      handle, displayName, role, status: "active", authorizationEpoch: 1, version: 1, now: NOW,
    });
  }
  const owner = { memberId: "owner", authorizationEpoch: 1 } satisfies Actor;
  return {
    stub,
    owner,
    member: { memberId: "member", authorizationEpoch: 1 } satisfies Actor,
    outsider: { memberId: "outsider", authorizationEpoch: 1 } satisfies Actor,
  };
}

function wrap(): VaultKeyWrap {
  return {
    custodianMemberId: "owner", recipientKeyEpoch: 1, wrapSuite: "P256-HKDF-SHA256-AES256GCM",
    ephemeralPublicKey: encodeVaultBytes(new Uint8Array(65).fill(7)),
    iv: encodeVaultBytes(new Uint8Array(12).fill(8)),
    wrappedDek: encodeVaultBytes(new Uint8Array(48).fill(9)),
  };
}

describe("workspace search", () => {
  it("C09-INT-001 searches messages and metadata while enforcing visibility inside each query", async () => {
    const seeded = await seed("c09-visible");
    await seeded.stub.applyStorageEntitlement({ quotaBytes: 10 * MIB, version: 1, now: NOW });
    const publicRoom = await seeded.stub.createChannel({
      actor: seeded.owner, idempotencyKey: "c09-public-room-001", kind: "public", slug: "launch",
      memberIds: ["member"], now: NOW,
    });
    const privateRoom = await seeded.stub.createChannel({
      actor: seeded.owner, idempotencyKey: "c09-private-room01", kind: "private", slug: "board",
      memberIds: [], now: NOW,
    });
    const publicMessage = await seeded.stub.sendMessage({
      actor: seeded.member, idempotencyKey: "c09-public-message1", channelId: publicRoom.channelId,
      bodyMarkdown: "Aurora launch notes at https://example.test and `npm test`", now: NOW + 1,
    });
    await seeded.stub.sendMessage({
      actor: seeded.owner, idempotencyKey: "c09-private-message", channelId: privateRoom.channelId,
      bodyMarkdown: "Aurora board acquisition", now: NOW + 2,
    });
    await seeded.stub.sendMessage({
      actor: seeded.member, idempotencyKey: "c09-thread-message1", channelId: publicRoom.channelId,
      threadParentId: publicMessage.messageId, bodyMarkdown: "Aurora threaded follow-up", now: NOW + 3,
    });
    const file = await seeded.stub.reserveUpload({
      actor: seeded.member, idempotencyKey: "c09-file-reserve01", channelId: publicRoom.channelId,
      fileName: "Aurora launch brief.pdf", mediaType: "application/pdf", byteLength: 128, now: NOW + 4,
    });
    await seeded.stub.confirmUpload({ actor: seeded.member, fileId: file.fileId, byteLength: 128, now: NOW + 5 });

    expect((await seeded.stub.searchWorkspace({ actor: seeded.outsider, query: "Aurora" })).hits)
      .toEqual(expect.not.arrayContaining([expect.objectContaining({ channelLabel: "board" })]));
    expect((await seeded.stub.searchWorkspace({ actor: seeded.owner, query: "Aurora" })).hits)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "message", channelLabel: "board" }),
        expect.objectContaining({ kind: "file", id: file.fileId }),
      ]));
    expect((await seeded.stub.searchWorkspace({ actor: seeded.owner, query: "from:@lee in:#launch has:code" })).hits)
      .toEqual([expect.objectContaining({ kind: "message", id: publicMessage.messageId })]);
    expect((await seeded.stub.searchWorkspace({ actor: seeded.owner, query: "in:launch has:link" })).hits)
      .toEqual([expect.objectContaining({ id: publicMessage.messageId })]);
    expect((await seeded.stub.searchWorkspace({ actor: seeded.owner, query: "is:thread" })).hits)
      .toEqual([expect.objectContaining({ threadRootId: publicMessage.messageId })]);
    expect((await seeded.stub.searchWorkspace({ actor: seeded.owner, query: "after:2027-01-15 before:2027-01-16" })).hits.length)
      .toBeGreaterThan(0);
  });

  it("C09-INT-002 indexes credential names and descriptions for allowed members, never encrypted values", async () => {
    const seeded = await seed("c09-vault");
    const credentialId = "credential-release";
    const secret = "ciphertext-canary-never-searchable";
    const encrypted = await encryptVaultValue({
      workspaceId: seeded.stub.id.toString(), credentialId, version: 1, keyEpoch: 1,
      plaintext: new TextEncoder().encode(secret),
    });
    await seeded.stub.createVaultCredential({
      actor: seeded.owner, idempotencyKey: "c09-vault-create001", credentialId,
      metadata: { name: "RELEASE_TOKEN", description: "Aurora deployment credential", tags: [], commands: [], proxyHosts: [] },
      policy: { mode: "ask", allowedDeliveries: ["inject"], projectIds: ["project-a"], highRisk: false },
      envelope: encrypted.envelope, wraps: [wrap()],
      acl: [
        { subjectType: "member", subjectId: "owner", verb: "manage" },
        { subjectType: "member", subjectId: "owner", verb: "use" },
      ],
      freshUserVerification: true, localVaultUnlocked: true, now: NOW + 1,
    });

    expect((await seeded.stub.searchWorkspace({ actor: seeded.owner, query: "deployment" })).hits)
      .toContainEqual(expect.objectContaining({ kind: "credential", id: credentialId, name: "RELEASE_TOKEN" }));
    expect((await seeded.stub.searchWorkspace({ actor: seeded.member, query: "deployment" })).hits).toEqual([]);
    expect((await seeded.stub.searchWorkspace({ actor: seeded.owner, query: secret })).hits).toEqual([]);
    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      const indexed = state.storage.sql.exec<{ name: string; description: string }>(
        "SELECT search.name, search.description FROM credential_search search JOIN vault_credentials credential ON credential.rowid = search.rowid WHERE credential.id = ?", credentialId,
      ).one();
      expect(indexed).toEqual({ name: "RELEASE_TOKEN", description: "Aurora deployment credential" });
      expect(JSON.stringify(indexed)).not.toContain(secret);
    });
  });

  it("C09-INT-003 updates and removes index entries and returns stable, non-overlapping pages", async () => {
    const seeded = await seed("c09-lifecycle");
    const room = await seeded.stub.createChannel({
      actor: seeded.owner, idempotencyKey: "c09-life-room-0001", kind: "public", slug: "ops", memberIds: [], now: NOW,
    });
    const first = await seeded.stub.sendMessage({
      actor: seeded.owner, idempotencyKey: "c09-life-message01", channelId: room.channelId,
      bodyMarkdown: "oldcanary page one", now: NOW + 1,
    });
    for (let index = 0; index < 4; index += 1) {
      await seeded.stub.sendMessage({
        actor: seeded.owner, idempotencyKey: `c09-life-message-${index + 2}`, channelId: room.channelId,
        bodyMarkdown: `pagecanary item ${index}`, now: NOW + index + 2,
      });
    }
    await seeded.stub.editMessage({ actor: seeded.owner, messageId: first.messageId, bodyMarkdown: "newcanary page one", now: NOW + 10 });
    expect((await seeded.stub.searchWorkspace({ actor: seeded.owner, query: "oldcanary" })).hits).toEqual([]);
    expect((await seeded.stub.searchWorkspace({ actor: seeded.owner, query: "newcanary" })).hits)
      .toEqual([expect.objectContaining({ id: first.messageId })]);
    const pageOne = await seeded.stub.searchWorkspace({ actor: seeded.owner, query: "pagecanary", limit: 2 });
    const pageTwo = await seeded.stub.searchWorkspace({ actor: seeded.owner, query: "pagecanary", limit: 2, cursor: pageOne.nextCursor });
    expect(pageOne.nextCursor).toBe("2");
    expect(pageTwo.hits.map(({ id }) => id)).not.toEqual(expect.arrayContaining(pageOne.hits.map(({ id }) => id)));
    await seeded.stub.deleteMessage({ actor: seeded.owner, messageId: first.messageId, now: NOW + 11 });
    expect((await seeded.stub.searchWorkspace({ actor: seeded.owner, query: "newcanary" })).hits).toEqual([]);
  });

  it("C09-INT-004 keeps saved searches private and refuses cloud search on a Solo relay", async () => {
    const seeded = await seed("c09-saved");
    const saved = await seeded.stub.saveSearch({
      actor: seeded.owner, idempotencyKey: "c09-save-query-0001", name: "Launch links",
      query: "in:#launch has:link", now: NOW + 1,
    });
    expect(saved.replayed).toBe(false);
    expect((await seeded.stub.listSavedSearches({ actor: seeded.owner })).searches).toHaveLength(1);
    expect((await seeded.stub.listSavedSearches({ actor: seeded.member })).searches).toEqual([]);
    expect(await seeded.stub.deleteSavedSearch({ actor: seeded.member, searchId: saved.search.id })).toEqual({ removed: false });
    expect(await seeded.stub.deleteSavedSearch({ actor: seeded.owner, searchId: saved.search.id })).toEqual({ removed: true });
    expect((await seeded.stub.searchWorkspace({ actor: seeded.owner, query: "has:banana" })).query.errors).toHaveLength(1);

    const solo = await seed("c09-solo", "local_host");
    await runInDurableObject<Workspace, void>(solo.stub, (instance) => {
      expect(() => instance.searchWorkspace({ actor: solo.owner, query: "anything" })).toThrow("content_is_host_owned");
    });
  });
});
