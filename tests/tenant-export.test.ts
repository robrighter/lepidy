import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Actor, Workspace } from "../src/cloudflare/workspace";
import { CHUNK_TTL_MS, EXPORT_VERSION, exportedTables } from "../src/domain/tenant-export";

const NOW = 1_800_000_000_000;

async function seed(name: string) {
  const stub = env.WORKSPACE.getByName(name);
  await stub.initializeWorkspace({ storageMode: "cloud", hostEpoch: 0, routingEpoch: 1, now: NOW });
  for (const [index, memberId, handle] of [
    [0, "owner", "maya"],
    [1, "member", "daniel"],
  ] as const) {
    await stub.applyMembership({
      operationId: `${name}:${memberId}`, memberId, accountId: `account-${memberId}`, handle,
      displayName: handle, role: index === 0 ? "owner" : "member", status: "active",
      authorizationEpoch: 1, version: 1, now: NOW,
    });
  }
  const owner: Actor = { memberId: "owner", authorizationEpoch: 1 };
  const member: Actor = { memberId: "member", authorizationEpoch: 1 };
  const channel = await stub.createChannel({
    actor: owner, idempotencyKey: `${name}:channel:0001`, kind: "public", slug: "eng",
    memberIds: [member.memberId], now: NOW,
  });
  const sent = await stub.sendMessage({
    actor: owner, idempotencyKey: `${name}:message:0001`, channelId: channel.channelId,
    bodyMarkdown: "the release is out", now: NOW + 1,
  });
  return { stub, owner, member, channelId: channel.channelId, messageId: sent.messageId };
}

/** Walk an export the way a client would, resuming nothing. */
async function collect(seeded: Awaited<ReturnType<typeof seed>>, exportId: string) {
  const lines: string[] = [];
  for (const table of exportedTables()) {
    let offset = 0;
    for (;;) {
      const page = await seeded.stub.exportChunk({
        actor: seeded.owner, exportId, table, offset, limit: 100, now: NOW + 5,
      });
      await seeded.stub.recordExportChunk({
        actor: seeded.owner, exportId, table, offset,
        body: page.body, rows: page.chunk.rows, now: NOW + 5,
      });
      if (page.body) lines.push(...page.body.split("\n"));
      if (page.done) break;
      offset += 100;
    }
  }
  return lines;
}

describe("tenant export and restore", () => {
  it("O01B-INT-001 exports every content table and seals it with a manifest hash", async () => {
    const seeded = await seed("o01b-export");
    const started = await seeded.stub.beginExport({ actor: seeded.owner, now: NOW + 2 });
    expect(started.expiresAt).toBe(NOW + 2 + CHUNK_TTL_MS);

    const lines = await collect(seeded, started.exportId);
    const manifest = await seeded.stub.finishExport({
      actor: seeded.owner, exportId: started.exportId, now: NOW + 6,
    });
    expect(manifest.version).toBe(EXPORT_VERSION);
    expect(manifest.manifestHash).toMatch(/^[0-9a-f]{64}$/);

    const kinds = new Set(lines.filter(Boolean).map((line) => JSON.parse(line).t as string));
    // The customer's own data is in there.
    expect(kinds.has("messages")).toBe(true);
    expect(kinds.has("channels")).toBe(true);
    expect(kinds.has("members")).toBe(true);
    // And every record carries its own immutable ids, so an import preserves
    // attribution rather than inventing it.
    const message = lines
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((record) => record.t === "messages");
    expect(message.r.id).toBe(seeded.messageId);
    expect(message.r.created_at).toBe(NOW + 1);
  });

  it("O01B-INT-002 returns identical bytes for a chunk asked for twice", async () => {
    const seeded = await seed("o01b-resume");
    const started = await seeded.stub.beginExport({ actor: seeded.owner, now: NOW + 2 });

    const first = await seeded.stub.exportChunk({
      actor: seeded.owner, exportId: started.exportId, table: "messages", offset: 0, limit: 100,
      now: NOW + 3,
    });
    await seeded.stub.recordExportChunk({
      actor: seeded.owner, exportId: started.exportId, table: "messages", offset: 0,
      body: first.body, rows: first.chunk.rows, now: NOW + 3,
    });

    // A message written after the chunk was recorded must not appear in it.
    // Resumability means the same id yields the same bytes; an export that
    // silently grew under a client would be one they could not stitch back
    // together.
    await seeded.stub.sendMessage({
      actor: seeded.owner, idempotencyKey: "o01b:resume:0002", channelId: seeded.channelId,
      bodyMarkdown: "written after the chunk", now: NOW + 4,
    });
    const again = await seeded.stub.exportChunk({
      actor: seeded.owner, exportId: started.exportId, table: "messages", offset: 0, limit: 100,
      now: NOW + 5,
    });
    expect(again.body).toBe(first.body);
    expect(again.chunk.rows).toBe(first.chunk.rows);
    expect(again.body).not.toContain("written after the chunk");
  });

  it("O01B-INT-003 refuses an export to anyone but an owner, and after it expires", async () => {
    const seeded = await seed("o01b-authority");
    await runInDurableObject<Workspace, void>(seeded.stub, (instance) => {
      // An export is every message in the workspace in one file.
      expect(() => instance.beginExport({ actor: seeded.member, now: NOW + 2 })).toThrow(
        /only an owner/,
      );
    });

    const started = await seeded.stub.beginExport({ actor: seeded.owner, now: NOW + 2 });
    await runInDurableObject<Workspace, void>(seeded.stub, (instance) => {
      expect(() =>
        instance.exportChunk({
          actor: seeded.member, exportId: started.exportId, table: "messages", offset: 0,
          now: NOW + 3,
        }),
      ).toThrow(/only an owner/);
      // Enforced on read as well as swept, so a chunk cannot be collected from
      // an export whose window has closed even before the sweep runs.
      expect(() =>
        instance.exportChunk({
          actor: seeded.owner, exportId: started.exportId, table: "messages", offset: 0,
          now: NOW + 2 + CHUNK_TTL_MS + 1,
        }),
      ).toThrow(/expired/);
    });

    // And the sweep removes them, downloaded or not.
    expect((await seeded.stub.sweepExpiredExports(NOW + 2 + CHUNK_TTL_MS + 1)).runs).toBe(1);
    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      expect(state.storage.sql.exec("SELECT id FROM export_chunks").toArray()).toHaveLength(0);
    });
  });

  it("O01B-INT-004 restores content into a replacement and resurrects no authority at all", async () => {
    const seeded = await seed("o01b-source");
    const started = await seeded.stub.beginExport({ actor: seeded.owner, now: NOW + 2 });
    const lines = await collect(seeded, started.exportId);
    const manifest = await seeded.stub.finishExport({
      actor: seeded.owner, exportId: started.exportId, now: NOW + 6,
    });

    const replacement = env.WORKSPACE.getByName("o01b-replacement");
    await replacement.initializeWorkspace({
      storageMode: "cloud", hostEpoch: 0, routingEpoch: 1, now: NOW,
    });

    const outcome = await replacement.restoreFromExport({
      version: manifest.version, lines, manifestHash: manifest.manifestHash,
      chunks: manifest.chunks, exportId: manifest.exportId, now: NOW + 10,
    });

    // A new routing epoch, so anything still holding the old one is refused
    // rather than silently accepted against restored data.
    expect(outcome.routingEpoch).toBe(2);
    // The content came back.
    expect(outcome.restored.messages).toBeGreaterThan(0);
    expect(outcome.restored.members).toBeGreaterThan(0);
    expect(outcome.restored.channels).toBeGreaterThan(0);

    await runInDurableObject<Workspace, void>(replacement, (_instance, state) => {
      const message = state.storage.sql
        .exec<{ body_markdown: string }>("SELECT body_markdown FROM messages WHERE id = ?", seeded.messageId)
        .one();
      expect(message.body_markdown).toBe("the release is out");

      // The promise this whole task exists for. Not one of these is written,
      // and the reason is structural: `restoreDecision` classifies them, and
      // there is no branch that writes an authority or transient table.
      for (const table of [
        "agent_sessions", "agent_delegations", "runner_devices", "runner_agents",
        "vault_grants", "vault_approvals", "oauth_connections", "oauth_codes",
        "idempotency_keys", "pending_events", "agent_queue", "push_subscriptions",
        "replay_events", "notifications",
      ]) {
        expect(
          state.storage.sql.exec(`SELECT COUNT(*) AS count FROM ${table}`).one().count,
          `${table} was resurrected by a restore`,
        ).toBe(0);
      }
    });
  });

  it("O01B-INT-005 refuses a tampered manifest before it writes a single row", async () => {
    const seeded = await seed("o01b-tamper");
    const started = await seeded.stub.beginExport({ actor: seeded.owner, now: NOW + 2 });
    const lines = await collect(seeded, started.exportId);
    const manifest = await seeded.stub.finishExport({
      actor: seeded.owner, exportId: started.exportId, now: NOW + 6,
    });

    const replacement = env.WORKSPACE.getByName("o01b-tampered-target");
    await replacement.initializeWorkspace({
      storageMode: "cloud", hostEpoch: 0, routingEpoch: 1, now: NOW,
    });

    await runInDurableObject<Workspace, void>(replacement, async (instance) => {
      // A partially restored workspace built from a reordered or truncated
      // export would be worse than none at all, because it would look complete.
      await expect(
        instance.restoreFromExport({
          version: manifest.version, lines, manifestHash: manifest.manifestHash,
          chunks: manifest.chunks.slice(1), exportId: manifest.exportId, now: NOW + 10,
        }),
      ).rejects.toThrow(/manifest hash does not match/);
      await expect(
        instance.restoreFromExport({
          version: manifest.version + 1, lines, manifestHash: manifest.manifestHash,
          chunks: manifest.chunks, exportId: manifest.exportId, now: NOW + 10,
        }),
      ).rejects.toThrow(/does not know/);
    });

    await runInDurableObject<Workspace, void>(replacement, (_instance, state) => {
      expect(state.storage.sql.exec("SELECT COUNT(*) AS count FROM messages").one().count).toBe(0);
      expect(state.storage.sql.exec("SELECT routing_epoch FROM workspace_config").one().routing_epoch).toBe(1);
    });
  });

  it("O01B-INT-006 refuses to restore into a workspace that is already somebody's", async () => {
    const source = await seed("o01b-live-source");
    const started = await source.stub.beginExport({ actor: source.owner, now: NOW + 2 });
    const lines = await collect(source, started.exportId);
    const manifest = await source.stub.finishExport({
      actor: source.owner, exportId: started.exportId, now: NOW + 6,
    });

    // A restore that merged would quietly mix somebody's old data with their
    // current data, and nothing afterwards could tell the two apart.
    const live = await seed("o01b-live-target");
    await runInDurableObject<Workspace, void>(live.stub, async (instance) => {
      await expect(
        instance.restoreFromExport({
          version: manifest.version, lines, manifestHash: manifest.manifestHash,
          chunks: manifest.chunks, exportId: manifest.exportId, now: NOW + 10,
        }),
      ).rejects.toThrow(/replacement workspace/);
    });
  });
});
