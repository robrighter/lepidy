import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Actor, Workspace } from "../src/cloudflare/workspace";

const NOW = 1_800_000_000_000;

async function seed(name: string) {
  const stub = env.WORKSPACE.getByName(name);
  await stub.initializeWorkspace({ storageMode: "cloud", hostEpoch: 0, routingEpoch: 1, now: NOW });
  for (const [index, memberId, handle] of [[0, "owner", "maya"], [1, "member", "daniel"], [2, "outsider", "priya"]] as const) {
    await stub.applyMembership({
      operationId: `${name}:${memberId}`, memberId, accountId: `account-${memberId}`, handle,
      displayName: handle, role: index === 0 ? "owner" : "member", status: "active",
      authorizationEpoch: 1, version: 1, now: NOW,
    });
  }
  const owner: Actor = { memberId: "owner", authorizationEpoch: 1 };
  const member: Actor = { memberId: "member", authorizationEpoch: 1 };
  const outsider: Actor = { memberId: "outsider", authorizationEpoch: 1 };
  const channel = await stub.createChannel({
    actor: owner, idempotencyKey: `${name}:channel:0001`, kind: "public", slug: "eng",
    memberIds: [member.memberId], now: NOW,
  });
  return { stub, owner, member, outsider, channelId: channel.channelId };
}

describe("notification activity", () => {
  it("C06-INT-001 creates one visible mention, keeps badge arithmetic exact, and toggles read state", async () => {
    const seeded = await seed("c06-mention");
    await seeded.stub.sendMessage({
      actor: seeded.owner, idempotencyKey: "c06:mention:message:0001", channelId: seeded.channelId,
      bodyMarkdown: "@daniel the release needs you", now: NOW + 1,
    });
    const first = await seeded.stub.listNotificationActivity({ actor: seeded.member });
    expect(first.unread).toEqual({ total: 1, mentions: 1, threads: 0, dms: 0 });
    expect(first.items[0]).toMatchObject({ kind: "mention", bodyMarkdown: "@daniel the release needs you", badge: true, pushAllowed: true });
    expect((await seeded.stub.listNotificationActivity({ actor: seeded.outsider })).items).toEqual([]);

    await seeded.stub.markNotification({ actor: seeded.member, notificationId: first.items[0].id, unread: false, now: NOW + 2 });
    expect((await seeded.stub.listNotificationActivity({ actor: seeded.member, unreadOnly: true })).items).toEqual([]);
    await seeded.stub.markNotification({ actor: seeded.member, notificationId: first.items[0].id, unread: true, now: NOW + 3 });
    expect((await seeded.stub.listNotificationActivity({ actor: seeded.member, unreadOnly: true })).unread.total).toBe(1);

    for (let index = 0; index < 54; index += 1) {
      await seeded.stub.sendMessage({
        actor: seeded.owner,
        idempotencyKey: `c06:mention:overflow:${String(index).padStart(4, "0")}`,
        channelId: seeded.channelId,
        bodyMarkdown: `@daniel follow-up ${index}`,
        now: NOW + 10 + index,
      });
    }
    const bounded = await seeded.stub.listNotificationActivity({
      actor: seeded.member,
      unreadOnly: true,
      limit: 10,
    });
    expect(bounded.items).toHaveLength(10);
    expect(bounded.unread).toMatchObject({ total: 55, mentions: 55 });
  });

  it("C06-INT-002 applies DND, keywords, subscriptions and private-item filtering at the workspace boundary", async () => {
    const seeded = await seed("c06-policy");
    await seeded.stub.configureNotifications({
      actor: seeded.member, channelId: seeded.channelId, notifyLevel: "mentions", now: NOW,
    });
    await seeded.stub.configureNotifications({
      actor: seeded.member, keywords: ["incident"], dndStartMinute: 0, dndEndMinute: 1439, now: NOW,
    });
    await seeded.stub.sendMessage({
      actor: seeded.owner, idempotencyKey: "c06:keyword:message:0001", channelId: seeded.channelId,
      bodyMarkdown: "Incident review is ready", now: NOW + 60_000,
    });
    let activity = await seeded.stub.listNotificationActivity({ actor: seeded.member });
    expect(activity.items[0]).toMatchObject({ kind: "keyword", pushAllowed: false });

    const root = await seeded.stub.sendMessage({
      actor: seeded.owner, idempotencyKey: "c06:thread:root:00000001", channelId: seeded.channelId,
      bodyMarkdown: "Thread root", now: NOW + 120_000,
    });
    await seeded.stub.setThreadSubscription({ actor: seeded.member, threadRootId: root.messageId, subscribed: true, now: NOW + 121_000 });
    await seeded.stub.sendMessage({
      actor: seeded.owner, idempotencyKey: "c06:thread:reply:0000001", channelId: seeded.channelId,
      threadParentId: root.messageId, bodyMarkdown: "A subscribed reply", now: NOW + 122_000,
    });
    activity = await seeded.stub.listNotificationActivity({ actor: seeded.member });
    expect(activity.items.some((item) => item.kind === "thread_reply")).toBe(true);

    const hiddenId = activity.items.find((item) => item.kind === "thread_reply")!.id;
    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE notifications SET private_item = 1, allowed_member_ids_json = '[]' WHERE id = ?", hiddenId,
      );
    });
    const filtered = await seeded.stub.listNotificationActivity({ actor: seeded.member });
    expect(filtered.items.some((item) => item.id === hiddenId)).toBe(false);
    expect(filtered.unread.total).toBe(filtered.items.filter((item) => item.readAt === null && item.badge).length);
  });

  it("C06-INT-003 refuses broadcasts until the authorized sender confirms the exact audience", async () => {
    const seeded = await seed("c06-broadcast");
    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      await expect(instance.sendMessage({
        actor: seeded.member, idempotencyKey: "c06:broadcast:denied:0001", channelId: seeded.channelId,
        bodyMarkdown: "@channel deploy now", confirmedBroadcastRecipients: 1, now: NOW + 1,
      })).rejects.toThrow("broadcast requires permission");
      await expect(instance.sendMessage({
        actor: seeded.owner, idempotencyKey: "c06:broadcast:wrong:000001", channelId: seeded.channelId,
        bodyMarkdown: "@channel deploy now", confirmedBroadcastRecipients: 2, now: NOW + 2,
      })).rejects.toThrow("confirmation for 1 recipients");
    });
    await expect(seeded.stub.sendMessage({
      actor: seeded.owner, idempotencyKey: "c06:broadcast:allowed:0001", channelId: seeded.channelId,
      bodyMarkdown: "@channel deploy now", confirmedBroadcastRecipients: 1, now: NOW + 3,
    })).resolves.toMatchObject({ channelId: seeded.channelId });
    expect(await seeded.stub.listNotificationActivity({ actor: seeded.member })).toMatchObject({
      unread: { total: 1 },
      items: [{ kind: "channel", badge: true, pushAllowed: true }],
    });
  });
});
