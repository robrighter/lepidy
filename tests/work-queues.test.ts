import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Actor, Workspace } from "../src/cloudflare/workspace";

const NOW = 1_800_000_000_000;
let ordinal = 0;

async function seed() {
  ordinal += 1;
  const stub = env.WORKSPACE.getByName(`work-queue-${ordinal}`);
  await stub.initializeWorkspace({ storageMode: "cloud", hostEpoch: 0, routingEpoch: 1, now: NOW });
  const owner: Actor = { memberId: "member-owner", authorizationEpoch: 1 };
  const member: Actor = { memberId: "member-two", authorizationEpoch: 1 };
  for (const [actor, handle, role] of [[owner, "maya", "owner"], [member, "daniel", "member"]] as const) {
    await stub.applyMembership({ operationId: `op-${ordinal}-${actor.memberId}`, memberId: actor.memberId,
      accountId: `account-${ordinal}-${actor.memberId}`, handle, displayName: handle,
      role, status: "active", authorizationEpoch: 1, version: 1, now: NOW });
  }
  const channel = await stub.createChannel({ actor: owner, idempotencyKey: `queue:channel:create:${ordinal}`,
    kind: "public", slug: `ideas-${ordinal}`, memberIds: [member.memberId], now: NOW });
  await stub.configureWorkQueue({ actor: owner, channelId: channel.channelId, postMode: "form",
    formDefinition: { instructions: "Pitch it", fields: [
      { id: "title", label: "Title", type: "short_text", required: true, options: [] },
      { id: "details", label: "Details", type: "long_text", required: true, options: [] },
    ] }, sortMode: "ranked", sortEmoji: "🔥", statuses: [
      { id: "triage", label: "Triage", visibility: "public", allowedMemberIds: [] },
      { id: "security", label: "Security", visibility: "private", allowedMemberIds: [] },
    ], mainStatusLabel: "Inbox", now: NOW + 1 });
  return { stub, owner, member, channelId: channel.channelId };
}

describe("C10 form and ranked work queues", () => {
  it("stores a structured form snapshot, blocks free-form roots and keeps replies ordinary", async () => {
    const seeded = await seed();
    const sent = await seeded.stub.submitForm({ actor: seeded.member, channelId: seeded.channelId,
      idempotencyKey: `queue:form:submit:${ordinal}:1`, values: { title: "Bulk export", details: "Download every row" }, now: NOW + 2 });
    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      await expect(instance.sendMessage({ actor: seeded.member, channelId: seeded.channelId,
        idempotencyKey: `queue:free:message:${ordinal}`, bodyMarkdown: "bypass", now: NOW + 3 })).rejects.toThrow("only accepts form entries");
    });
    await expect(seeded.stub.sendMessage({ actor: seeded.member, channelId: seeded.channelId,
      idempotencyKey: `queue:reply:message:${ordinal}`, bodyMarkdown: "I can help", threadParentId: sent.messageId, now: NOW + 4 })).resolves.toMatchObject({ threadRootId: sent.messageId });

    const queue = await seeded.stub.readWorkQueue({ actor: seeded.member, channelId: seeded.channelId });
    expect(queue.page.messages[0]).toMatchObject({ id: sent.messageId, bodyMarkdown: "**Title:** Bulk export\n\n**Details:**\nDownload every row",
      formSubmission: { kind: "form_submission", formVersion: 1 }, voteCount: 0 });
    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ text: string }>("SELECT searchable_text AS text FROM form_submission_content WHERE message_id = ?", sent.messageId).one().text)
        .toContain("Bulk export");
    });
  });

  it("orders by distinct human votes then stable newest/id ties", async () => {
    const seeded = await seed();
    const first = await seeded.stub.submitForm({ actor: seeded.owner, channelId: seeded.channelId,
      idempotencyKey: `queue:rank:submit:${ordinal}:1`, values: { title: "First", details: "Older" }, now: NOW + 2 });
    const second = await seeded.stub.submitForm({ actor: seeded.member, channelId: seeded.channelId,
      idempotencyKey: `queue:rank:submit:${ordinal}:2`, values: { title: "Second", details: "Newer" }, now: NOW + 3 });
    await seeded.stub.reactToMessage({ actor: seeded.owner, messageId: first.messageId, emoji: "🔥", now: NOW + 4 });
    await seeded.stub.reactToMessage({ actor: seeded.member, messageId: first.messageId, emoji: "🔥", now: NOW + 5 });
    await seeded.stub.reactToMessage({ actor: seeded.member, messageId: first.messageId, emoji: "🔥", now: NOW + 6 });
    const queue = await seeded.stub.readWorkQueue({ actor: seeded.member, channelId: seeded.channelId });
    expect(queue.page.messages.map((item) => [item.id, item.voteCount])).toEqual([[first.messageId, 2], [second.messageId, 0]]);
  });

  it("hides private status tabs, counts, items and search hits from unauthorized members", async () => {
    const seeded = await seed();
    const sent = await seeded.stub.submitForm({ actor: seeded.member, channelId: seeded.channelId,
      idempotencyKey: `queue:private:submit:${ordinal}`, values: { title: "Secret incident", details: "rotate keys" }, now: NOW + 2 });
    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      await expect(instance.setItemStatus({ actor: seeded.member, messageId: sent.messageId, statusId: "security", now: NOW + 3 }))
        .rejects.toThrow("only room or workspace admins");
    });
    await seeded.stub.setItemStatus({ actor: seeded.owner, messageId: sent.messageId, statusId: "security", now: NOW + 4 });

    const memberQueue = await seeded.stub.readWorkQueue({ actor: seeded.member, channelId: seeded.channelId });
    expect(memberQueue.tabs).toEqual([{ id: null, label: "Inbox", count: 0 }]);
    expect(memberQueue.page.messages).toEqual([]);
    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      try {
        await instance.readWorkQueue({ actor: seeded.member, channelId: seeded.channelId, statusId: "security" });
        throw new Error("expected private queue status to be rejected");
      } catch (error) {
        expect(error).toMatchObject({ message: "queue status not found" });
      }
    });
    expect((await seeded.stub.searchWorkspace({ actor: seeded.member, query: "secret" })).hits).toEqual([]);
    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      try {
        await instance.readThreadHistory({ actor: seeded.member, threadRootId: sent.messageId });
        throw new Error("expected private queue thread to be rejected");
      } catch (error) {
        expect(error).toMatchObject({ message: "message not found" });
      }
    });

    const ownerQueue = await seeded.stub.readWorkQueue({ actor: seeded.owner, channelId: seeded.channelId, statusId: "security" });
    expect(ownerQueue.tabs.some((tab) => tab.id === "security" && tab.count === 1)).toBe(true);
    expect(ownerQueue.page.messages[0].id).toBe(sent.messageId);
    expect((await seeded.stub.searchWorkspace({ actor: seeded.owner, query: "secret" })).hits[0]).toMatchObject({ id: sent.messageId });
  });

  it("applies all presets and re-homes items when a status is deleted", async () => {
    const seeded = await seed();
    const sent = await seeded.stub.submitForm({ actor: seeded.owner, channelId: seeded.channelId,
      idempotencyKey: `queue:preset:submit:${ordinal}`, values: { title: "Keep me", details: "Do not lose this" }, now: NOW + 2 });
    await seeded.stub.setItemStatus({ actor: seeded.owner, messageId: sent.messageId, statusId: "triage", now: NOW + 3 });
    for (const preset of ["idea_board", "support_queue", "bug_tracker"] as const) {
      const configured = await seeded.stub.configureWorkQueue({ actor: seeded.owner, channelId: seeded.channelId, preset, now: NOW + 10 });
      expect(configured.channel).toMatchObject({ postMode: "form", sortMode: "ranked" });
    }
    const queue = await seeded.stub.readWorkQueue({ actor: seeded.owner, channelId: seeded.channelId });
    expect(queue.page.messages[0]).toMatchObject({ id: sent.messageId, statusId: null });
  });
});
