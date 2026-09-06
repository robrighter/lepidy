import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Actor, Workspace } from "../src/cloudflare/workspace";

const NOW = 1_800_000_000_000;

type Seeded = {
  stub: DurableObjectStub<Workspace>;
  owner: Actor;
  member: Actor;
  outsider: Actor;
};

async function seed(name: string, storageMode: "cloud" | "local_host" = "cloud"): Promise<Seeded> {
  const stub = env.WORKSPACE.getByName(name);
  await stub.initializeWorkspace({ storageMode, hostEpoch: 0, routingEpoch: 1, now: NOW });
  const people: readonly [string, string, string][] = [
    ["member-owner", "maya", "Maya Chen"],
    ["member-two", "daniel", "Daniel Park"],
    ["member-three", "priya", "Priya Singh"],
  ];
  for (const [index, [memberId, handle, displayName]] of people.entries()) {
    await stub.applyMembership({
      operationId: `${name}-op-${memberId}`,
      memberId,
      accountId: `account-${memberId}`,
      handle,
      displayName,
      role: index === 0 ? "owner" : "member",
      status: "active",
      authorizationEpoch: 1,
      version: 1,
      now: NOW,
    });
  }
  return {
    stub,
    owner: { memberId: "member-owner", authorizationEpoch: 1 },
    member: { memberId: "member-two", authorizationEpoch: 1 },
    outsider: { memberId: "member-three", authorizationEpoch: 1 },
  };
}

async function room(
  seeded: Seeded,
  slug: string,
  kind: "public" | "private",
  members: string[] = [],
  actor: Actor = seeded.owner,
) {
  return seeded.stub.createChannel({
    actor,
    idempotencyKey: `channel:create:${slug}:0000000001`,
    kind,
    slug,
    memberIds: members,
    now: NOW,
  });
}

async function post(
  seeded: Seeded,
  actor: Actor,
  channelId: string,
  body: string,
  key: string,
  now = NOW + 1,
) {
  return seeded.stub.sendMessage({
    actor,
    idempotencyKey: key,
    channelId,
    bodyMarkdown: body,
    now,
  });
}

describe("pins", () => {
  it("PIN-INT-001 pins for the whole room and refuses anyone not in it", async () => {
    const seeded = await seed("pins-room");
    const open = await room(seeded, "eng", "public", [seeded.member.memberId]);
    const sent = await post(seeded, seeded.owner, open.channelId, "the runbook", "message:send:pin000001");

    await expect(
      seeded.stub.pinMessage({ actor: seeded.owner, messageId: sent.messageId, now: NOW + 2 }),
    ).resolves.toEqual({ pinned: true });
    // Pinning twice is one pin.
    await expect(
      seeded.stub.pinMessage({ actor: seeded.owner, messageId: sent.messageId, now: NOW + 3 }),
    ).resolves.toEqual({ pinned: false });

    // A pin belongs to the room, so every member of it sees the same pin.
    const forMember = await seeded.stub.listPins({ actor: seeded.member, channelId: open.channelId });
    expect(forMember.messages.map((message) => message.id)).toEqual([sent.messageId]);
    expect(forMember.messages[0].isPinned).toBe(true);

    // Visible without joining, but pinning needs membership.
    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      expect(instance.listPins({ actor: seeded.outsider, channelId: open.channelId }).messages).toHaveLength(1);
      await expect(
        instance.pinMessage({ actor: seeded.outsider, messageId: sent.messageId, now: NOW + 4 }),
      ).rejects.toThrow("join this room before posting in it");
    });

    await expect(
      seeded.stub.unpinMessage({ actor: seeded.member, messageId: sent.messageId, now: NOW + 5 }),
    ).resolves.toEqual({ unpinned: true });
    await expect(
      seeded.stub.unpinMessage({ actor: seeded.member, messageId: sent.messageId, now: NOW + 6 }),
    ).resolves.toEqual({ unpinned: false });
  });

  it("PIN-INT-002 keeps a private room's pins invisible to everyone outside it", async () => {
    const seeded = await seed("pins-private");
    const closed = await room(seeded, "design", "private");
    const sent = await post(
      seeded,
      seeded.owner,
      closed.channelId,
      "PRIVATE_PIN_CANARY",
      "message:send:pin000010",
    );
    await seeded.stub.pinMessage({ actor: seeded.owner, messageId: sent.messageId, now: NOW + 2 });

    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      // Missing, not forbidden, and no trace of the canary either way.
      expect(() => instance.listPins({ actor: seeded.member, channelId: closed.channelId })).toThrow(
        "channel not found",
      );
      await expect(
        instance.pinMessage({ actor: seeded.member, messageId: sent.messageId, now: NOW + 3 }),
      ).rejects.toThrow("channel not found");
    });
  });

  it("PIN-INT-003 drops a pinned message from the list once it is deleted", async () => {
    const seeded = await seed("pins-deleted");
    const open = await room(seeded, "eng", "public");
    const sent = await post(seeded, seeded.owner, open.channelId, "temporary", "message:send:pin000020");
    await seeded.stub.pinMessage({ actor: seeded.owner, messageId: sent.messageId, now: NOW + 2 });
    await seeded.stub.deleteMessage({ actor: seeded.owner, messageId: sent.messageId, now: NOW + 3 });

    const pins = await seeded.stub.listPins({ actor: seeded.owner, channelId: open.channelId });
    expect(pins.messages).toEqual([]);
  });

  it("PIN-INT-004 refuses to pin on a Solo workspace", async () => {
    const seeded = await seed("pins-solo", "local_host");
    const open = await room(seeded, "eng", "public");
    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      await expect(
        instance.pinMessage({ actor: seeded.owner, messageId: "message-anything", now: NOW + 1 }),
      ).rejects.toThrow("content_is_host_owned");
      expect(instance.listPins({ actor: seeded.owner, channelId: open.channelId }).messages).toEqual([]);
    });
  });
});

describe("saved items", () => {
  it("SAVED-INT-001 saves privately and shows nobody else's list", async () => {
    const seeded = await seed("saved-private");
    const open = await room(seeded, "eng", "public", [seeded.member.memberId]);
    const sent = await post(seeded, seeded.owner, open.channelId, "worth keeping", "message:send:save00001");

    await expect(
      seeded.stub.saveMessage({ actor: seeded.member, messageId: sent.messageId, now: NOW + 2 }),
    ).resolves.toEqual({ saved: true });
    await expect(
      seeded.stub.saveMessage({ actor: seeded.member, messageId: sent.messageId, now: NOW + 3 }),
    ).resolves.toEqual({ saved: false });

    const mine = await seeded.stub.listSavedItems({ actor: seeded.member });
    expect(mine.items.map((item) => item.message.id)).toEqual([sent.messageId]);
    expect(mine.items[0].message.isSaved).toBe(true);

    // Saving is private: the author's own list is untouched by somebody else saving.
    await expect(seeded.stub.listSavedItems({ actor: seeded.owner })).resolves.toEqual({
      items: [],
      unavailable: 0,
    });

    await expect(
      seeded.stub.unsaveMessage({ actor: seeded.member, messageId: sent.messageId }),
    ).resolves.toEqual({ removed: true });
    await expect(seeded.stub.listSavedItems({ actor: seeded.member })).resolves.toMatchObject({
      items: [],
    });
  });

  it("SAVED-INT-002 stops returning a saved message once the member leaves its room", async () => {
    const seeded = await seed("saved-left");
    const closed = await room(seeded, "design", "private", [seeded.member.memberId]);
    const open = await room(seeded, "eng", "public", [seeded.member.memberId]);
    const secret = await post(
      seeded,
      seeded.owner,
      closed.channelId,
      "SAVED_PRIVATE_CANARY",
      "message:send:save00010",
    );
    const public_ = await post(seeded, seeded.owner, open.channelId, "still fine", "message:send:save00011");

    await seeded.stub.saveMessage({ actor: seeded.member, messageId: secret.messageId, now: NOW + 2 });
    await seeded.stub.saveMessage({ actor: seeded.member, messageId: public_.messageId, now: NOW + 3 });
    expect((await seeded.stub.listSavedItems({ actor: seeded.member })).items).toHaveLength(2);

    // The pointer is not a permission: leaving the room revokes the read.
    await seeded.stub.leaveChannel({
      actor: seeded.member,
      channelId: closed.channelId,
      now: NOW + 4,
    });

    const after = await seeded.stub.listSavedItems({ actor: seeded.member });
    expect(after.items.map((item) => item.message.id)).toEqual([public_.messageId]);
    expect(after.unavailable).toBe(1);
    expect(JSON.stringify(after)).not.toContain("SAVED_PRIVATE_CANARY");

    // The row is still theirs to remove even though they can no longer read it.
    await expect(
      seeded.stub.unsaveMessage({ actor: seeded.member, messageId: secret.messageId }),
    ).resolves.toEqual({ removed: true });
  });

  it("SAVED-INT-003 refuses to save something the member cannot read, and drops a deleted one", async () => {
    const seeded = await seed("saved-refused");
    const closed = await room(seeded, "design", "private");
    const open = await room(seeded, "eng", "public");
    const secret = await post(seeded, seeded.owner, closed.channelId, "not yours", "message:send:save00020");
    const doomed = await post(seeded, seeded.owner, open.channelId, "for now", "message:send:save00021");

    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      await expect(
        instance.saveMessage({ actor: seeded.member, messageId: secret.messageId, now: NOW + 2 }),
      ).rejects.toThrow("channel not found");
      await expect(
        instance.saveMessage({ actor: seeded.member, messageId: "message-does-not-exist", now: NOW + 3 }),
      ).rejects.toThrow("message not found");
    });

    await seeded.stub.saveMessage({ actor: seeded.member, messageId: doomed.messageId, now: NOW + 4 });
    await seeded.stub.deleteMessage({ actor: seeded.owner, messageId: doomed.messageId, now: NOW + 5 });
    await expect(seeded.stub.listSavedItems({ actor: seeded.member })).resolves.toEqual({
      items: [],
      unavailable: 1,
    });
  });
});

describe("forwarding", () => {
  it("FORWARD-INT-001 carries a copy into a room the forwarder may post in", async () => {
    const seeded = await seed("forward-copy");
    const source = await room(seeded, "design", "private", [seeded.member.memberId]);
    const target = await room(seeded, "eng", "public", [seeded.member.memberId]);
    const original = await post(
      seeded,
      seeded.owner,
      source.channelId,
      "the decision was to ship",
      "message:send:fwd000001",
    );

    const forwarded = await seeded.stub.forwardMessage({
      actor: seeded.member,
      idempotencyKey: "message:forward:0000000001",
      messageId: original.messageId,
      targetChannelId: target.channelId,
      comment: "worth reading",
      now: NOW + 2,
    });
    expect(forwarded.channelId).toBe(target.channelId);

    // A retried forward is one message, not two.
    const retry = await seeded.stub.forwardMessage({
      actor: seeded.member,
      idempotencyKey: "message:forward:0000000001",
      messageId: original.messageId,
      targetChannelId: target.channelId,
      comment: "worth reading",
      now: NOW + 3,
    });
    expect(retry.messageId).toBe(forwarded.messageId);
    expect(retry.replayed).toBe(true);

    const history = await seeded.stub.readChannelHistory({
      actor: seeded.member,
      channelId: target.channelId,
    });
    const copy = history.messages.find((message) => message.id === forwarded.messageId);
    expect(copy?.bodyMarkdown).toBe("worth reading\n\nthe decision was to ship");
    // The forwarder is the author of the copy; the original author is provenance.
    expect(copy?.authorId).toBe(seeded.member.memberId);
    expect(copy?.forwardedFrom).toMatchObject({
      messageId: original.messageId,
      authorDisplaySnapshot: "Maya Chen",
      sourceVisible: true,
      sourceChannelLabel: "design",
    });
  });

  it("FORWARD-INT-002 withholds the source room from a reader who cannot see it", async () => {
    const seeded = await seed("forward-provenance");
    const source = await room(seeded, "design", "private");
    const target = await room(seeded, "eng", "public", [seeded.member.memberId]);
    const original = await post(
      seeded,
      seeded.owner,
      source.channelId,
      "quotable",
      "message:send:fwd000010",
    );
    const forwarded = await seeded.stub.forwardMessage({
      actor: seeded.owner,
      idempotencyKey: "message:forward:0000000010",
      messageId: original.messageId,
      targetChannelId: target.channelId,
      now: NOW + 2,
    });

    // The forwarder can see where it came from.
    const asOwner = await seeded.stub.readChannelHistory({
      actor: seeded.owner,
      channelId: target.channelId,
    });
    expect(asOwner.messages[0].forwardedFrom).toMatchObject({
      sourceVisible: true,
      sourceChannelLabel: "design",
    });

    // A reader who is not in the source room gets the copy, and nothing that
    // tells them a room called "design" exists.
    const asMember = await seeded.stub.readChannelHistory({
      actor: seeded.member,
      channelId: target.channelId,
    });
    const copy = asMember.messages.find((message) => message.id === forwarded.messageId);
    expect(copy?.bodyMarkdown).toBe("quotable");
    expect(copy?.forwardedFrom).toMatchObject({
      sourceVisible: false,
      sourceChannelLabel: null,
      channelId: "",
    });
    expect(JSON.stringify(asMember)).not.toContain(source.channelId);
    expect(JSON.stringify(asMember)).not.toContain("design");
  });

  it("FORWARD-INT-003 refuses a source the forwarder cannot read or a target they cannot post in", async () => {
    const seeded = await seed("forward-refused");
    const source = await room(seeded, "design", "private");
    const open = await room(seeded, "eng", "public");
    const original = await post(
      seeded,
      seeded.owner,
      source.channelId,
      "FORWARD_CANARY",
      "message:send:fwd000020",
    );
    const readable = await post(seeded, seeded.owner, open.channelId, "public", "message:send:fwd000021");

    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      // Cannot read the source.
      await expect(
        instance.forwardMessage({
          actor: seeded.member,
          idempotencyKey: "message:forward:0000000020",
          messageId: original.messageId,
          targetChannelId: open.channelId,
          now: NOW + 2,
        }),
      ).rejects.toThrow("channel not found");
      // Can read the source but has not joined the target.
      await expect(
        instance.forwardMessage({
          actor: seeded.member,
          idempotencyKey: "message:forward:0000000021",
          messageId: readable.messageId,
          targetChannelId: open.channelId,
          now: NOW + 3,
        }),
      ).rejects.toThrow("join this room before posting in it");
    });

    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      const bodies = state.storage.sql
        .exec<{ body_markdown: string }>("SELECT body_markdown FROM messages")
        .toArray()
        .map((row) => row.body_markdown)
        .join("");
      // Exactly one copy of the canary exists: the original.
      expect(bodies.split("FORWARD_CANARY").length - 1).toBe(1);
    });
  });

  it("FORWARD-INT-004 refuses to forward on a Solo workspace", async () => {
    const seeded = await seed("forward-solo", "local_host");
    const open = await room(seeded, "eng", "public");
    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      await expect(
        instance.forwardMessage({
          actor: seeded.owner,
          idempotencyKey: "message:forward:0000000030",
          messageId: "message-anything",
          targetChannelId: open.channelId,
          now: NOW + 1,
        }),
      ).rejects.toThrow("content_is_host_owned");
    });
  });
});

describe("history pagination", () => {
  it("SAVED-INT-004 pages a long history without losing or repeating a message", async () => {
    const seeded = await seed("history-paging");
    const open = await room(seeded, "eng", "public");
    const ids: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const sent = await post(
        seeded,
        seeded.owner,
        open.channelId,
        `message ${index}`,
        `message:send:page0000${index.toString().padStart(2, "0")}`,
        // Distinct times, so this asserts ordering rather than the
        // same-millisecond tiebreak ROOM-INT-009 already covers.
        NOW + 1 + index,
      );
      ids.push(sent.messageId);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const result: Awaited<ReturnType<Workspace["readChannelHistory"]>> =
        await seeded.stub.readChannelHistory({
          actor: seeded.owner,
          channelId: open.channelId,
          cursor,
          limit: 5,
        });
      seen.push(...result.messages.map((message) => message.id));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }

    expect(cursor).toBeNull();
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
    // Newest first, all the way back to the first thing said in the room.
    expect(seen[0]).toBe(ids[11]);
    expect(seen.at(-1)).toBe(ids[0]);
  });
});
