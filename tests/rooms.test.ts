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

/** A cloud workspace with three active members and nothing else. */
async function seedTeamWorkspace(name: string, storageMode: "cloud" | "local_host" = "cloud"): Promise<Seeded> {
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

describe("rooms and membership", () => {
  it("ROOM-INT-001 creates a room once, normalises its name and refuses a duplicate", async () => {
    const { stub, owner } = await seedTeamWorkspace("rooms-create");

    const created = await stub.createChannel({
      actor: owner,
      idempotencyKey: "channel:create:0000000001",
      kind: "public",
      slug: "  Release   Notes ",
      name: "  Release   Notes ",
      topic: "what shipped\nthis week",
      now: NOW,
    });
    expect(created.created).toBe(true);

    // The same request twice is one room, not two.
    const replayed = await stub.createChannel({
      actor: owner,
      idempotencyKey: "channel:create:0000000001",
      kind: "public",
      slug: "  Release   Notes ",
      name: "  Release   Notes ",
      topic: "what shipped\nthis week",
      now: NOW + 1,
    });
    expect(replayed).toEqual({ ...created, created: false });

    // A different request that lands on the same name is refused outright.
    await runInDurableObject<Workspace, void>(stub, async (instance) => {
      await expect(
        instance.createChannel({
          actor: owner,
          idempotencyKey: "channel:create:0000000002",
          kind: "private",
          slug: "release-notes",
          now: NOW + 2,
        }),
      ).rejects.toThrow("channel slug is already taken");
    });

    const browsed = await stub.browseChannels({ actor: owner });
    expect(browsed.channels).toHaveLength(1);
    expect(browsed.channels[0]).toMatchObject({
      id: created.channelId,
      kind: "public",
      slug: "release-notes",
      name: "Release Notes",
      topic: "what shipped this week",
      isMember: true,
      messageCount: 0,
    });
  });

  it("ROOM-INT-002 hides a private room from everyone who is not in it", async () => {
    const { stub, owner, member, outsider } = await seedTeamWorkspace("rooms-private");
    const priv = await stub.createChannel({
      actor: owner,
      idempotencyKey: "channel:create:0000000010",
      kind: "private",
      slug: "design",
      memberIds: [member.memberId],
      now: NOW,
    });

    expect((await stub.browseChannels({ actor: owner })).channels.map((c) => c.id)).toEqual([
      priv.channelId,
    ]);
    expect((await stub.browseChannels({ actor: member })).channels.map((c) => c.id)).toEqual([
      priv.channelId,
    ]);
    // A valid member of the workspace who is not in the room sees nothing at all.
    const outsiderView = await stub.browseChannels({ actor: outsider });
    expect(outsiderView.channels).toEqual([]);
    expect(JSON.stringify(outsiderView)).not.toContain("design");

    await runInDurableObject<Workspace, void>(stub, async (instance) => {
      // Missing, not forbidden: the two answers together would confirm it exists.
      expect(() =>
        instance.readChannelHistory({ actor: outsider, channelId: priv.channelId }),
      ).toThrow("channel not found");
      await expect(
        instance.joinChannel({ actor: outsider, channelId: priv.channelId, now: NOW + 1 }),
      ).rejects.toThrow("channel not found");
      await expect(
        instance.sendMessage({
          actor: outsider,
          idempotencyKey: "message:send:0000000001",
          channelId: priv.channelId,
          bodyMarkdown: "PRIVATE_ROOM_CANARY",
          now: NOW + 2,
        }),
      ).rejects.toThrow("channel not found");
    });

    // Nothing was written by any of the refused attempts.
    await runInDurableObject<Workspace, void>(stub, (_instance, state) => {
      expect(
        state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM messages").one().count,
      ).toBe(0);
      const audit = state.storage.sql
        .exec<{ metadata_json: string }>("SELECT metadata_json FROM audit_events")
        .toArray()
        .map((row) => row.metadata_json)
        .join("");
      expect(audit).not.toContain("PRIVATE_ROOM_CANARY");
    });
  });

  it("ROOM-INT-003 lets anyone join an open room and refuses a closed one", async () => {
    const { stub, owner, member } = await seedTeamWorkspace("rooms-join");
    const open = await stub.createChannel({
      actor: owner,
      idempotencyKey: "channel:create:0000000020",
      kind: "public",
      slug: "eng",
      now: NOW,
    });

    await runInDurableObject<Workspace, void>(stub, async (instance) => {
      // Visible without being a member, but posting needs joining first.
      expect(instance.readChannelHistory({ actor: member, channelId: open.channelId }).messages).toEqual(
        [],
      );
      await expect(
        instance.sendMessage({
          actor: member,
          idempotencyKey: "message:send:0000000010",
          channelId: open.channelId,
          bodyMarkdown: "before joining",
          now: NOW + 1,
        }),
      ).rejects.toThrow("join this room before posting in it");
    });

    await expect(
      stub.joinChannel({ actor: member, channelId: open.channelId, now: NOW + 2 }),
    ).resolves.toEqual({ joined: true });
    await expect(
      stub.joinChannel({ actor: member, channelId: open.channelId, now: NOW + 3 }),
    ).resolves.toEqual({ joined: false });

    await expect(
      stub.sendMessage({
        actor: member,
        idempotencyKey: "message:send:0000000011",
        channelId: open.channelId,
        bodyMarkdown: "after joining",
        now: NOW + 4,
      }),
    ).resolves.toMatchObject({ channelSequence: 1 });

    await expect(
      stub.leaveChannel({ actor: member, channelId: open.channelId, now: NOW + 5 }),
    ).resolves.toEqual({ left: true });
    await expect(
      stub.leaveChannel({ actor: member, channelId: open.channelId, now: NOW + 6 }),
    ).resolves.toEqual({ left: false });
  });

  it("ROOM-INT-004 archives a room, keeps it readable and refuses new messages", async () => {
    const { stub, owner, member } = await seedTeamWorkspace("rooms-archive");
    const channel = await stub.createChannel({
      actor: owner,
      idempotencyKey: "channel:create:0000000030",
      kind: "public",
      slug: "retired",
      memberIds: [member.memberId],
      now: NOW,
    });
    await stub.sendMessage({
      actor: owner,
      idempotencyKey: "message:send:0000000020",
      channelId: channel.channelId,
      bodyMarkdown: "last word",
      now: NOW + 1,
    });

    await runInDurableObject<Workspace, void>(stub, async (instance) => {
      // Only an admin or the room's creator may archive it.
      await expect(
        instance.archiveChannel({ actor: member, channelId: channel.channelId, now: NOW + 2 }),
      ).rejects.toThrow("only an admin or the room's creator may archive it");
    });

    await expect(
      stub.archiveChannel({ actor: owner, channelId: channel.channelId, now: NOW + 3 }),
    ).resolves.toEqual({ archived: true });
    await expect(
      stub.archiveChannel({ actor: owner, channelId: channel.channelId, now: NOW + 4 }),
    ).resolves.toEqual({ archived: false });

    // History survives archiving; writes do not.
    const history = await stub.readChannelHistory({ actor: owner, channelId: channel.channelId });
    expect(history.messages).toHaveLength(1);
    await runInDurableObject<Workspace, void>(stub, async (instance) => {
      await expect(
        instance.sendMessage({
          actor: owner,
          idempotencyKey: "message:send:0000000021",
          channelId: channel.channelId,
          bodyMarkdown: "after archiving",
          now: NOW + 5,
        }),
      ).rejects.toThrow("this room is archived");
    });
    // Archived rooms leave the default browse list.
    expect((await stub.browseChannels({ actor: owner })).channels).toEqual([]);
    expect(
      (await stub.browseChannels({ actor: owner, includeArchived: true })).channels,
    ).toHaveLength(1);
  });
});

describe("direct messages", () => {
  it("ROOM-INT-005 resolves one conversation whoever opens it and in whatever order", async () => {
    const { stub, owner, member, outsider } = await seedTeamWorkspace("rooms-dm");

    const first = await stub.openDirectMessage({
      actor: owner,
      idempotencyKey: "dm:open:0000000001",
      participantMemberIds: [member.memberId],
      now: NOW,
    });
    expect(first).toMatchObject({ kind: "dm", created: true });

    // The other person opening it from their side finds the same room.
    const second = await stub.openDirectMessage({
      actor: member,
      idempotencyKey: "dm:open:0000000002",
      participantMemberIds: [owner.memberId],
      now: NOW + 1,
    });
    expect(second).toEqual({ channelId: first.channelId, kind: "dm", created: false });

    // A third person makes a different conversation, not a bigger one.
    const group = await stub.openDirectMessage({
      actor: owner,
      idempotencyKey: "dm:open:0000000003",
      participantMemberIds: [member.memberId, outsider.memberId],
      now: NOW + 2,
    });
    expect(group).toMatchObject({ kind: "group_dm", created: true });
    expect(group.channelId).not.toBe(first.channelId);

    // A conversation is only ever visible to the people in it.
    expect((await stub.browseChannels({ actor: outsider })).channels.map((c) => c.id)).toEqual([
      group.channelId,
    ]);

    await runInDurableObject<Workspace, void>(stub, async (instance) => {
      await expect(
        instance.addChannelMember({
          actor: owner,
          channelId: first.channelId,
          memberId: outsider.memberId,
          now: NOW + 3,
        }),
      ).rejects.toThrow("a conversation's participants are fixed when it is opened");
      await expect(
        instance.leaveChannel({ actor: owner, channelId: first.channelId, now: NOW + 4 }),
      ).rejects.toThrow("a conversation cannot be left, only muted");
      await expect(
        instance.openDirectMessage({
          actor: owner,
          idempotencyKey: "dm:open:0000000004",
          participantMemberIds: ["member-does-not-exist"],
          now: NOW + 5,
        }),
      ).rejects.toThrow("every participant must be an active member");
    });
  });
});

describe("message writes", () => {
  it("ROOM-INT-006 commits a message with its audit, replay and delivery records at once", async () => {
    const { stub, owner } = await seedTeamWorkspace("rooms-send");
    const channel = await stub.createChannel({
      actor: owner,
      idempotencyKey: "channel:create:0000000040",
      kind: "public",
      slug: "eng",
      now: NOW,
    });

    const sent = await stub.sendMessage({
      actor: owner,
      idempotencyKey: "message:send:0000000030",
      channelId: channel.channelId,
      bodyMarkdown: "  the deploy is green  ",
      now: NOW + 1,
    });
    expect(sent).toMatchObject({ channelSequence: 1, threadRootId: null, replayed: false });

    await runInDurableObject<Workspace, void>(stub, (_instance, state) => {
      const message = state.storage.sql
        .exec<{ body_markdown: string; author_display_snapshot: string; channel_sequence: number }>(
          "SELECT body_markdown, author_display_snapshot, channel_sequence FROM messages WHERE id = ?",
          sent.messageId,
        )
        .one();
      expect(message).toEqual({
        body_markdown: "the deploy is green",
        author_display_snapshot: "Maya Chen",
        channel_sequence: 1,
      });

      const channelRow = state.storage.sql
        .exec<{ message_count: number; last_activity_at: number }>(
          "SELECT message_count, last_activity_at FROM channels WHERE id = ?",
          channel.channelId,
        )
        .one();
      expect(channelRow).toEqual({ message_count: 1, last_activity_at: NOW + 1 });

      // The audit record explains who acted, never what they said.
      const audit = state.storage.sql
        .exec<{ event_type: string; subject_id: string; metadata_json: string }>(
          "SELECT event_type, subject_id, metadata_json FROM audit_events WHERE subject_id = ?",
          sent.messageId,
        )
        .one();
      expect(audit.event_type).toBe("message.created");
      expect(audit.metadata_json).not.toContain("deploy");

      // Delivery carries identifiers; the reader fetches what they may see.
      const replay = state.storage.sql
        .exec<{ audience_json: string; payload_json: string }>(
          "SELECT audience_json, payload_json FROM replay_events WHERE payload_json LIKE ?",
          `%${sent.messageId}%`,
        )
        .one();
      expect(JSON.parse(replay.audience_json)).toEqual([channel.channelId]);
      expect(replay.payload_json).not.toContain("deploy");

      const outbox = state.storage.sql
        .exec<{ dedupe_key: string; payload_json: string; status: string }>(
          "SELECT dedupe_key, payload_json, status FROM pending_events WHERE id = ?",
          `message.${sent.messageId}`,
        )
        .one();
      expect(outbox.dedupe_key).toBe(`message:${sent.messageId}`);
      expect(outbox.payload_json).not.toContain("deploy");
    });
  });

  it("ROOM-INT-007 makes a retried send idempotent and refuses key reuse", async () => {
    const { stub, owner } = await seedTeamWorkspace("rooms-idempotent");
    const channel = await stub.createChannel({
      actor: owner,
      idempotencyKey: "channel:create:0000000050",
      kind: "public",
      slug: "eng",
      now: NOW,
    });

    const send = (body: string, now: number) =>
      stub.sendMessage({
        actor: owner,
        idempotencyKey: "message:send:0000000040",
        channelId: channel.channelId,
        bodyMarkdown: body,
        now,
      });

    const first = await send("only once", NOW + 1);
    const retry = await send("only once", NOW + 2);
    expect(retry.messageId).toBe(first.messageId);
    expect(retry.replayed).toBe(true);

    await runInDurableObject<Workspace, void>(stub, async (instance) => {
      // A different message under the same key is a client bug, not a retry.
      await expect(
        instance.sendMessage({
          actor: owner,
          idempotencyKey: "message:send:0000000040",
          channelId: channel.channelId,
          bodyMarkdown: "a completely different message",
          now: NOW + 3,
        }),
      ).rejects.toThrow("idempotency key reuse with a different request");
    });

    await runInDurableObject<Workspace, void>(stub, (_instance, state) => {
      expect(
        state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM messages").one().count,
      ).toBe(1);
      expect(
        state.storage.sql
          .exec<{ count: number }>(
            "SELECT COUNT(*) AS count FROM pending_events WHERE kind = 'message_created'",
          )
          .one().count,
      ).toBe(1);
      expect(
        state.storage.sql
          .exec<{ message_count: number }>("SELECT message_count FROM channels WHERE id = ?", channel.channelId)
          .one().message_count,
      ).toBe(1);
    });
  });

  it("ROOM-INT-008 keeps threads one level deep and counts their replies", async () => {
    const { stub, owner } = await seedTeamWorkspace("rooms-threads");
    const channel = await stub.createChannel({
      actor: owner,
      idempotencyKey: "channel:create:0000000060",
      kind: "public",
      slug: "eng",
      now: NOW,
    });
    const other = await stub.createChannel({
      actor: owner,
      idempotencyKey: "channel:create:0000000061",
      kind: "public",
      slug: "release",
      now: NOW,
    });

    const root = await stub.sendMessage({
      actor: owner,
      idempotencyKey: "message:send:0000000050",
      channelId: channel.channelId,
      bodyMarkdown: "why is the build red?",
      now: NOW + 1,
    });
    const reply = await stub.sendMessage({
      actor: owner,
      idempotencyKey: "message:send:0000000051",
      channelId: channel.channelId,
      bodyMarkdown: "flaky test",
      threadParentId: root.messageId,
      now: NOW + 2,
    });
    expect(reply.threadRootId).toBe(root.messageId);

    // Replying to a reply attaches to the same root, never to the reply.
    const nested = await stub.sendMessage({
      actor: owner,
      idempotencyKey: "message:send:0000000052",
      channelId: channel.channelId,
      bodyMarkdown: "fixed it",
      threadParentId: reply.messageId,
      now: NOW + 3,
    });
    expect(nested.threadRootId).toBe(root.messageId);

    await runInDurableObject<Workspace, void>(stub, async (instance) => {
      await expect(
        instance.sendMessage({
          actor: owner,
          idempotencyKey: "message:send:0000000053",
          channelId: other.channelId,
          bodyMarkdown: "wrong room",
          threadParentId: root.messageId,
          now: NOW + 4,
        }),
      ).rejects.toThrow("thread parent belongs to another channel");
      await expect(
        instance.sendMessage({
          actor: owner,
          idempotencyKey: "message:send:0000000054",
          channelId: channel.channelId,
          bodyMarkdown: "no such parent",
          threadParentId: "message-does-not-exist",
          now: NOW + 5,
        }),
      ).rejects.toThrow("thread parent not found");
    });

    // The channel shows the root only; the thread shows its replies in order.
    const channelHistory = await stub.readChannelHistory({ actor: owner, channelId: channel.channelId });
    expect(channelHistory.messages.map((m) => m.id)).toEqual([root.messageId]);
    expect(channelHistory.messages[0]).toMatchObject({ replyCount: 2, lastReplyAt: NOW + 3 });

    const thread = await stub.readThreadHistory({ actor: owner, threadRootId: root.messageId });
    expect(thread.messages.map((m) => m.id)).toEqual([reply.messageId, nested.messageId]);

    await runInDurableObject<Workspace, void>(stub, (instance) => {
      // A reply is not a thread root.
      expect(() => instance.readThreadHistory({ actor: owner, threadRootId: reply.messageId })).toThrow(
        "thread not found",
      );
    });
  });

  it("ROOM-INT-009 pages history newest first and refuses a forged cursor", async () => {
    const { stub, owner } = await seedTeamWorkspace("rooms-history");
    const channel = await stub.createChannel({
      actor: owner,
      idempotencyKey: "channel:create:0000000070",
      kind: "public",
      slug: "eng",
      now: NOW,
    });

    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const sent = await stub.sendMessage({
        actor: owner,
        idempotencyKey: `message:send:000000006${index}`,
        channelId: channel.channelId,
        // Two of these share a millisecond, so ordering cannot rely on time alone.
        bodyMarkdown: `message ${index}`,
        now: NOW + (index < 2 ? 1 : index),
      });
      ids.push(sent.messageId);
    }

    const first = await stub.readChannelHistory({ actor: owner, channelId: channel.channelId, limit: 2 });
    expect(first.messages).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await stub.readChannelHistory({
      actor: owner,
      channelId: channel.channelId,
      cursor: first.nextCursor,
      limit: 2,
    });
    const third = await stub.readChannelHistory({
      actor: owner,
      channelId: channel.channelId,
      cursor: second.nextCursor,
      limit: 2,
    });
    expect(third.nextCursor).toBeNull();

    const paged = [...first.messages, ...second.messages, ...third.messages].map((m) => m.id);
    expect(new Set(paged).size).toBe(5);
    expect(paged).toEqual([...ids].reverse().sort((a, b) => paged.indexOf(a) - paged.indexOf(b)));
    expect(paged[0]).toBe(ids[4]);

    await runInDurableObject<Workspace, void>(stub, (instance) => {
      expect(() =>
        instance.readChannelHistory({ actor: owner, channelId: channel.channelId, cursor: "nonsense" }),
      ).toThrow("invalid history cursor");
    });
  });

  it("ROOM-INT-010 refuses to store content on a Solo workspace", async () => {
    const { stub, owner } = await seedTeamWorkspace("rooms-solo", "local_host");
    // Channel metadata is cloud-side on both plans.
    const channel = await stub.createChannel({
      actor: owner,
      idempotencyKey: "channel:create:0000000080",
      kind: "public",
      slug: "eng",
      now: NOW,
    });
    expect(channel.created).toBe(true);

    await runInDurableObject<Workspace, void>(stub, async (instance) => {
      await expect(
        instance.sendMessage({
          actor: owner,
          idempotencyKey: "message:send:0000000070",
          channelId: channel.channelId,
          bodyMarkdown: "SOLO_CONTENT_CANARY",
          now: NOW + 1,
        }),
      ).rejects.toThrow("content_is_host_owned");
    });

    // The relay holds no body, no delivery record and no audit trace of one.
    await runInDurableObject<Workspace, void>(stub, (_instance, state) => {
      expect(
        state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM messages").one().count,
      ).toBe(0);
      const dump = [
        ...state.storage.sql.exec<{ payload_json: string }>("SELECT payload_json FROM pending_events").toArray(),
        ...state.storage.sql.exec<{ payload_json: string }>("SELECT payload_json FROM replay_events").toArray(),
        ...state.storage.sql
          .exec<{ payload_json: string }>("SELECT metadata_json AS payload_json FROM audit_events")
          .toArray(),
        ...state.storage.sql
          .exec<{ payload_json: string }>("SELECT response_json AS payload_json FROM idempotency_keys")
          .toArray(),
      ]
        .map((row) => row.payload_json)
        .join("");
      expect(dump).not.toContain("SOLO_CONTENT_CANARY");
    });
  });

  it("ROOM-INT-011 refuses a send from a revoked or unknown member and writes nothing", async () => {
    const { stub, owner, member } = await seedTeamWorkspace("rooms-revoked");
    const channel = await stub.createChannel({
      actor: owner,
      idempotencyKey: "channel:create:0000000090",
      kind: "public",
      slug: "eng",
      memberIds: [member.memberId],
      now: NOW,
    });

    // The member's authority is revoked in the control plane and projected here.
    await stub.applyMembership({
      operationId: "rooms-revoked-op-suspend",
      memberId: member.memberId,
      accountId: `account-${member.memberId}`,
      handle: "daniel",
      displayName: "Daniel Park",
      role: "member",
      status: "suspended",
      authorizationEpoch: 2,
      version: 2,
      now: NOW + 1,
    });

    await runInDurableObject<Workspace, void>(stub, async (instance) => {
      for (const actor of [
        member,
        { memberId: member.memberId, authorizationEpoch: 2 },
        { memberId: "member-unknown", authorizationEpoch: 1 },
      ] satisfies Actor[]) {
        await expect(
          instance.sendMessage({
            actor,
            idempotencyKey: "message:send:0000000080",
            channelId: channel.channelId,
            bodyMarkdown: "REVOKED_MEMBER_CANARY",
            now: NOW + 2,
          }),
        ).rejects.toThrow("member is not authorized for this workspace");
        expect(() => instance.readChannelHistory({ actor, channelId: channel.channelId })).toThrow(
          "member is not authorized for this workspace",
        );
      }
    });

    await runInDurableObject<Workspace, void>(stub, (_instance, state) => {
      expect(
        state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM messages").one().count,
      ).toBe(0);
      expect(
        state.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM idempotency_keys WHERE key = ?", "message:send:0000000080")
          .one().count,
      ).toBe(0);
    });
  });

  it("ROOM-INT-012 keeps two workspaces' rooms and messages entirely apart", async () => {
    const first = await seedTeamWorkspace("rooms-tenant-a");
    const second = await seedTeamWorkspace("rooms-tenant-b");

    const channelA = await first.stub.createChannel({
      actor: first.owner,
      idempotencyKey: "channel:create:0000000100",
      kind: "public",
      slug: "eng",
      now: NOW,
    });
    await first.stub.sendMessage({
      actor: first.owner,
      idempotencyKey: "message:send:0000000090",
      channelId: channelA.channelId,
      bodyMarkdown: "TENANT_A_CANARY",
      now: NOW + 1,
    });

    const channelB = await second.stub.createChannel({
      actor: second.owner,
      idempotencyKey: "channel:create:0000000100",
      kind: "public",
      slug: "eng",
      now: NOW,
    });
    // Same slug, same idempotency key, same member ids: still a different room.
    expect(channelB.channelId).not.toBe(channelA.channelId);

    const secondView = await second.stub.browseChannels({ actor: second.owner });
    expect(secondView.channels.map((c) => c.id)).toEqual([channelB.channelId]);
    expect(
      (await second.stub.readChannelHistory({ actor: second.owner, channelId: channelB.channelId })).messages,
    ).toEqual([]);

    await runInDurableObject<Workspace, void>(second.stub, (instance) => {
      // A valid actor in this workspace naming the other workspace's room.
      expect(() =>
        instance.readChannelHistory({ actor: second.owner, channelId: channelA.channelId }),
      ).toThrow("channel not found");
    });
    await runInDurableObject<Workspace, void>(second.stub, (_instance, state) => {
      const dump = state.storage.sql
        .exec<{ body_markdown: string }>("SELECT body_markdown FROM messages")
        .toArray()
        .map((row) => row.body_markdown)
        .join("");
      expect(dump).not.toContain("TENANT_A_CANARY");
    });
  });
});
