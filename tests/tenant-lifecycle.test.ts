import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Actor, Workspace } from "../src/cloudflare/workspace";
import {
  CANCELLATION_WINDOW_MS,
  PURGE_KEEPS,
  PURGE_STAGES,
  PURGE_TABLES,
} from "../src/domain/tenant-lifecycle";

const NOW = 1_800_000_000_000;
const SLUG = "acme-eng";

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
  await stub.sendMessage({
    actor: owner, idempotencyKey: `${name}:message:0001`, channelId: channel.channelId,
    bodyMarkdown: "the release is out", now: NOW + 1,
  });
  return { stub, owner, member, channelId: channel.channelId };
}

const gate = { slug: SLUG, confirmation: SLUG, stepUp: { verified: true }, now: NOW + 10 };

describe("workspace deletion and purge", () => {
  it("O01-INT-001 makes a workspace inaccessible the moment deletion is requested", async () => {
    const seeded = await seed("o01-inaccessible");
    // Before: an ordinary read works.
    await expect(seeded.stub.listPeople({ actor: seeded.member })).resolves.toBeDefined();

    const requested = await seeded.stub.requestWorkspaceDeletion({ actor: seeded.owner, ...gate });
    expect(requested.purgeAfter).toBe(gate.now + CANCELLATION_WINDOW_MS);

    // After: every authorised read and write refuses, including the owner's.
    // D07 §2 says the workspace becomes inaccessible immediately, and the check
    // sits at the one function they all pass through.
    const channelId = seeded.channelId;
    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      expect(() => instance.listPeople({ actor: seeded.member })).toThrow(/being deleted/);
      await expect(
        instance.sendMessage({
          actor: seeded.owner, idempotencyKey: "o01:after:0001", channelId,
          bodyMarkdown: "one more", now: gate.now + 1,
        }),
      ).rejects.toThrow(/being deleted/);
    });
  });

  it("O01-INT-002 refuses a deletion without owner authority, the name, or a gesture", async () => {
    const seeded = await seed("o01-gate");
    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      // A member cannot delete a workspace, however sure they are.
      await expect(
        instance.requestWorkspaceDeletion({ actor: seeded.member, ...gate }),
      ).rejects.toThrow(/only an owner/);
      // "DELETE" would be muscle memory within a week.
      await expect(
        instance.requestWorkspaceDeletion({ actor: seeded.owner, ...gate, confirmation: "DELETE" }),
      ).rejects.toThrow(/did not match/);
      // And this is the one action in the product with no recovery path, so it
      // is the one that always asks for a verified gesture.
      await expect(
        instance.requestWorkspaceDeletion({
          actor: seeded.owner, ...gate, stepUp: { verified: false },
        }),
      ).rejects.toThrow(/verified gesture/);
    });
    // None of the three refusals left a deletion behind.
    expect((await seeded.stub.workspaceDeletionState()).pending).toBe(false);
    await expect(seeded.stub.listPeople({ actor: seeded.member })).resolves.toBeDefined();
  });

  it("O01-INT-003 can be called off inside the window, and not after the purge starts", async () => {
    const seeded = await seed("o01-cancel");
    await seeded.stub.requestWorkspaceDeletion({ actor: seeded.owner, ...gate });

    // Reachable while the workspace is otherwise inaccessible: a cancellation
    // that needed the access the deletion revoked would be a window nobody
    // could use.
    await runInDurableObject<Workspace, void>(seeded.stub, (instance) => {
      expect(() =>
        instance.cancelWorkspaceDeletion({ actorMemberId: "member", now: gate.now + 1 }),
      ).toThrow(/only an active owner/);
    });
    await seeded.stub.cancelWorkspaceDeletion({ actorMemberId: "owner", now: gate.now + 1 });

    expect((await seeded.stub.workspaceDeletionState()).pending).toBe(false);
    // And the workspace is a workspace again, with its content intact.
    const people = await seeded.stub.listPeople({ actor: seeded.member });
    expect(people.people.length).toBeGreaterThan(0);
  });

  it("O01-INT-004 holds the purge for a week unless somebody explicitly skips it", async () => {
    const seeded = await seed("o01-window");
    await seeded.stub.requestWorkspaceDeletion({ actor: seeded.owner, ...gate });

    const early = await seeded.stub.purgeWorkspace({ now: gate.now + 1, jurisdiction: "default" });
    expect(early.status).toBe("window_open");
    // Nothing was touched: the window is not advisory.
    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      expect(state.storage.sql.exec("SELECT id FROM messages").toArray().length).toBeGreaterThan(0);
      expect(state.storage.sql.exec("SELECT stage FROM purge_stages").toArray()).toHaveLength(0);
    });

    // Skipping needs its own confirmation and its own gesture.
    const refused = await seeded.stub.purgeWorkspace({
      now: gate.now + 2, jurisdiction: "default",
      skipWindow: { confirmation: SLUG, slug: SLUG, stepUpVerified: false },
    });
    expect(refused.status).toBe("window_open");
  });

  it("O01-INT-005 purges every stage, resumes after interruption, and leaves nothing behind", async () => {
    const seeded = await seed("o01-purge");
    await seeded.stub.requestWorkspaceDeletion({ actor: seeded.owner, ...gate });

    // One call per stage, which is what an interrupted purge looks like from
    // the outside: each alarm advances it by one and records a checkpoint.
    let status = "";
    let receipt = null;
    for (let attempt = 0; attempt < PURGE_STAGES.length + 2; attempt += 1) {
      const outcome = await seeded.stub.purgeWorkspace({
        now: gate.now + CANCELLATION_WINDOW_MS + attempt,
        jurisdiction: "eu",
      });
      status = outcome.status;
      receipt = outcome.receipt;
      if (status === "complete") break;
    }
    expect(status).toBe("complete");
    expect(receipt).not.toBeNull();
    expect(receipt?.jurisdiction).toBe("eu");
    // Every stage reached, which is the point of the stage list existing.
    expect(receipt?.stages.map((entry) => entry.stage).sort()).toEqual([...PURGE_STAGES].sort());
    expect(receipt?.verification).toMatch(/^[0-9a-f]{64}$/);

    // No content canary anywhere.
    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      for (const table of ["messages", "channels", "members", "files", "audit_events", "agents"]) {
        expect(
          state.storage.sql.exec(`SELECT COUNT(*) AS count FROM ${table}`).one().count,
          `${table} still has rows`,
        ).toBe(0);
      }
    });

    // Idempotent: running it again returns the same receipt rather than
    // starting over or failing.
    const again = await seeded.stub.purgeWorkspace({
      now: gate.now + CANCELLATION_WINDOW_MS + 100, jurisdiction: "eu",
    });
    expect(again.status).toBe("complete");
    expect(again.receipt?.verification).toBe(receipt?.verification);
  });

  it("O01-INT-006 keeps the daily and hourly sweeps on the scheduler", async () => {
    const seeded = await seed("o01-scheduled");
    // C08a implemented the reclamation and left it unscheduled, so nothing ran
    // it. This is the assertion that it is now somebody's job.
    const state = await seeded.stub.schedulerState();
    const kinds = state.dueWork.map((row) => row.kind);
    expect(kinds).toContain("retention_sweep");
    expect(kinds).toContain("storage_reclaim");

    const reclaim = state.dueWork.find((row) => row.kind === "storage_reclaim");
    // Hourly, not daily: D07 gives a deleted object 24 hours to follow its row
    // out, and a daily sweep meets that only if it never fails.
    expect(reclaim?.intervalMs).toBe(60 * 60 * 1000);
  });

  it("O01-INT-007 reclaims an abandoned reservation and a deleted attachment's object", async () => {
    const seeded = await seed("o01-reclaim");
    const report = await seeded.stub.reclaimStorage({ now: NOW + 100 });
    // Nothing to do on a clean workspace, and that is not a failure.
    expect(report).toEqual({ abandoned: 0, reclaimed: 0 });

    // A deleted attachment whose object has not yet been given back.
    const channelId = seeded.channelId;
    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      const columns = state.storage.sql
        .exec<{ name: string; notnull: number; dflt_value: string | null }>(
          "SELECT name, \"notnull\", dflt_value FROM pragma_table_info('files')",
        )
        .toArray();
      // Built from the table's own shape so the scenario does not have to be
      // edited every time C08's schema grows a column.
      const values: Record<string, unknown> = {
        id: "file-1", object_key: "ws/o01/file-1", file_name: "notes.txt",
        media_type: "text/plain", byte_length: 4, state: "deleted",
        uploaded_by_member_id: "owner", channel_id: channelId,
        created_at: NOW, deleted_at: NOW + 1,
      };
      const required = columns.filter(
        (column) => column.name in values || (column.notnull === 1 && column.dflt_value === null),
      );
      state.storage.sql.exec(
        `INSERT INTO files(${required.map((column) => column.name).join(", ")})
         VALUES (${required.map(() => "?").join(", ")})`,
        ...required.map((column) => values[column.name] ?? ""),
      );
    });
    const second = await seeded.stub.reclaimStorage({ now: NOW + 200 });
    expect(second.reclaimed).toBeGreaterThanOrEqual(0);
    // Marked afterwards, so a sweep that failed retries rather than recording a
    // reclamation that did not happen — and a second sweep finds nothing left.
    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      const row = state.storage.sql
        .exec<{ object_reclaimed_at: number | null }>(
          "SELECT object_reclaimed_at FROM files WHERE id = 'file-1'",
        )
        .one();
      expect(row.object_reclaimed_at).toBe(NOW + 200);
    });
    const third = await seeded.stub.reclaimStorage({ now: NOW + 300 });
    expect(third.reclaimed).toBe(0);
  });

  it("O01-INT-008 assigns every table in the database to a stage or to the keep list", async () => {
    // The guard that actually matters. This breaks in practice when a migration
    // three months from now adds a table nobody thinks to purge, and a deleted
    // workspace quietly leaves it behind — so the check is against the live
    // schema rather than against a list somebody remembered to update.
    const seeded = await seed("o01-coverage");
    const tables = await runInDurableObject<Workspace, string[]>(seeded.stub, (_instance, state) =>
      state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .toArray()
        .map((row) => row.name),
    );

    const assigned = new Set([...Object.values(PURGE_TABLES).flat(), ...PURGE_KEEPS]);
    const orphans = tables.filter(
      (name) =>
        !assigned.has(name)
        // Full-text search shadow tables belong to their virtual table and are
        // removed with it; they are never dropped directly.
        && !/_(data|idx|content|docsize|config)$/.test(name),
    );
    expect(orphans, `these tables are neither purged nor kept: ${orphans.join(", ")}`).toEqual([]);

    // And nothing is claimed by two stages, which would double-count a receipt.
    const owned = Object.values(PURGE_TABLES).flat();
    expect(new Set(owned).size).toBe(owned.length);
  });
});
