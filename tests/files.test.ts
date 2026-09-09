import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Actor, Workspace } from "../src/cloudflare/workspace";

const NOW = 1_800_000_000_000;
const MIB = 1024 * 1024;

async function workspaceWithMembers(name: string, storageMode: "cloud" | "local_host" = "cloud") {
  const stub = env.WORKSPACE.getByName(name);
  await stub.initializeWorkspace({ storageMode, hostEpoch: 0, routingEpoch: 1, now: NOW });
  for (const [memberId, handle, displayName, role] of [
    ["owner", "maya", "Maya Chen", "owner"],
    ["member", "lee", "Lee Ortiz", "member"],
    ["outsider", "sam", "Sam Ortiz", "member"],
  ] as const) {
    await stub.applyMembership({
      operationId: `${name}-${memberId}`, memberId, accountId: `account-${memberId}`,
      handle, displayName, role, status: "active", authorizationEpoch: 1, version: 1, now: NOW,
    });
  }
  return stub;
}

describe("files, uploads and quota", () => {
  it("C08-INT-001 reserves, confirms and lists an upload while counting it against the projected quota", async () => {
    const stub = await workspaceWithMembers("c08-uploads");
    const owner: Actor = { memberId: "owner", authorizationEpoch: 1 };

    // A workspace with no projected entitlement has no room at all: the quota
    // fails closed rather than defaulting to something generous.
    const channel = await stub.createChannel({
      actor: owner, idempotencyKey: "c08-channel-0000001", kind: "public", slug: "files", memberIds: ["member"], now: NOW,
    });
    await runInDurableObject<Workspace, void>(stub, async (instance) => {
      await expect(instance.reserveUpload({
        actor: owner, idempotencyKey: "c08-reserve-000001", channelId: channel.channelId,
        fileName: "a.png", mediaType: "image/png", byteLength: 10, now: NOW,
      })).rejects.toThrow("out of attachment storage");
    });

    await stub.applyStorageEntitlement({ quotaBytes: 30 * MIB, version: 1, now: NOW });
    expect(await stub.storageStatus({ actor: owner })).toMatchObject({ quotaBytes: 30 * MIB, usedBytes: 0, warn: false });

    const reserved = await stub.reserveUpload({
      actor: owner, idempotencyKey: "c08-reserve-000002", channelId: channel.channelId,
      fileName: "Quarterly Report.pdf", mediaType: "application/pdf", byteLength: 4 * MIB, now: NOW,
    });
    // The key carries the tenant, and the reservation already occupies space so
    // two parallel uploads cannot both be told the same bytes are free.
    expect(reserved.objectKey.startsWith("ws/")).toBe(true);
    expect(reserved.objectKey).toContain("Quarterly%20Report.pdf");
    expect(await stub.storageStatus({ actor: owner })).toMatchObject({ usedBytes: 4 * MIB });

    // A confirmation must match what was reserved, or a one-byte reservation
    // could be spent on a much larger object.
    await runInDurableObject<Workspace, void>(stub, async (instance) => {
      await expect(instance.confirmUpload({ actor: owner, fileId: reserved.fileId, byteLength: 9 * MIB, now: NOW + 1 }))
        .rejects.toThrow("does not match its reservation");
    });
    await stub.confirmUpload({ actor: owner, fileId: reserved.fileId, byteLength: 4 * MIB, sha256: "a".repeat(64), now: NOW + 1 });

    const listed = await stub.listFiles({ actor: owner, channelId: channel.channelId });
    expect(listed.files).toHaveLength(1);
    expect(listed.files[0]).toMatchObject({
      fileName: "Quarterly Report.pdf", mediaType: "application/pdf", byteLength: 4 * MIB, inlineRenderable: false,
    });

    const download = await stub.authorizeDownload({ actor: owner, fileId: reserved.fileId });
    expect(download.objectKey).toBe(reserved.objectKey);

    // The remaining allowance is real: a file that does not fit is refused
    // rather than accepted by evicting something.
    await runInDurableObject<Workspace, void>(stub, async (instance) => {
      await expect(instance.reserveUpload({
        actor: owner, idempotencyKey: "c08-reserve-000003", channelId: channel.channelId,
        fileName: "huge.bin", mediaType: "application/octet-stream", byteLength: 27 * MIB, now: NOW + 2,
      })).rejects.toThrow("out of attachment storage");
    });
  });

  it("C08-INT-002 refuses uploads and downloads across a room the reader cannot see", async () => {
    const stub = await workspaceWithMembers("c08-visibility");
    const owner: Actor = { memberId: "owner", authorizationEpoch: 1 };
    const outsider: Actor = { memberId: "outsider", authorizationEpoch: 1 };
    await stub.applyStorageEntitlement({ quotaBytes: 30 * MIB, version: 1, now: NOW });

    const priv = await stub.createChannel({
      actor: owner, idempotencyKey: "c08-channel-0000002", kind: "private", slug: "leadership", memberIds: [], now: NOW,
    });
    const reserved = await stub.reserveUpload({
      actor: owner, idempotencyKey: "c08-reserve-000004", channelId: priv.channelId,
      fileName: "board.pdf", mediaType: "application/pdf", byteLength: 1024, now: NOW,
    });
    await stub.confirmUpload({ actor: owner, fileId: reserved.fileId, byteLength: 1024, now: NOW + 1 });

    // A private room's file is not listed for, downloadable by, or uploadable
    // to by somebody who cannot see the room — and it is reported as missing
    // rather than forbidden, which would confirm it exists.
    expect((await stub.listFiles({ actor: outsider })).files).toHaveLength(0);
    await runInDurableObject<Workspace, void>(stub, async (instance) => {
      expect(() => instance.authorizeDownload({ actor: outsider, fileId: reserved.fileId })).toThrow("file not found");
      await expect(instance.reserveUpload({
        actor: outsider, idempotencyKey: "c08-reserve-000005", channelId: priv.channelId,
        fileName: "x.png", mediaType: "image/png", byteLength: 10, now: NOW,
      })).rejects.toThrow("channel not found");
    });

    // The uploader sees their own file; a member of a room they can see may not
    // delete somebody else's upload, while an administrator may.
    expect((await stub.listFiles({ actor: owner })).files).toHaveLength(1);
    await runInDurableObject<Workspace, void>(stub, async (instance) => {
      await expect(instance.deleteFile({ actor: { memberId: "member", authorizationEpoch: 1 }, fileId: reserved.fileId, now: NOW + 2 }))
        .rejects.toThrow("file not found");
    });
    const deleted = await stub.deleteFile({ actor: owner, fileId: reserved.fileId, now: NOW + 3 });
    expect(deleted.objectKey).toBe(reserved.objectKey);
    // Access ends in the delete transaction, before any byte is swept.
    expect((await stub.listFiles({ actor: owner })).files).toHaveLength(0);
    await runInDurableObject<Workspace, void>(stub, async (instance) => {
      expect(() => instance.authorizeDownload({ actor: owner, fileId: reserved.fileId })).toThrow("file not found");
    });
  });

  it("C08-INT-003 expires an abandoned reservation and returns its bytes to the quota", async () => {
    const stub = await workspaceWithMembers("c08-sweep");
    const owner: Actor = { memberId: "owner", authorizationEpoch: 1 };
    await stub.applyStorageEntitlement({ quotaBytes: 10 * MIB, version: 1, now: NOW });
    const channel = await stub.createChannel({
      actor: owner, idempotencyKey: "c08-channel-0000003", kind: "public", slug: "sweep", memberIds: [], now: NOW,
    });
    const reserved = await stub.reserveUpload({
      actor: owner, idempotencyKey: "c08-reserve-000006", channelId: channel.channelId,
      fileName: "abandoned.bin", mediaType: "application/octet-stream", byteLength: 8 * MIB, now: NOW,
    });
    expect(await stub.storageStatus({ actor: owner })).toMatchObject({ usedBytes: 8 * MIB, warn: true });

    // Nothing expires early.
    expect((await stub.sweepAbandonedUploads({ now: NOW + 60_000 })).objectKeys).toEqual([]);

    const later = NOW + 2 * 60 * 60 * 1000;
    const swept = await stub.sweepAbandonedUploads({ now: later });
    expect(swept.objectKeys).toEqual([reserved.objectKey]);
    // The hole in the quota closes, and the expired reservation cannot be
    // confirmed afterwards.
    expect(await stub.storageStatus({ actor: owner })).toMatchObject({ usedBytes: 0 });
    await runInDurableObject<Workspace, void>(stub, async (instance) => {
      await expect(instance.confirmUpload({ actor: owner, fileId: reserved.fileId, byteLength: 8 * MIB, now: later }))
        .rejects.toThrow("cannot become");
    });
  });

  it("C08-INT-004 keeps a Solo workspace's attachments off the cloud relay", async () => {
    const stub = await workspaceWithMembers("c08-solo", "local_host");
    const owner: Actor = { memberId: "owner", authorizationEpoch: 1 };
    await stub.applyStorageEntitlement({ quotaBytes: 30 * MIB, version: 1, now: NOW });
    const channel = await stub.createChannel({
      actor: owner, idempotencyKey: "c08-channel-0000004", kind: "public", slug: "solo", memberIds: [], now: NOW,
    });
    // Solo attachments belong to the designated host under its own local quota,
    // so the cloud path refuses rather than quietly accepting the bytes.
    await runInDurableObject<Workspace, void>(stub, async (instance) => {
      await expect(instance.reserveUpload({
        actor: owner, idempotencyKey: "c08-reserve-000007", channelId: channel.channelId,
        fileName: "local.png", mediaType: "image/png", byteLength: 10, now: NOW,
      })).rejects.toThrow("stores attachments on its own host");
    });
  });

  it("C08B-INT-001 filters the workspace index by metadata without crossing room visibility", async () => {
    const stub = await workspaceWithMembers("c08b-index");
    const owner: Actor = { memberId: "owner", authorizationEpoch: 1 };
    const member: Actor = { memberId: "member", authorizationEpoch: 1 };
    const outsider: Actor = { memberId: "outsider", authorizationEpoch: 1 };
    await stub.applyStorageEntitlement({ quotaBytes: 30 * MIB, version: 1, now: NOW });
    const publicRoom = await stub.createChannel({
      actor: owner, idempotencyKey: "c08b-channel-public1", kind: "public", slug: "design", memberIds: ["member"], now: NOW,
    });
    const privateRoom = await stub.createChannel({
      actor: owner, idempotencyKey: "c08b-channel-private", kind: "private", slug: "board", memberIds: [], now: NOW,
    });

    const report = await stub.reserveUpload({
      actor: owner, idempotencyKey: "c08b-reserve-report", channelId: privateRoom.channelId,
      fileName: "Board report.pdf", mediaType: "application/pdf", byteLength: 900, now: NOW + 1,
    });
    await stub.confirmUpload({ actor: owner, fileId: report.fileId, byteLength: 900, now: NOW + 2 });
    const sketch = await stub.reserveUpload({
      actor: member, idempotencyKey: "c08b-reserve-sketch", channelId: publicRoom.channelId,
      fileName: "Navigation sketch.png", mediaType: "image/png", byteLength: 700, now: NOW + 3,
    });
    await stub.confirmUpload({ actor: member, fileId: sketch.fileId, byteLength: 700, now: NOW + 4 });

    expect((await stub.listFiles({ actor: owner, query: "report" })).files[0]).toMatchObject({
      id: report.fileId, uploadedByDisplayName: "Maya Chen", uploadedByHandle: "maya", channelSlug: "board",
    });
    expect((await stub.listFiles({ actor: owner, mediaTypePrefix: "image/" })).files.map((file) => file.id)).toEqual([sketch.fileId]);
    expect((await stub.listFiles({ actor: owner, uploaderMemberId: "member" })).files.map((file) => file.id)).toEqual([sketch.fileId]);
    expect((await stub.listFiles({ actor: owner, channelId: publicRoom.channelId })).files.map((file) => file.id)).toEqual([sketch.fileId]);
    expect((await stub.listFiles({ actor: owner, createdAtOrAfter: NOW + 2, createdBefore: NOW + 4 })).files.map((file) => file.id)).toEqual([sketch.fileId]);
    // The same broad query cannot confirm a private room's matching file to an outsider.
    expect((await stub.listFiles({ actor: outsider, query: "report" })).files).toEqual([]);
  });

  it("C08B-INT-002 returns cached preview text only through a currently visible message", async () => {
    const stub = await workspaceWithMembers("c08b-unfurl");
    const owner: Actor = { memberId: "owner", authorizationEpoch: 1 };
    const outsider: Actor = { memberId: "outsider", authorizationEpoch: 1 };
    const room = await stub.createChannel({
      actor: owner, idempotencyKey: "c08b-unfurl-room001", kind: "private", slug: "preview", memberIds: [], now: NOW,
    });
    const message = await stub.sendMessage({
      actor: owner, idempotencyKey: "c08b-unfurl-message", channelId: room.channelId,
      bodyMarkdown: "Read [the runbook](https://docs.example/runbook).", now: NOW + 1,
    });
    await runInDurableObject<Workspace, void>(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO link_unfurls(url, final_url, title, description, site_name, state, fetched_at)
         VALUES (?, ?, ?, ?, ?, 'ready', ?)`,
        "https://docs.example/runbook", "https://docs.example/runbook", "Relay runbook",
        "How to restart the relay.", "Lepidy docs", NOW + 1,
      );
    });

    await expect(stub.listMessageUnfurls({ actor: owner, messageIds: [message.messageId], now: NOW + 2 }))
      .resolves.toMatchObject({ unfurls: [{ messageId: message.messageId, title: "Relay runbook", siteName: "Lepidy docs" }] });
    await expect(stub.listMessageUnfurls({ actor: outsider, messageIds: [message.messageId], now: NOW + 2 }))
      .resolves.toEqual({ unfurls: [] });
    await stub.editMessage({
      actor: owner, messageId: message.messageId, bodyMarkdown: "The runbook moved.", now: NOW + 3,
    });
    await expect(stub.listMessageUnfurls({ actor: owner, messageIds: [message.messageId], now: NOW + 4 }))
      .resolves.toEqual({ unfurls: [] });
  });
});
