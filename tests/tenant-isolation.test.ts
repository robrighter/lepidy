import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Actor, Workspace } from "../src/cloudflare/workspace";

const NOW = 1_800_000_000_000;
const CANARY = "g02-object-canary-3140";

/**
 * G02 at the object boundary.
 *
 * Two real workspaces, and — deliberately — **the same member identifier in
 * both**. Member ids are tenant-local, so a naive cross-tenant test would use
 * an id that simply does not exist in the other workspace and would pass for
 * the wrong reason. Giving both tenants a member called `owner` with a valid
 * authorization epoch is the sharp version: the actor is real on both sides,
 * and every identifier below is a real identifier belonging to the other one.
 */
async function seed(name: string, body: string) {
  const stub = env.WORKSPACE.getByName(name);
  await stub.initializeWorkspace({ storageMode: "cloud", hostEpoch: 0, routingEpoch: 1, now: NOW });
  await stub.applyMembership({
    operationId: `${name}:owner`, memberId: "owner", accountId: `account-${name}`, handle: "maya",
    displayName: "maya", role: "owner", status: "active", authorizationEpoch: 1, version: 1, now: NOW,
  });
  const owner: Actor = { memberId: "owner", authorizationEpoch: 1 };
  const open = await stub.createChannel({
    actor: owner, idempotencyKey: `${name}-channel-open-0001`, kind: "public", slug: "general",
    memberIds: [], now: NOW,
  });
  const closed = await stub.createChannel({
    actor: owner, idempotencyKey: `${name}-channel-closed-001`, kind: "private", slug: "incident",
    memberIds: [], now: NOW,
  });
  const message = await stub.sendMessage({
    actor: owner, idempotencyKey: `${name}-message-000000001`, channelId: closed.channelId,
    bodyMarkdown: body, now: NOW + 1,
  });
  return { stub, owner, openId: open.channelId, closedId: closed.channelId, messageId: message.messageId };
}

describe("tenant isolation at the object boundary", () => {
  it("G02-INT-004 resolves nothing of one workspace inside another", async () => {
    const victim = await seed("g02-victim", `the deploy key is ${CANARY}`);
    const attacker = await seed("g02-attacker", "nothing here");

    // The attacker's own object, addressed with the victim's real identifiers,
    // by an actor who genuinely exists here. Every one of these is a valid id —
    // just not one of this workspace's.
    await runInDurableObject<Workspace, void>(attacker.stub, async (instance) => {
      expect(
        instance.renderNotification({
          actor: attacker.owner, kind: "message", id: victim.messageId, now: NOW + 5,
        }),
        "a message identifier from another workspace resolved",
      ).toBeNull();

      // Reads that take a channel identifier report it missing rather than
      // forbidden: "you may not see this" tells a caller it exists.
      expect(() =>
        instance.listPins({ actor: attacker.owner, channelId: victim.closedId }),
      ).toThrow(/not found|not available/i);

      await expect(
        instance.sendMessage({
          actor: attacker.owner, idempotencyKey: "g02-cross-write-00001",
          channelId: victim.openId, bodyMarkdown: "posted across the boundary", now: NOW + 6,
        }),
      ).rejects.toThrow(/not found|not available/i);
    });

    // And nothing was written into the victim by any of it.
    await runInDurableObject<Workspace, void>(victim.stub, (_instance, state) => {
      const bodies = state.storage.sql
        .exec<{ body_markdown: string }>("SELECT body_markdown FROM messages")
        .toArray()
        .map((row) => row.body_markdown);
      expect(bodies).toEqual([`the deploy key is ${CANARY}`]);
    });
  });

  it("G02-INT-005 keeps one workspace's search, files and replay out of another's", async () => {
    const victim = await seed("g02-search-victim", `the deploy key is ${CANARY}`);
    const attacker = await seed("g02-search-attacker", "nothing here");

    // The victim can find their own message, which is the control: without it
    // this passes because search is broken rather than because it is safe.
    const mine = await victim.stub.searchWorkspace({ actor: victim.owner, query: "deploy" });
    expect(mine.hits.length).toBeGreaterThan(0);
    expect(JSON.stringify(mine.hits)).toContain(CANARY);

    // The attacker cannot, from their own workspace, by any query. Scanned over
    // the **hits** rather than the whole response: a search result echoes the
    // query back, so searching for the secret would otherwise be reported as
    // leaking it — which would be calling the attacker's own typing a leak.
    for (const query of ["deploy", CANARY, "key"]) {
      const across = await attacker.stub.searchWorkspace({ actor: attacker.owner, query });
      expect(across.hits, `search for ${query} returned another tenant's rows`).toEqual([]);
      expect(JSON.stringify(across.hits)).not.toContain(CANARY);
    }

    // Files and replay, the two other surfaces that enumerate rather than
    // address: neither may return a row belonging to the other tenant.
    const files = await attacker.stub.listFiles({ actor: attacker.owner });
    expect(JSON.stringify(files)).not.toContain(CANARY);
    await runInDurableObject<Workspace, void>(attacker.stub, (_instance, state) => {
      const replay = state.storage.sql
        .exec<{ payload_json: string }>("SELECT payload_json FROM replay_events")
        .toArray()
        .map((row) => row.payload_json)
        .join(" ");
      expect(replay).not.toContain(victim.messageId);
      expect(replay).not.toContain(CANARY);
    });
  });

  it("G02-INT-006 keeps a stale authorization epoch from reaching anything", async () => {
    const victim = await seed("g02-epoch", `the deploy key is ${CANARY}`);

    // Authority advanced: an offboarding, a revoked device, an owner change.
    await victim.stub.applyMembership({
      operationId: "g02-epoch:advance", memberId: "owner", accountId: "account-g02-epoch",
      handle: "maya", displayName: "maya", role: "owner", status: "active",
      authorizationEpoch: 2, version: 2, now: NOW + 10,
    });

    await runInDurableObject<Workspace, void>(victim.stub, (instance) => {
      // The credential is otherwise perfect — right member, right workspace,
      // right role — and one number behind. That is what a revoked session
      // looks like from the inside.
      expect(() => instance.listPeople({ actor: { memberId: "owner", authorizationEpoch: 1 } })).toThrow(
        /not authorized/i,
      );
      expect(() =>
        instance.listPeople({ actor: { memberId: "owner", authorizationEpoch: 2 } }),
      ).not.toThrow();
      // And a number from the future is not authority either.
      expect(() =>
        instance.listPeople({ actor: { memberId: "owner", authorizationEpoch: 99 } }),
      ).toThrow(/not authorized/i);
    });
  });
});
