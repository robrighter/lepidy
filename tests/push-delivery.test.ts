import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Actor, Workspace } from "../src/cloudflare/workspace";
import { encodeBase64Url } from "../src/domain/web-push";

const NOW = 1_800_000_000_000;

async function seed(name: string) {
  const stub = env.WORKSPACE.getByName(name);
  await stub.initializeWorkspace({ storageMode: "cloud", hostEpoch: 0, routingEpoch: 1, now: NOW });
  for (const [index, memberId, handle] of [
    [0, "owner", "maya"],
    [1, "member", "daniel"],
    [2, "outsider", "priya"],
  ] as const) {
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

/** A real subscription: the keys have to be real or validation refuses them. */
async function browserSubscription(endpoint: string) {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  return {
    endpoint,
    p256dh: encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
    auth: encodeBase64Url(crypto.getRandomValues(new Uint8Array(16))),
  };
}

describe("web push delivery", () => {
  it("PUSH-INT-005 keeps one row per browser and moves an endpoint to whoever is signed in", async () => {
    const seeded = await seed("push-subscriptions");
    const laptop = await browserSubscription("https://push.example.test/f/laptop");
    const phone = await browserSubscription("https://push.example.test/f/phone");

    // Somebody signed in on two devices has two: an approval has to reach
    // whichever one they are actually holding.
    await seeded.stub.subscribeToPush({ actor: seeded.member, ...laptop, now: NOW });
    await seeded.stub.subscribeToPush({ actor: seeded.member, ...phone, now: NOW + 1 });
    // The same browser refreshing its subscription replaces its row rather than
    // accumulating a dead endpoint that fails forever.
    await seeded.stub.subscribeToPush({ actor: seeded.member, ...laptop, now: NOW + 2 });

    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      const rows = state.storage.sql
        .exec<{ endpoint: string; member_id: string }>(
          "SELECT endpoint, member_id FROM push_subscriptions ORDER BY endpoint",
        )
        .toArray();
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.member_id === "member")).toBe(true);
    });

    // A shared machine: the same browser, a different person signed in. Leaving
    // the endpoint attached to the first would send them somebody else's
    // notifications.
    await seeded.stub.subscribeToPush({ actor: seeded.outsider, ...laptop, now: NOW + 3 });
    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      const row = state.storage.sql
        .exec<{ member_id: string }>("SELECT member_id FROM push_subscriptions WHERE endpoint = ?", laptop.endpoint)
        .one();
      expect(row.member_id).toBe("outsider");
    });

    // Unsubscribing is idempotent: a request to stop being notified must not
    // fail because it had already been carried out.
    await seeded.stub.unsubscribeFromPush({ actor: seeded.member, endpoint: phone.endpoint });
    const again = await seeded.stub.unsubscribeFromPush({ actor: seeded.member, endpoint: phone.endpoint });
    expect(again.removed).toBe(0);
    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      expect(
        state.storage.sql.exec("SELECT endpoint FROM push_subscriptions").toArray(),
      ).toHaveLength(1);
    });
  });

  it("PUSH-INT-006 renders a notification under the viewer's authority, not the sender's", async () => {
    const seeded = await seed("push-render");
    const sent = await seeded.stub.sendMessage({
      actor: seeded.owner, idempotencyKey: "push:render:0001", channelId: seeded.channelId,
      bodyMarkdown: "@daniel the release needs you", now: NOW + 1,
    });

    const forMember = await seeded.stub.renderNotification({
      actor: seeded.member, kind: "message", id: sent.messageId, now: NOW + 2,
    });
    expect(forMember).not.toBeNull();
    expect(forMember?.title).toContain("#eng");
    expect(forMember?.body).toBe("@daniel the release needs you");
    expect(forMember?.path).toBe("/c/eng");

    // Somebody who cannot see the room gets nothing, and gets it as "nothing to
    // show" rather than as a refusal: telling them it exists is the leak. A
    // private room is the case that matters — #eng is public, and every member
    // may see a public room, which is why the negative case cannot use one.
    const closed = await seeded.stub.createChannel({
      actor: seeded.owner, idempotencyKey: "push:render:private:0001", kind: "private",
      slug: "incident", memberIds: [seeded.member.memberId], now: NOW + 2,
    });
    const secret = await seeded.stub.sendMessage({
      actor: seeded.owner, idempotencyKey: "push:render:private:0002", channelId: closed.channelId,
      bodyMarkdown: "the incident bridge is open", now: NOW + 3,
    });
    expect(
      await seeded.stub.renderNotification({
        actor: seeded.member, kind: "message", id: secret.messageId, now: NOW + 4,
      }),
    ).not.toBeNull();
    expect(
      await seeded.stub.renderNotification({
        actor: seeded.outsider, kind: "message", id: secret.messageId, now: NOW + 4,
      }),
    ).toBeNull();

    // A deleted message stops being renderable. This is the case the whole
    // metadata-only payload exists for: the push already went out, and what the
    // device may display is decided now.
    await seeded.stub.deleteMessage({
      actor: seeded.owner, messageId: sent.messageId, now: NOW + 3,
    });
    expect(
      await seeded.stub.renderNotification({
        actor: seeded.member, kind: "message", id: sent.messageId, now: NOW + 4,
      }),
    ).toBeNull();
  });

  it("PUSH-INT-007 sanitises a preview before it reaches a lock screen", async () => {
    const seeded = await seed("push-sanitise");
    // A bidirectional override reorders the characters around it wherever it is
    // rendered, so a message body can rewrite how the title beside it reads.
    // Newlines push the part somebody needed out of view, and a control
    // character is not text at all.
    const hostile = `@daniel first line\nsecond\u202Eline\u0007  ${"\u3084".repeat(400)}`;
    const sent = await seeded.stub.sendMessage({
      actor: seeded.owner,
      idempotencyKey: "push:sanitise:0001",
      channelId: seeded.channelId,
      bodyMarkdown: hostile,
      now: NOW + 1,
    });
    const rendered = await seeded.stub.renderNotification({
      actor: seeded.member, kind: "message", id: sent.messageId, now: NOW + 2,
    });
    expect(rendered?.body).not.toContain("\n");
    expect(rendered?.body).not.toContain("\u202E");
    expect(rendered?.body).not.toContain("\u0007");
    // Counted in characters, so a multi-byte preview is not cut to a third of a
    // Latin one, and no cut lands inside a character.
    expect([...(rendered?.body ?? "")].length).toBe(160);
    expect(rendered?.body?.endsWith("\u2026")).toBe(true);
  });

  it("PUSH-INT-008 reports a deployment with no push key instead of retrying forever", async () => {
    const seeded = await seed("push-unconfigured");
    await seeded.stub.subscribeToPush({
      actor: seeded.member,
      ...(await browserSubscription("https://push.example.test/f/laptop")),
      now: NOW,
    });
    await seeded.stub.sendMessage({
      actor: seeded.owner, idempotencyKey: "push:unconfigured:0001", channelId: seeded.channelId,
      bodyMarkdown: "@daniel look", now: NOW + 1,
    });

    // No VAPID key is bound in this test environment, which is the state every
    // development deployment is in. A retry loop would fill the outbox with
    // work that cannot succeed, and reporting delivered would hide it, so the
    // entry dies with a reason somebody can read.
    const drained = await seeded.stub.drainOutbox(NOW + 2);
    expect(drained.attempted).toBeGreaterThan(0);
    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      const row = state.storage.sql
        .exec<{ status: string; last_error: string | null }>(
          "SELECT status, last_error FROM pending_events WHERE kind = 'notification_push'",
        )
        .toArray()[0];
      expect(row?.status).toBe("dead");
      expect(row?.last_error).toContain("not configured");
    });
  });

  it("PUSH-INT-009 sends nothing at all for a member with no browser registered", async () => {
    const seeded = await seed("push-nobody");
    await seeded.stub.sendMessage({
      actor: seeded.owner, idempotencyKey: "push:nobody:0001", channelId: seeded.channelId,
      bodyMarkdown: "@daniel look", now: NOW + 1,
    });
    // Nothing to deliver is not a failure of the event, and must not be one:
    // most members never register a browser, and an outbox that retried each of
    // them would never drain.
    let attempted = 0;
    const drained = await seeded.stub.drainOutbox(NOW + 2, async (entry) => {
      if (entry.kind !== "notification_push") return { status: "delivered" };
      attempted += 1;
      return { status: "delivered" };
    });
    expect(drained.dead).toBe(0);
    expect(attempted).toBe(1);
  });

  it("PUSH-INT-010 forgets every browser a member had when they are offboarded", async () => {
    const seeded = await seed("push-offboard");
    await seeded.stub.subscribeToPush({
      actor: seeded.member,
      ...(await browserSubscription("https://push.example.test/f/laptop")),
      now: NOW,
    });
    // Offboarding has to reach this. A former member's phone continuing to
    // receive notifications about a workspace they were removed from is the
    // exact failure the directory tombstone is careful not to be.
    await seeded.stub.applyMembership({
      operationId: "push-offboard:remove", memberId: "member", accountId: "account-member",
      handle: "daniel", displayName: "daniel", role: "member", status: "removed",
      authorizationEpoch: 2, version: 2, now: NOW + 5,
    });
    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec("SELECT endpoint FROM push_subscriptions WHERE member_id = 'member'")
          .toArray(),
      ).toHaveLength(0);
    });
  });
});
