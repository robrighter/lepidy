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
  channelId: string;
};

async function seed(name: string): Promise<Seeded> {
  const stub = env.WORKSPACE.getByName(name);
  await stub.initializeWorkspace({ storageMode: "cloud", hostEpoch: 0, routingEpoch: 1, now: NOW });
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
  const owner: Actor = { memberId: "member-owner", authorizationEpoch: 1 };
  const member: Actor = { memberId: "member-two", authorizationEpoch: 1 };
  const channel = await stub.createChannel({
    actor: owner,
    idempotencyKey: `channel:create:${name}:0001`,
    kind: "public",
    slug: "eng",
    memberIds: [member.memberId],
    now: NOW,
  });
  return {
    stub,
    owner,
    member,
    outsider: { memberId: "member-three", authorizationEpoch: 1 },
    channelId: channel.channelId,
  };
}

async function post(seeded: Seeded, actor: Actor, body: string, key: string, now = NOW + 1) {
  return seeded.stub.sendMessage({
    actor,
    idempotencyKey: key,
    channelId: seeded.channelId,
    bodyMarkdown: body,
    now,
  });
}

describe("mentions on a message", () => {
  it("MSG-INT-001 records who a message addresses and resolves the handles it knows", async () => {
    const seeded = await seed("messages-mentions");
    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO agents(id, handle, display_name, status, created_at, updated_at)
         VALUES ('agent-release', 'a.releasebot', 'Release Bot', 'active', ?, ?)`,
        NOW,
        NOW,
      );
    });

    const sent = await post(
      seeded,
      seeded.owner,
      "@daniel and @a.releasebot please look. @nobody is not here.\n\n```\n@priya ignore me\n```",
      "message:send:mention000001",
    );

    const history = await seeded.stub.readChannelHistory({
      actor: seeded.owner,
      channelId: seeded.channelId,
    });
    const mentions = history.messages[0].mentions;
    expect(mentions.map((mention) => `${mention.kind}:${mention.handle}`).sort()).toEqual([
      "agent:a.releasebot",
      "member:daniel",
      "member:nobody",
    ]);
    // A known handle resolves to an id; an unknown one is recorded, not invented.
    expect(mentions.find((mention) => mention.handle === "daniel")?.resolvedId).toBe("member-two");
    expect(mentions.find((mention) => mention.handle === "a.releasebot")?.resolvedId).toBe("agent-release");
    expect(mentions.find((mention) => mention.handle === "nobody")?.resolvedId).toBeNull();
    // Nothing named inside a fence addresses anybody.
    expect(mentions.some((mention) => mention.handle === "priya")).toBe(false);
    expect(sent.messageId).toBe(history.messages[0].id);
  });
});

describe("editing", () => {
  it("MSG-INT-002 lets only the author edit, and marks the message when they do", async () => {
    const seeded = await seed("messages-edit");
    const sent = await post(seeded, seeded.owner, "the deploy is green", "message:send:edit00000001");

    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      await expect(
        instance.editMessage({
          actor: seeded.member,
          messageId: sent.messageId,
          bodyMarkdown: "not mine to change",
          now: NOW + 2,
        }),
      ).rejects.toThrow("only the author may edit a message");
      await expect(
        instance.editMessage({
          actor: seeded.owner,
          messageId: sent.messageId,
          bodyMarkdown: "   ",
          now: NOW + 3,
        }),
      ).rejects.toThrow("message body is empty or too long");
    });

    await expect(
      seeded.stub.editMessage({
        actor: seeded.owner,
        messageId: sent.messageId,
        bodyMarkdown: "the deploy is green, @daniel",
        now: NOW + 4,
      }),
    ).resolves.toEqual({ messageId: sent.messageId, editedAt: NOW + 4 });

    const history = await seeded.stub.readChannelHistory({
      actor: seeded.owner,
      channelId: seeded.channelId,
    });
    expect(history.messages[0]).toMatchObject({
      bodyMarkdown: "the deploy is green, @daniel",
      editedAt: NOW + 4,
      editCount: 1,
      // The edit keeps the message's place in the room.
      channelSequence: 1,
    });
    // Addressing is re-derived from what the message says now.
    expect(history.messages[0].mentions.map((mention) => mention.handle)).toEqual(["daniel"]);
  });

  it("MSG-INT-003 refuses an edit that would put content where the host owns it", async () => {
    const stub = env.WORKSPACE.getByName("messages-edit-solo");
    await stub.initializeWorkspace({ storageMode: "local_host", hostEpoch: 0, routingEpoch: 1, now: NOW });
    await stub.applyMembership({
      operationId: "messages-edit-solo-op",
      memberId: "member-owner",
      accountId: "account-owner",
      handle: "maya",
      displayName: "Maya Chen",
      role: "owner",
      status: "active",
      authorizationEpoch: 1,
      version: 1,
      now: NOW,
    });
    await runInDurableObject<Workspace, void>(stub, async (instance) => {
      await expect(
        instance.editMessage({
          actor: { memberId: "member-owner", authorizationEpoch: 1 },
          messageId: "message-anything",
          bodyMarkdown: "SOLO_EDIT_CANARY",
          now: NOW + 1,
        }),
      ).rejects.toThrow("content_is_host_owned");
    });
    await runInDurableObject<Workspace, void>(stub, (_instance, state) => {
      const dump = state.storage.sql
        .exec<{ metadata_json: string }>("SELECT metadata_json FROM audit_events")
        .toArray()
        .map((row) => row.metadata_json)
        .join("");
      expect(dump).not.toContain("SOLO_EDIT_CANARY");
    });
  });
});

describe("deleting", () => {
  it("MSG-INT-004 removes the content and keeps a tombstone", async () => {
    const seeded = await seed("messages-delete");
    const root = await post(seeded, seeded.owner, "why is the build red? @daniel", "message:send:del00000001");
    const reply = await seeded.stub.sendMessage({
      actor: seeded.owner,
      idempotencyKey: "message:send:del00000002",
      channelId: seeded.channelId,
      bodyMarkdown: "flaky test",
      threadParentId: root.messageId,
      now: NOW + 2,
    });
    await seeded.stub.reactToMessage({
      actor: seeded.member,
      messageId: root.messageId,
      emoji: "\u{1F525}",
      now: NOW + 3,
    });

    await expect(
      seeded.stub.deleteMessage({ actor: seeded.owner, messageId: root.messageId, now: NOW + 4 }),
    ).resolves.toEqual({ messageId: root.messageId, deletedAt: NOW + 4 });

    const history = await seeded.stub.readChannelHistory({
      actor: seeded.owner,
      channelId: seeded.channelId,
    });
    const tombstone = history.messages.find((message) => message.id === root.messageId);
    // The row survives so the thread and the sequence stay intact.
    expect(tombstone).toMatchObject({
      bodyMarkdown: "",
      deletedAt: NOW + 4,
      channelSequence: 1,
      replyCount: 1,
    });
    // The content, its addressing and its reactions leave every read at once.
    expect(tombstone?.mentions).toEqual([]);
    expect(tombstone?.reactions).toEqual([]);
    expect(JSON.stringify(history)).not.toContain("build red");

    const thread = await seeded.stub.readThreadHistory({
      actor: seeded.owner,
      threadRootId: root.messageId,
    });
    expect(thread.messages.map((message) => message.id)).toEqual([reply.messageId]);

    await runInDurableObject<Workspace, void>(seeded.stub, async (instance, state) => {
      // Deleting twice is not an error the second time round; it is not found.
      await expect(
        instance.deleteMessage({ actor: seeded.owner, messageId: root.messageId, now: NOW + 5 }),
      ).rejects.toThrow("message not found");
      await expect(
        instance.editMessage({
          actor: seeded.owner,
          messageId: root.messageId,
          bodyMarkdown: "back from the dead",
          now: NOW + 6,
        }),
      ).rejects.toThrow("message not found");
      expect(
        state.storage.sql
          .exec<{ n: number }>("SELECT COUNT(*) AS n FROM message_mentions WHERE message_id = ?", root.messageId)
          .one().n,
      ).toBe(0);
      expect(
        state.storage.sql
          .exec<{ n: number }>("SELECT COUNT(*) AS n FROM message_reactions WHERE message_id = ?", root.messageId)
          .one().n,
      ).toBe(0);
    });
  });

  it("MSG-INT-005 lets an admin delete somebody else's message and says who did", async () => {
    const seeded = await seed("messages-delete-admin");
    const sent = await post(seeded, seeded.member, "MODERATED_CANARY", "message:send:del00000010");

    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      // A peer cannot; an owner can.
      await expect(
        instance.deleteMessage({ actor: seeded.outsider, messageId: sent.messageId, now: NOW + 2 }),
      ).rejects.toThrow("only the author or an admin may delete a message");
    });
    await expect(
      seeded.stub.deleteMessage({ actor: seeded.owner, messageId: sent.messageId, now: NOW + 3 }),
    ).resolves.toMatchObject({ messageId: sent.messageId });

    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      const audit = state.storage.sql
        .exec<{ requester_id: string; metadata_json: string }>(
          "SELECT requester_id, metadata_json FROM audit_events WHERE event_type = 'message.deleted'",
        )
        .one();
      // The record says who deleted it and that it was not the author.
      expect(audit.requester_id).toBe("member-owner");
      expect(JSON.parse(audit.metadata_json)).toMatchObject({ by_author: false });
      expect(audit.metadata_json).not.toContain("MODERATED_CANARY");
      expect(
        state.storage.sql
          .exec<{ deleted_by_member_id: string }>(
            "SELECT deleted_by_member_id FROM messages WHERE id = ?",
            sent.messageId,
          )
          .one().deleted_by_member_id,
      ).toBe("member-owner");
    });
  });
});

describe("reactions", () => {
  it("MSG-INT-006 counts one reaction per person per emoji and can be taken back", async () => {
    const seeded = await seed("messages-reactions");
    const sent = await post(seeded, seeded.owner, "shipped", "message:send:react00000001");

    await expect(
      seeded.stub.reactToMessage({
        actor: seeded.owner,
        messageId: sent.messageId,
        emoji: "\u{1F525}",
        now: NOW + 2,
      }),
    ).resolves.toEqual({ added: true });
    // The same person and emoji twice is still one reaction.
    await expect(
      seeded.stub.reactToMessage({
        actor: seeded.owner,
        messageId: sent.messageId,
        emoji: "\u{1F525}",
        now: NOW + 3,
      }),
    ).resolves.toEqual({ added: false });
    await seeded.stub.reactToMessage({
      actor: seeded.member,
      messageId: sent.messageId,
      emoji: "\u{1F525}",
      now: NOW + 4,
    });
    // A named reaction must name an emoji this workspace has defined (C05c).
    await seeded.stub.createCustomEmoji({
      actor: seeded.owner,
      name: "shipit",
      aliasEmoji: "\u{1F680}",
      now: NOW + 4,
    });
    await seeded.stub.reactToMessage({
      actor: seeded.member,
      messageId: sent.messageId,
      emoji: ":shipit:",
      now: NOW + 5,
    });

    const history = await seeded.stub.readChannelHistory({
      actor: seeded.owner,
      channelId: seeded.channelId,
    });
    expect(history.messages[0].reactions).toEqual([
      { emoji: ":shipit:", memberIds: ["member-two"] },
      { emoji: "\u{1F525}", memberIds: ["member-owner", "member-two"] },
    ]);

    await expect(
      seeded.stub.unreactToMessage({
        actor: seeded.owner,
        messageId: sent.messageId,
        emoji: "\u{1F525}",
        now: NOW + 6,
      }),
    ).resolves.toEqual({ removed: true });
    await expect(
      seeded.stub.unreactToMessage({
        actor: seeded.owner,
        messageId: sent.messageId,
        emoji: "\u{1F525}",
        now: NOW + 7,
      }),
    ).resolves.toEqual({ removed: false });

    const after = await seeded.stub.readChannelHistory({
      actor: seeded.owner,
      channelId: seeded.channelId,
    });
    expect(after.messages[0].reactions).toEqual([
      { emoji: ":shipit:", memberIds: ["member-two"] },
      { emoji: "\u{1F525}", memberIds: ["member-two"] },
    ]);
  });

  it("MSG-INT-007 refuses a reaction from outside the room or of the wrong shape", async () => {
    const seeded = await seed("messages-reactions-refused");
    const priv = await seeded.stub.createChannel({
      actor: seeded.owner,
      idempotencyKey: "channel:create:private:0001",
      kind: "private",
      slug: "design",
      now: NOW,
    });
    const inPrivate = await seeded.stub.sendMessage({
      actor: seeded.owner,
      idempotencyKey: "message:send:react00000010",
      channelId: priv.channelId,
      bodyMarkdown: "private thought",
      now: NOW + 1,
    });
    const inPublic = await post(seeded, seeded.owner, "public thought", "message:send:react00000011");

    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      // Not in the room: reported as missing, never as forbidden.
      await expect(
        instance.reactToMessage({
          actor: seeded.outsider,
          messageId: inPrivate.messageId,
          emoji: "\u{1F525}",
          now: NOW + 2,
        }),
      ).rejects.toThrow("channel not found");
      // Can see the open room but has not joined it.
      await expect(
        instance.reactToMessage({
          actor: seeded.outsider,
          messageId: inPublic.messageId,
          emoji: "\u{1F525}",
          now: NOW + 3,
        }),
      ).rejects.toThrow("join this room before posting in it");
      // A reaction is a short grapheme, not a second message body.
      for (const emoji of ["lgtm", "", "x".repeat(40)]) {
        await expect(
          instance.reactToMessage({
            actor: seeded.owner,
            messageId: inPublic.messageId,
            emoji,
            now: NOW + 4,
          }),
        ).rejects.toThrow("invalid reaction");
      }
    });

    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      expect(
        state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM message_reactions").one().n,
      ).toBe(0);
    });
  });
});
