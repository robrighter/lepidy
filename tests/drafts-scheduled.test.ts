import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Actor, Workspace } from "../src/cloudflare/workspace";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

type Seeded = {
  stub: DurableObjectStub<Workspace>;
  owner: Actor;
  member: Actor;
  outsider: Actor;
  channelId: string;
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

describe("synced drafts", () => {
  it("DRAFT-INT-001 keeps one draft per member per surface and follows them between devices", async () => {
    const seeded = await seed("drafts-sync");

    const first = await seeded.stub.saveDraft({
      actor: seeded.owner,
      channelId: seeded.channelId,
      bodyMarkdown: "half a thought",
      now: NOW + 1,
    });
    expect(first).toMatchObject({ status: "saved", draft: { revision: 1 } });

    // A second device reads what the first one typed.
    await expect(
      seeded.stub.getDraft({ actor: seeded.owner, channelId: seeded.channelId }),
    ).resolves.toMatchObject({ draft: { bodyMarkdown: "half a thought", revision: 1 } });

    // A draft is private to its author.
    await expect(
      seeded.stub.getDraft({ actor: seeded.member, channelId: seeded.channelId }),
    ).resolves.toEqual({ draft: null });

    const second = await seeded.stub.saveDraft({
      actor: seeded.owner,
      channelId: seeded.channelId,
      bodyMarkdown: "half a thought, finished",
      baseRevision: 1,
      now: NOW + 2,
    });
    expect(second).toMatchObject({ status: "saved", draft: { revision: 2 } });

    // Clearing removes it rather than storing an empty one.
    await expect(
      seeded.stub.saveDraft({
        actor: seeded.owner,
        channelId: seeded.channelId,
        bodyMarkdown: "   ",
        baseRevision: 2,
        now: NOW + 3,
      }),
    ).resolves.toEqual({ status: "cleared", draft: null });
    await expect(
      seeded.stub.getDraft({ actor: seeded.owner, channelId: seeded.channelId }),
    ).resolves.toEqual({ draft: null });
  });

  it("DRAFT-INT-002 refuses to overwrite a draft another device has moved on", async () => {
    const seeded = await seed("drafts-conflict");
    await seeded.stub.saveDraft({
      actor: seeded.owner,
      channelId: seeded.channelId,
      bodyMarkdown: "from the laptop",
      now: NOW + 1,
    });
    // The phone saves next, so the stored revision moves to 2.
    await seeded.stub.saveDraft({
      actor: seeded.owner,
      channelId: seeded.channelId,
      bodyMarkdown: "from the phone",
      baseRevision: 1,
      now: NOW + 2,
    });

    // The laptop, still editing from revision 1, is refused rather than winning.
    const conflict = await seeded.stub.saveDraft({
      actor: seeded.owner,
      channelId: seeded.channelId,
      bodyMarkdown: "the laptop's stale text",
      baseRevision: 1,
      now: NOW + 3,
    });
    expect(conflict.status).toBe("conflict");
    expect(conflict.draft).toMatchObject({ bodyMarkdown: "from the phone", revision: 2 });

    // What is stored is still the phone's text, untouched.
    await expect(
      seeded.stub.getDraft({ actor: seeded.owner, channelId: seeded.channelId }),
    ).resolves.toMatchObject({ draft: { bodyMarkdown: "from the phone", revision: 2 } });

    // Rebasing on what is actually there succeeds.
    await expect(
      seeded.stub.saveDraft({
        actor: seeded.owner,
        channelId: seeded.channelId,
        bodyMarkdown: "merged by hand",
        baseRevision: 2,
        now: NOW + 4,
      }),
    ).resolves.toMatchObject({ status: "saved", draft: { revision: 3 } });
  });

  it("DRAFT-INT-003 keeps a thread's draft separate from its room's", async () => {
    const seeded = await seed("drafts-thread");
    const root = await seeded.stub.sendMessage({
      actor: seeded.owner,
      idempotencyKey: "message:send:draft0000001",
      channelId: seeded.channelId,
      bodyMarkdown: "why is the build red?",
      now: NOW + 1,
    });

    await seeded.stub.saveDraft({
      actor: seeded.owner,
      channelId: seeded.channelId,
      bodyMarkdown: "channel level",
      now: NOW + 2,
    });
    await seeded.stub.saveDraft({
      actor: seeded.owner,
      channelId: seeded.channelId,
      threadRootId: root.messageId,
      bodyMarkdown: "thread level",
      now: NOW + 3,
    });

    await expect(
      seeded.stub.getDraft({ actor: seeded.owner, channelId: seeded.channelId }),
    ).resolves.toMatchObject({ draft: { bodyMarkdown: "channel level" } });
    await expect(
      seeded.stub.getDraft({
        actor: seeded.owner,
        channelId: seeded.channelId,
        threadRootId: root.messageId,
      }),
    ).resolves.toMatchObject({ draft: { bodyMarkdown: "thread level" } });

    await runInDurableObject<Workspace, void>(seeded.stub, (instance) => {
      // A thread key must name a real root in that same room.
      expect(() =>
        instance.saveDraft({
          actor: seeded.owner,
          channelId: seeded.channelId,
          threadRootId: "message-does-not-exist",
          bodyMarkdown: "nowhere",
          now: NOW + 4,
        }),
      ).toThrow("thread not found");
    });
  });

  it("DRAFT-INT-004 refuses a room the member cannot post in and withholds one they left", async () => {
    const seeded = await seed("drafts-visibility");
    const closed = await seeded.stub.createChannel({
      actor: seeded.owner,
      idempotencyKey: "channel:create:design:0001",
      kind: "private",
      slug: "design",
      memberIds: [seeded.member.memberId],
      now: NOW,
    });

    await runInDurableObject<Workspace, void>(seeded.stub, (instance) => {
      // Not in the room at all: missing, not forbidden.
      expect(() =>
        instance.saveDraft({
          actor: seeded.outsider,
          channelId: closed.channelId,
          bodyMarkdown: "DRAFT_CANARY",
          now: NOW + 1,
        }),
      ).toThrow("channel not found");
      // Can see the open room but has not joined it.
      expect(() =>
        instance.saveDraft({
          actor: seeded.outsider,
          channelId: seeded.channelId,
          bodyMarkdown: "DRAFT_CANARY",
          now: NOW + 2,
        }),
      ).toThrow("join this room before posting in it");
    });

    await seeded.stub.saveDraft({
      actor: seeded.member,
      channelId: closed.channelId,
      bodyMarkdown: "written while inside",
      now: NOW + 3,
    });
    expect((await seeded.stub.listDrafts({ actor: seeded.member })).drafts).toHaveLength(1);

    // Leaving the room withholds the draft left behind in it.
    await seeded.stub.leaveChannel({
      actor: seeded.member,
      channelId: closed.channelId,
      now: NOW + 4,
    });
    const after = await seeded.stub.listDrafts({ actor: seeded.member });
    expect(after.drafts).toEqual([]);
    expect(after.unavailable).toBe(1);
    expect(JSON.stringify(after)).not.toContain("written while inside");
  });

  it("DRAFT-INT-005 refuses to store a draft on a Solo workspace", async () => {
    const seeded = await seed("drafts-solo", "local_host");
    await runInDurableObject<Workspace, void>(seeded.stub, (instance) => {
      expect(() =>
        instance.saveDraft({
          actor: seeded.owner,
          channelId: seeded.channelId,
          bodyMarkdown: "SOLO_DRAFT_CANARY",
          now: NOW + 1,
        }),
      ).toThrow("content_is_host_owned");
    });
    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      expect(
        state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM message_drafts").one().n,
      ).toBe(0);
    });
  });
});

describe("scheduled messages", () => {
  it("SCHED-MSG-INT-001 sends at its time, once, and only once", async () => {
    const seeded = await seed("scheduled-send");
    const scheduled = await seeded.stub.scheduleMessage({
      actor: seeded.owner,
      idempotencyKey: "message:schedule:00000001",
      channelId: seeded.channelId,
      bodyMarkdown: "the release notes are up",
      sendAt: NOW + 10 * MINUTE,
      now: NOW,
    });

    // Nothing is posted before its time.
    expect(
      (await seeded.stub.runDueWork(NOW + MINUTE)).scheduledSends,
    ).toEqual({ sent: 0, failed: 0 });
    expect(
      (await seeded.stub.readChannelHistory({ actor: seeded.owner, channelId: seeded.channelId }))
        .messages,
    ).toEqual([]);

    const report = await seeded.stub.runDueWork(NOW + 10 * MINUTE);
    expect(report.scheduledSends).toEqual({ sent: 1, failed: 0 });

    const history = await seeded.stub.readChannelHistory({
      actor: seeded.owner,
      channelId: seeded.channelId,
    });
    expect(history.messages).toHaveLength(1);
    expect(history.messages[0].bodyMarkdown).toBe("the release notes are up");

    // A duplicate alarm must not post it a second time.
    expect((await seeded.stub.runDueWork(NOW + 20 * MINUTE)).scheduledSends).toEqual({
      sent: 0,
      failed: 0,
    });
    expect(
      (await seeded.stub.readChannelHistory({ actor: seeded.owner, channelId: seeded.channelId }))
        .messages,
    ).toHaveLength(1);

    const listed = await seeded.stub.listScheduledMessages({ actor: seeded.owner });
    expect(listed.scheduled[0]).toMatchObject({
      id: scheduled.id,
      status: "sent",
      sentMessageId: history.messages[0].id,
    });
  });

  it("SCHED-MSG-INT-002 survives an eviction and still fires from durable state", async () => {
    const seeded = await seed("scheduled-restart");
    await seeded.stub.scheduleMessage({
      actor: seeded.owner,
      idempotencyKey: "message:schedule:00000010",
      channelId: seeded.channelId,
      bodyMarkdown: "posted after a restart",
      sendAt: NOW + 5 * MINUTE,
      now: NOW,
    });

    // Tear the instance down; only durable rows survive.
    await evictDurableObject(seeded.stub);

    const report = await seeded.stub.runDueWork(NOW + 5 * MINUTE);
    expect(report.scheduledSends).toEqual({ sent: 1, failed: 0 });
    expect(
      (await seeded.stub.readChannelHistory({ actor: seeded.owner, channelId: seeded.channelId }))
        .messages[0].bodyMarkdown,
    ).toBe("posted after a restart");
  });

  it("SCHED-MSG-INT-003 rechecks authority at the send time, not the scheduling time", async () => {
    const seeded = await seed("scheduled-authority");
    const left = await seeded.stub.scheduleMessage({
      actor: seeded.member,
      idempotencyKey: "message:schedule:00000020",
      channelId: seeded.channelId,
      bodyMarkdown: "AUTHORITY_CANARY_LEFT",
      sendAt: NOW + 5 * MINUTE,
      now: NOW,
    });

    // Between scheduling and sending, the author leaves the room.
    await seeded.stub.leaveChannel({
      actor: seeded.member,
      channelId: seeded.channelId,
      now: NOW + MINUTE,
    });

    const report = await seeded.stub.runDueWork(NOW + 5 * MINUTE);
    expect(report.scheduledSends).toEqual({ sent: 0, failed: 1 });

    const listed = await seeded.stub.listScheduledMessages({ actor: seeded.member });
    expect(listed.scheduled[0]).toMatchObject({
      id: left.id,
      status: "failed",
      failureReason: "author is no longer in the channel",
    });
    // Nothing was posted in their name.
    const history = await seeded.stub.readChannelHistory({
      actor: seeded.owner,
      channelId: seeded.channelId,
    });
    expect(JSON.stringify(history)).not.toContain("AUTHORITY_CANARY_LEFT");
  });

  it("SCHED-MSG-INT-004 refuses to send for a suspended author or into an archived room", async () => {
    const seeded = await seed("scheduled-refusals");
    await seeded.stub.scheduleMessage({
      actor: seeded.member,
      idempotencyKey: "message:schedule:00000030",
      channelId: seeded.channelId,
      bodyMarkdown: "SUSPENDED_CANARY",
      sendAt: NOW + 5 * MINUTE,
      now: NOW,
    });
    await seeded.stub.applyMembership({
      operationId: "scheduled-refusals-suspend",
      memberId: seeded.member.memberId,
      accountId: `account-${seeded.member.memberId}`,
      handle: "daniel",
      displayName: "Daniel Park",
      role: "member",
      status: "suspended",
      authorizationEpoch: 2,
      version: 2,
      now: NOW + MINUTE,
    });

    expect((await seeded.stub.runDueWork(NOW + 5 * MINUTE)).scheduledSends).toEqual({
      sent: 0,
      failed: 1,
    });
    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      const row = state.storage.sql
        .exec<{ status: string; failure_reason: string }>(
          "SELECT status, failure_reason FROM scheduled_messages",
        )
        .one();
      expect(row).toEqual({
        status: "failed",
        failure_reason: "author is no longer an active member",
      });
      const bodies = state.storage.sql
        .exec<{ body_markdown: string }>("SELECT body_markdown FROM messages")
        .toArray()
        .map((entry) => entry.body_markdown)
        .join("");
      expect(bodies).not.toContain("SUSPENDED_CANARY");
    });

    // An archived room refuses too.
    const archived = await seed("scheduled-archived");
    await archived.stub.scheduleMessage({
      actor: archived.owner,
      idempotencyKey: "message:schedule:00000031",
      channelId: archived.channelId,
      bodyMarkdown: "ARCHIVED_CANARY",
      sendAt: NOW + 5 * MINUTE,
      now: NOW,
    });
    await archived.stub.archiveChannel({
      actor: archived.owner,
      channelId: archived.channelId,
      now: NOW + MINUTE,
    });
    expect((await archived.stub.runDueWork(NOW + 5 * MINUTE)).scheduledSends).toEqual({
      sent: 0,
      failed: 1,
    });
    expect(
      (await archived.stub.listScheduledMessages({ actor: archived.owner })).scheduled[0],
    ).toMatchObject({ status: "failed", failureReason: "channel was archived before the send time" });
  });

  it("SCHED-MSG-INT-005 edits and cancels before the time, and refuses afterwards", async () => {
    const seeded = await seed("scheduled-edit");
    const first = await seeded.stub.scheduleMessage({
      actor: seeded.owner,
      idempotencyKey: "message:schedule:00000040",
      channelId: seeded.channelId,
      bodyMarkdown: "first wording",
      sendAt: NOW + 10 * MINUTE,
      now: NOW,
    });

    await expect(
      seeded.stub.updateScheduledMessage({
        actor: seeded.owner,
        id: first.id,
        bodyMarkdown: "better wording",
        sendAt: NOW + 20 * MINUTE,
        now: NOW + MINUTE,
      }),
    ).resolves.toMatchObject({ updated: true, sendAt: NOW + 20 * MINUTE });

    // The original time passes and nothing is sent, because it moved.
    expect((await seeded.stub.runDueWork(NOW + 10 * MINUTE)).scheduledSends).toEqual({
      sent: 0,
      failed: 0,
    });

    const second = await seeded.stub.scheduleMessage({
      actor: seeded.owner,
      idempotencyKey: "message:schedule:00000041",
      channelId: seeded.channelId,
      bodyMarkdown: "CANCELLED_CANARY",
      sendAt: NOW + 30 * MINUTE,
      now: NOW,
    });
    await expect(
      seeded.stub.cancelScheduledMessage({ actor: seeded.owner, id: second.id, now: NOW + MINUTE }),
    ).resolves.toEqual({ cancelled: true });

    expect((await seeded.stub.runDueWork(NOW + 40 * MINUTE)).scheduledSends).toEqual({
      sent: 1,
      failed: 0,
    });
    const history = await seeded.stub.readChannelHistory({
      actor: seeded.owner,
      channelId: seeded.channelId,
    });
    expect(history.messages).toHaveLength(1);
    expect(history.messages[0].bodyMarkdown).toBe("better wording");
    expect(JSON.stringify(history)).not.toContain("CANCELLED_CANARY");

    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      // A settled message can no longer be edited or cancelled.
      await expect(
        instance.updateScheduledMessage({
          actor: seeded.owner,
          id: first.id,
          bodyMarkdown: "too late",
          now: NOW + 41 * MINUTE,
        }),
      ).rejects.toThrow("already been settled");
      await expect(
        instance.cancelScheduledMessage({ actor: seeded.owner, id: second.id, now: NOW + 41 * MINUTE }),
      ).rejects.toThrow("already been settled");
    });
  });

  it("SCHED-MSG-INT-006 keeps one member's scheduled messages out of another's reach", async () => {
    const seeded = await seed("scheduled-private");
    const mine = await seeded.stub.scheduleMessage({
      actor: seeded.owner,
      idempotencyKey: "message:schedule:00000050",
      channelId: seeded.channelId,
      bodyMarkdown: "OTHERS_CANARY",
      sendAt: NOW + 10 * MINUTE,
      now: NOW,
    });

    // Somebody else's scheduled message is not listed and not addressable.
    await expect(
      seeded.stub.listScheduledMessages({ actor: seeded.member }),
    ).resolves.toEqual({ scheduled: [] });
    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      await expect(
        instance.cancelScheduledMessage({ actor: seeded.member, id: mine.id, now: NOW + MINUTE }),
      ).rejects.toThrow("scheduled message not found");
      await expect(
        instance.updateScheduledMessage({
          actor: seeded.member,
          id: mine.id,
          bodyMarkdown: "not yours",
          now: NOW + MINUTE,
        }),
      ).rejects.toThrow("scheduled message not found");
    });
  });

  it("SCHED-MSG-INT-007 refuses a time in the past, too far ahead, or on a Solo workspace", async () => {
    const seeded = await seed("scheduled-bounds");
    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      for (const sendAt of [NOW, NOW - MINUTE]) {
        await expect(
          instance.scheduleMessage({
            actor: seeded.owner,
            idempotencyKey: "message:schedule:00000060",
            channelId: seeded.channelId,
            bodyMarkdown: "backwards",
            sendAt,
            now: NOW,
          }),
        ).rejects.toThrow("send time must be in the future");
      }
      await expect(
        instance.scheduleMessage({
          actor: seeded.owner,
          idempotencyKey: "message:schedule:00000061",
          channelId: seeded.channelId,
          bodyMarkdown: "far too far",
          sendAt: NOW + 400 * 24 * 60 * MINUTE,
          now: NOW,
        }),
      ).rejects.toThrow("send time is too far ahead");
    });

    const solo = await seed("scheduled-solo", "local_host");
    await runInDurableObject<Workspace, void>(solo.stub, async (instance) => {
      await expect(
        instance.scheduleMessage({
          actor: solo.owner,
          idempotencyKey: "message:schedule:00000062",
          channelId: solo.channelId,
          bodyMarkdown: "SOLO_SCHEDULE_CANARY",
          sendAt: NOW + 5 * MINUTE,
          now: NOW,
        }),
      ).rejects.toThrow("content_is_host_owned");
    });
    await runInDurableObject<Workspace, void>(solo.stub, (_instance, state) => {
      expect(
        state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM scheduled_messages").one().n,
      ).toBe(0);
    });
  });
});
