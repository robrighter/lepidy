import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import {
  AUDIT_ANCHOR_WORK_ID,
  OUTBOX_FLUSH_WORK_ID,
  RETENTION_SWEEP_WORK_ID,
  type Workspace,
} from "../src/cloudflare/workspace";
import type { OutboxEntry, OutboxOutcome } from "../src/cloudflare/workspace-scheduler";
import { DAY_MS, RETENTION_MS } from "../src/domain/due-work";

/**
 * Controlled clock. Every scheduled deadline in these scenarios sits between
 * `base` and the bootstrap recurring work a workspace creates for itself
 * (`Date.now() + 24h`), so the real alarm never fires underneath an assertion
 * and the tests never sleep.
 */
function controlledBase(): number {
  return Date.now() + 60_000;
}

function recordingDispatcher() {
  const seen: OutboxEntry[] = [];
  const dispatch = async (entry: OutboxEntry): Promise<OutboxOutcome> => {
    seen.push(entry);
    return { status: "delivered" };
  };
  return { seen, dispatch };
}

describe("workspace alarm scheduler", () => {
  it("SCHED-INT-001 multiplexes competing deadlines through the object's single alarm", async () => {
    const stub = env.WORKSPACE.getByName("scheduler-competing");
    const base = controlledBase();

    await stub.scheduleWork(
      [
        { id: "expiry.late", kind: "retention_sweep", dueAt: base + 5_000 },
        { id: "expiry.early", kind: "retention_sweep", dueAt: base + 1_000 },
        { id: "expiry.middle", kind: "retention_sweep", dueAt: base + 3_000 },
      ],
      base,
    );

    const scheduled = await stub.schedulerState();
    expect(scheduled.alarmAt).toBe(base + 1_000);
    expect(scheduled.dueWork.map((item) => item.id)).toEqual([
      "expiry.early",
      "expiry.middle",
      "expiry.late",
      AUDIT_ANCHOR_WORK_ID,
      RETENTION_SWEEP_WORK_ID,
    ]);

    // Only the earliest deadline is due; the alarm re-points at the next one.
    const first = await stub.runDueWork(base + 1_000);
    expect(first.processed).toEqual(["expiry.early"]);
    expect(first.alarmAt).toBe(base + 3_000);

    const second = await stub.runDueWork(base + 4_000);
    expect(second.processed).toEqual(["expiry.middle"]);
    expect(second.alarmAt).toBe(base + 5_000);

    const third = await stub.runDueWork(base + 9_000);
    expect(third.processed).toEqual(["expiry.late"]);
    // The tenant's own recurring work is what remains.
    expect(third.alarmAt).toBeGreaterThan(base + 9_000);
    expect((await stub.schedulerState()).dueWork.map((item) => item.id)).toEqual([
      AUDIT_ANCHOR_WORK_ID,
      RETENTION_SWEEP_WORK_ID,
    ]);
  });

  it("SCHED-INT-002 coalesces a duplicate deadline onto the earliest of the two", async () => {
    const stub = env.WORKSPACE.getByName("scheduler-duplicates");
    const base = controlledBase();

    await stub.scheduleWork([{ id: "expiry.grant", kind: "retention_sweep", dueAt: base + 8_000 }], base);
    await stub.scheduleWork([{ id: "expiry.grant", kind: "retention_sweep", dueAt: base + 2_000 }], base);
    // A later duplicate must not push an existing deadline out.
    await stub.scheduleWork([{ id: "expiry.grant", kind: "retention_sweep", dueAt: base + 9_000 }], base);

    const state = await stub.schedulerState();
    expect(state.dueWork.filter((item) => item.id === "expiry.grant")).toEqual([
      { id: "expiry.grant", kind: "retention_sweep", dueAt: base + 2_000, intervalMs: null, payload: null, attempts: 0 },
    ]);
    expect(state.alarmAt).toBe(base + 2_000);
  });

  it("SCHED-INT-003 backs a failing kind off and retires it without stalling its neighbours", async () => {
    const stub = env.WORKSPACE.getByName("scheduler-failure");
    const base = controlledBase();

    await stub.scheduleWork(
      [
        { id: "broken.item", kind: "kind_without_a_handler", dueAt: base },
        { id: "healthy.item", kind: "retention_sweep", dueAt: base },
      ],
      base,
    );

    let now = base;
    const report = await stub.runDueWork(now);
    expect(report.processed).toEqual(["healthy.item"]);
    expect(report.failed).toEqual([
      {
        id: "broken.item",
        kind: "kind_without_a_handler",
        error: "no handler for due work kind kind_without_a_handler",
        retried: true,
      },
    ]);
    expect(report.retention).not.toBeNull();

    // Attempts 2..5 back off; the fifth retires the item with a redacted record.
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      const state = await stub.schedulerState();
      const item = state.dueWork.find((row) => row.id === "broken.item");
      expect(item?.attempts).toBe(attempt - 1);
      now = item!.dueAt;
      await stub.runDueWork(now);
    }

    const finalState = await stub.schedulerState();
    expect(finalState.dueWork.find((row) => row.id === "broken.item")).toBeUndefined();
    await runInDurableObject<Workspace, void>(stub, (_instance, state) => {
      const failure = state.storage.sql
        .exec<{ work_id: string; kind: string; attempts: number; error: string }>(
          "SELECT work_id, kind, attempts, error FROM due_work_failures",
        )
        .one();
      expect(failure).toEqual({
        work_id: "broken.item",
        kind: "kind_without_a_handler",
        attempts: 5,
        error: "no handler for due work kind kind_without_a_handler",
      });
    });
  });

  it("SCHED-INT-004 advances recurring work past every slot missed while evicted", async () => {
    const stub = env.WORKSPACE.getByName("scheduler-recurring");
    const base = controlledBase();

    await stub.scheduleWork(
      [{ id: "sweep.hourly", kind: "retention_sweep", dueAt: base, intervalMs: 3_600_000 }],
      base,
    );
    // Ten hours pass with the object evicted; one catch-up run, not ten.
    const report = await stub.runDueWork(base + 10 * 3_600_000 + 5);
    expect(report.processed).toEqual(["sweep.hourly"]);

    const state = await stub.schedulerState();
    expect(state.dueWork.find((item) => item.id === "sweep.hourly")).toMatchObject({
      dueAt: base + 11 * 3_600_000,
      attempts: 0,
    });
  });

  it("SCHED-INT-005 rebuilds the alarm from durable state after an eviction and delivers on the real alarm", async () => {
    const stub = env.WORKSPACE.getByName("scheduler-restart");
    const now = Date.now();

    await runInDurableObject<Workspace, void>(stub, async (instance) => {
      await instance.commitMutation({ scope: "restart", now }, () => ({
        result: { ok: true },
        effects: {
          outbox: [{ id: "restart.probe.1", kind: "restart_probe", payload: { attempt: 1 } }],
        },
      }));
    });

    const beforeEviction = await stub.schedulerState();
    expect(beforeEviction.pendingOutbox).toBe(1);
    expect(beforeEviction.dueWork.map((item) => item.id)).toContain(OUTBOX_FLUSH_WORK_ID);

    // Tear down the instance: only durable rows survive.
    await evictDurableObject(stub);

    // The reconstructed object re-arms its own alarm and drains through the real
    // queue binding without any further request.
    await vi.waitFor(
      async () => {
        const state = await stub.schedulerState();
        expect(state.pendingOutbox).toBe(0);
        expect(state.deadOutbox).toBe(0);
        expect(state.dueWork.map((item) => item.id)).toEqual([
          AUDIT_ANCHOR_WORK_ID,
          RETENTION_SWEEP_WORK_ID,
        ]);
        expect(state.alarmAt).not.toBeNull();
      },
      { timeout: 20_000, interval: 25 },
    );

    await runInDurableObject<Workspace, void>(stub, (_instance, state) => {
      const row = state.storage.sql
        .exec<{ status: string; attempts: number }>(
          "SELECT status, attempts FROM pending_events WHERE id = 'restart.probe.1'",
        )
        .one();
      expect(row).toEqual({ status: "delivered", attempts: 1 });
    });
  }, 30_000);

  it("SCHED-INT-006 runs the exported alarm handler itself", async () => {
    const stub = env.WORKSPACE.getByName("scheduler-alarm-handler");
    const base = controlledBase();
    await stub.scheduleWork([{ id: "anchor.forced", kind: "audit_anchor", dueAt: base + 5_000 }], base);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    // The handler read the real clock, so the future item is still queued and
    // the alarm has been put back where it belongs.
    const state = await stub.schedulerState();
    expect(state.dueWork.map((item) => item.id)).toContain("anchor.forced");
    expect(state.alarmAt).toBe(state.dueWork[0].dueAt);
  });
});

describe("workspace transactional outbox", () => {
  it("OUTBOX-INT-001 commits rows, audit, outbox, replay and deadlines in one transaction", async () => {
    const stub = env.WORKSPACE.getByName("outbox-atomic");
    const base = controlledBase();

    await runInDurableObject<Workspace, void>(stub, async (instance, state) => {
      const outcome = await instance.commitMutation({ scope: "channel", now: base }, () => {
        state.storage.sql.exec(
          `INSERT INTO channels(id, kind, slug, name, created_at, updated_at)
           VALUES ('channel-atomic', 'public', 'atomic', 'Atomic', ?, ?)`,
          base,
          base,
        );
        return {
          result: { channelId: "channel-atomic" },
          effects: {
            audit: {
              eventType: "channel.created",
              outcome: "allowed" as const,
              requesterKind: "member" as const,
              requesterId: "member-1",
              subjectKind: "channel",
              subjectId: "channel-atomic",
              metadata: { channel_kind: "public" },
            },
            outbox: [{ id: "channel.created.1", kind: "channel_created", payload: { id: "channel-atomic" } }],
            replay: [{ kind: "channel.created", audience: ["workspace"], payload: { id: "channel-atomic" } }],
            dueWork: [{ id: "channel.reminder.1", kind: "retention_sweep", dueAt: base + 60_000 }],
          },
        };
      });

      expect(outcome.replayed).toBe(false);
      expect(outcome.result).toEqual({ channelId: "channel-atomic" });
      expect(outcome.audit).toMatchObject({ sequence: 1 });
      expect(outcome.outboxQueued).toBe(1);
      // The outbox flush is due immediately, so it wins the alarm.
      expect(outcome.alarmAt).toBe(base);
    });

    await runInDurableObject<Workspace, void>(stub, (_instance, state) => {
      const count = (table: string): number =>
        state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).one().count;
      expect(count("channels")).toBe(1);
      expect(count("audit_events")).toBe(1);
      expect(count("pending_events")).toBe(1);
      expect(count("replay_events")).toBe(1);
      expect(
        state.storage.sql
          .exec<{ audience_json: string }>("SELECT audience_json FROM replay_events")
          .one().audience_json,
      ).toBe('["workspace"]');
    });
  });

  it("OUTBOX-INT-002 rolls every side effect back when the mutation fails", async () => {
    const stub = env.WORKSPACE.getByName("outbox-rollback");
    const base = controlledBase();

    await runInDurableObject<Workspace, void>(stub, async (instance, state) => {
      await expect(
        instance.commitMutation({ scope: "channel", idempotencyKey: "rollback:key:0000000001", now: base }, () => {
          state.storage.sql.exec(
            `INSERT INTO channels(id, kind, slug, name, created_at, updated_at)
             VALUES ('channel-doomed', 'public', 'doomed', 'Doomed', ?, ?)`,
            base,
            base,
          );
          throw new Error("mutation rejected after writing rows");
        }),
      ).rejects.toThrow("mutation rejected after writing rows");

      const count = (table: string): number =>
        state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).one().count;
      expect(count("channels")).toBe(0);
      expect(count("audit_events")).toBe(0);
      expect(count("pending_events")).toBe(0);
      expect(count("replay_events")).toBe(0);
      expect(count("idempotency_keys")).toBe(0);
      expect(
        state.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM due_work WHERE id = ?", OUTBOX_FLUSH_WORK_ID)
          .one().count,
      ).toBe(0);
    });
  });

  it("OUTBOX-INT-003 replays a repeated request without repeating its side effects", async () => {
    const stub = env.WORKSPACE.getByName("outbox-idempotent");
    const base = controlledBase();
    const key = "channel:create:0000000042";

    const mutate = async (instance: Workspace, state: DurableObjectState, requestHash: string, now: number) =>
      instance.commitMutation({ scope: "channel", idempotencyKey: key, requestHash, now }, () => {
        state.storage.sql.exec(
          `INSERT INTO channels(id, kind, slug, name, created_at, updated_at)
           VALUES ('channel-once', 'public', 'once', 'Once', ?, ?)`,
          now,
          now,
        );
        return {
          result: { channelId: "channel-once" },
          effects: {
            audit: {
              eventType: "channel.created",
              outcome: "allowed" as const,
              requesterKind: "member" as const,
              requesterId: "member-1",
              subjectId: "channel-once",
            },
            outbox: [{ id: "channel.once.1", kind: "channel_created", payload: { id: "channel-once" } }],
          },
        };
      });

    await runInDurableObject<Workspace, void>(stub, async (instance, state) => {
      const first = await mutate(instance, state, "hash-a", base);
      expect(first.replayed).toBe(false);

      const second = await mutate(instance, state, "hash-a", base + 1);
      expect(second.replayed).toBe(true);
      expect(second.result).toEqual({ channelId: "channel-once" });
      expect(second.audit).toBeNull();
      expect(second.outboxQueued).toBe(0);

      // A different request under the same key is a client bug, not a replay.
      await expect(mutate(instance, state, "hash-b", base + 2)).rejects.toThrow(
        "idempotency key reuse with a different request",
      );

      const count = (table: string): number =>
        state.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).one().count;
      expect(count("channels")).toBe(1);
      expect(count("audit_events")).toBe(1);
      expect(count("pending_events")).toBe(1);
      expect(
        state.storage.sql
          .exec<{ expires_at: number }>("SELECT expires_at FROM idempotency_keys").one().expires_at,
      ).toBe(base + RETENTION_MS.idempotencyResult);
    });
  });

  it("OUTBOX-INT-004 retries a transient failure with backoff and delivers exactly once", async () => {
    const stub = env.WORKSPACE.getByName("outbox-retry");
    const base = controlledBase();

    await runInDurableObject<Workspace, void>(stub, async (instance) => {
      await instance.commitMutation({ scope: "probe", now: base }, () => ({
        result: null,
        effects: { outbox: [{ id: "retry.probe.1", kind: "probe", payload: { n: 1 } }] },
      }));

      const attempts: number[] = [];
      const flaky = async (entry: OutboxEntry): Promise<OutboxOutcome> => {
        attempts.push(entry.attempts);
        return entry.attempts < 2
          ? { status: "retry", error: "downstream\nunavailable" }
          : { status: "delivered" };
      };

      expect(await instance.drainOutbox(base, flaky)).toEqual({
        attempted: 1,
        delivered: 0,
        retried: 1,
        dead: 0,
      });
      // Backoff is real: the entry is not eligible again at the same instant.
      expect(await instance.drainOutbox(base, flaky)).toEqual({
        attempted: 0,
        delivered: 0,
        retried: 0,
        dead: 0,
      });
      expect(await instance.drainOutbox(base + 1_000, flaky)).toMatchObject({ attempted: 1, retried: 1 });
      expect(await instance.drainOutbox(base + 4_000, flaky)).toEqual({
        attempted: 1,
        delivered: 1,
        retried: 0,
        dead: 0,
      });
      // Delivered work is never offered again.
      expect(await instance.drainOutbox(base + 60_000, flaky)).toMatchObject({ attempted: 0 });
      expect(attempts).toEqual([0, 1, 2]);
    });

    await runInDurableObject<Workspace, void>(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ status: string; attempts: number; last_error: string | null }>(
            "SELECT status, attempts, last_error FROM pending_events WHERE id = 'retry.probe.1'",
          )
          .one(),
      ).toEqual({ status: "delivered", attempts: 3, last_error: null });
    });
  });

  it("OUTBOX-INT-005 dead-letters a permanent failure and an exhausted attempt budget", async () => {
    const stub = env.WORKSPACE.getByName("outbox-dead-letter");
    const base = controlledBase();

    await runInDurableObject<Workspace, void>(stub, async (instance, state) => {
      await instance.commitMutation({ scope: "probe", now: base }, () => ({
        result: null,
        effects: {
          outbox: [
            { id: "dead.permanent.1", kind: "probe", payload: { n: 1 } },
            { id: "dead.exhausted.1", kind: "probe", payload: { n: 2 }, maxAttempts: 2 },
          ],
        },
      }));

      const dispatch = async (entry: OutboxEntry): Promise<OutboxOutcome> =>
        entry.id === "dead.permanent.1"
          ? { status: "permanent", error: "rejected by schema" }
          : { status: "retry", error: "still unavailable" };

      expect(await instance.drainOutbox(base, dispatch)).toEqual({
        attempted: 2,
        delivered: 0,
        retried: 1,
        dead: 1,
      });
      expect(await instance.drainOutbox(base + 1_000, dispatch)).toEqual({
        attempted: 1,
        delivered: 0,
        retried: 0,
        dead: 1,
      });

      const rows = state.storage.sql
        .exec<{ id: string; status: string; attempts: number; last_error: string }>(
          "SELECT id, status, attempts, last_error FROM pending_events ORDER BY id",
        )
        .toArray();
      expect(rows).toEqual([
        { id: "dead.exhausted.1", status: "dead", attempts: 2, last_error: "still unavailable" },
        { id: "dead.permanent.1", status: "dead", attempts: 1, last_error: "rejected by schema" },
      ]);
      // A dead entry is never retried again.
      expect(await instance.drainOutbox(base + 3_600_000, dispatch)).toMatchObject({ attempted: 0 });
    });
  });

  it("OUTBOX-INT-006 refuses a duplicate delivery for a repeated logical event", async () => {
    const stub = env.WORKSPACE.getByName("outbox-dedupe");
    const base = controlledBase();

    await runInDurableObject<Workspace, void>(stub, async (instance, state) => {
      const enqueue = (id: string, now: number) =>
        instance.commitMutation({ scope: "probe", now }, () => ({
          result: null,
          effects: {
            outbox: [{ id, kind: "probe", dedupeKey: "member:member-1:7", payload: { n: 1 } }],
          },
        }));

      expect((await enqueue("dedupe.a", base)).outboxQueued).toBe(1);
      // Same logical event, different transport id, and the same id again.
      expect((await enqueue("dedupe.b", base + 1)).outboxQueued).toBe(0);
      expect((await enqueue("dedupe.a", base + 2)).outboxQueued).toBe(0);

      expect(
        state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM pending_events").one().count,
      ).toBe(1);

      const recorder = recordingDispatcher();
      expect(await instance.drainOutbox(base + 3, recorder.dispatch)).toMatchObject({ delivered: 1 });
      expect(recorder.seen).toHaveLength(1);
      expect(recorder.seen[0]).toMatchObject({ id: "dedupe.a", dedupeKey: "member:member-1:7", attempts: 0 });
    });
  });

  it("OUTBOX-INT-007 hands a delivery to the real local queue binding", async () => {
    const stub = env.WORKSPACE.getByName("outbox-queue-binding");
    const base = controlledBase();

    await runInDurableObject<Workspace, void>(stub, async (instance) => {
      await instance.commitMutation({ scope: "probe", now: base }, () => ({
        result: null,
        effects: { outbox: [{ id: "queue.probe.1", kind: "probe", payload: { n: 1 } }] },
      }));
      // No dispatcher override: this is the production queue path.
      expect(await instance.drainOutbox(base)).toEqual({
        attempted: 1,
        delivered: 1,
        retried: 0,
        dead: 0,
      });
    });
  });

  it("OUTBOX-INT-008 projects membership with one audit entry, one delivery and one replay event", async () => {
    const stub = env.WORKSPACE.getByName("outbox-membership");
    const base = controlledBase();
    const member = {
      operationId: "op-membership-1",
      memberId: "member-1",
      accountId: "account-1",
      handle: "ada",
      displayName: "Ada",
      role: "owner" as const,
      status: "active" as const,
      authorizationEpoch: 1,
      version: 1,
      now: base,
    };

    await expect(stub.applyMembership(member)).resolves.toEqual({ applied: true, version: 1 });
    // The control plane retrying the same operation must not audit or notify twice.
    await expect(stub.applyMembership({ ...member, now: base + 1 })).resolves.toEqual({
      applied: false,
      version: 1,
    });

    const trail = await stub.auditTrail();
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      sequence: 1,
      eventType: "membership.projected",
      outcome: "allowed",
      requesterKind: "system",
      subjectKind: "member",
      subjectId: "member-1",
      metadata: {
        role: "owner",
        member_status: "active",
        authorization_epoch: 1,
        control_version: 1,
        operation_id: "op-membership-1",
      },
    });
    expect(await stub.verifyAuditTrail()).toMatchObject({ ok: true, entryCount: 1 });

    await runInDurableObject<Workspace, void>(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ id: string; dedupe_key: string; status: string }>(
            "SELECT id, dedupe_key, status FROM pending_events",
          )
          .toArray(),
      ).toEqual([
        { id: "member_projection.op-membership-1", dedupe_key: "member:member-1:1", status: "pending" },
      ]);
      expect(
        state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM replay_events").one().count,
      ).toBe(1);
    });

    // A stale projection is rejected and leaves no audit or delivery behind.
    // Asserted against the instance: a rejecting stub call is reported as an
    // unhandled rejection by the Workers test harness itself.
    await runInDurableObject<Workspace, void>(stub, async (instance) => {
      await expect(
        instance.applyMembership({ ...member, operationId: "op-membership-stale", version: 1, now: base + 2 }),
      ).rejects.toThrow("membership projection version is stale");
    });
    expect(await stub.auditTrail()).toHaveLength(1);
    await runInDurableObject<Workspace, void>(stub, (_instance, state) => {
      expect(
        state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM pending_events").one().count,
      ).toBe(1);
    });
  });
});

describe("workspace audit baseline", () => {
  it("AUDIT-INT-001 refuses to update or delete a live audit row", async () => {
    const stub = env.WORKSPACE.getByName("audit-append-only");
    await stub.recordAuditEvent(
      {
        eventType: "vault.grant.issued",
        outcome: "allowed",
        requesterKind: "agent",
        requesterId: "agent-1",
        operatingOwnerId: "member-1",
        approverId: "member-2",
        subjectKind: "credential",
        subjectId: "credential-1",
        metadata: { grant_minutes: 5 },
      },
      1_700_000_000_000,
    );

    await runInDurableObject<Workspace, void>(stub, (_instance, state) => {
      expect(() =>
        state.storage.sql.exec("UPDATE audit_events SET outcome = 'denied' WHERE sequence = 1"),
      ).toThrow(/append-only/);
      expect(() => state.storage.sql.exec("DELETE FROM audit_events WHERE sequence = 1")).toThrow(
        /retention release/,
      );
      expect(
        state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM audit_events").one().count,
      ).toBe(1);
    });
    expect(await stub.verifyAuditTrail()).toMatchObject({ ok: true, entryCount: 1 });
  });

  it("AUDIT-INT-002 detects an operator who edits the chain behind the triggers", async () => {
    const stub = env.WORKSPACE.getByName("audit-tamper");
    for (let index = 1; index <= 3; index += 1) {
      await stub.recordAuditEvent(
        {
          eventType: "message.deleted",
          outcome: "allowed",
          requesterKind: "member",
          requesterId: `member-${index}`,
          subjectKind: "message",
          subjectId: `message-${index}`,
        },
        1_700_000_000_000 + index,
      );
    }
    expect(await stub.verifyAuditTrail()).toMatchObject({ ok: true, entryCount: 3 });

    await runInDurableObject<Workspace, void>(stub, (_instance, state) => {
      state.storage.sql.exec("DROP TRIGGER audit_events_append_only_update");
      state.storage.sql.exec("UPDATE audit_events SET requester_id = 'member-9' WHERE sequence = 2");
    });

    expect(await stub.verifyAuditTrail()).toEqual({
      ok: false,
      entryCount: 3,
      brokenAtSequence: 2,
      reason: "entry hash does not cover the stored fields",
    });
  });

  it("AUDIT-INT-003 anchors a completed day and refuses to seal a broken chain", async () => {
    const stub = env.WORKSPACE.getByName("audit-anchor");
    const day = Date.parse("2026-03-01T12:00:00.000Z");
    for (let index = 0; index < 3; index += 1) {
      await stub.recordAuditEvent(
        {
          eventType: "approval.decided",
          outcome: "allowed",
          requesterKind: "agent",
          requesterId: "agent-1",
          operatingOwnerId: "member-1",
          approverId: "member-1",
        },
        day + index,
      );
    }

    const anchorAt = day + DAY_MS;
    await stub.scheduleWork([{ id: "anchor.day", kind: "audit_anchor", dueAt: anchorAt }], anchorAt);
    const report = await stub.runDueWork(anchorAt);
    expect(report.processed).toContain("anchor.day");
    expect(report.anchor).toMatchObject({
      day: "2026-03-01",
      firstSequence: 1,
      lastSequence: 3,
      entryCount: 3,
    });

    await runInDurableObject<Workspace, void>(stub, (_instance, state) => {
      const stored = state.storage.sql
        .exec<{ day: string; chain_hash: string }>("SELECT day, chain_hash FROM audit_anchors")
        .one();
      const head = state.storage.sql
        .exec<{ entry_hash: string }>("SELECT entry_hash FROM audit_events WHERE sequence = 3")
        .one();
      expect(stored.day).toBe("2026-03-01");
      expect(stored.chain_hash).toBe(head.entry_hash);

      // Tamper, then prove the next anchoring run refuses rather than sealing over it.
      state.storage.sql.exec("DROP TRIGGER audit_events_append_only_update");
      state.storage.sql.exec("UPDATE audit_events SET outcome = 'denied' WHERE sequence = 1");
    });

    const secondAnchor = anchorAt + DAY_MS;
    await stub.scheduleWork([{ id: "anchor.day.2", kind: "audit_anchor", dueAt: secondAnchor }], secondAnchor);
    const broken = await stub.runDueWork(secondAnchor);
    expect(broken.processed).not.toContain("anchor.day.2");
    expect(broken.failed[0]).toMatchObject({
      id: "anchor.day.2",
      kind: "audit_anchor",
      retried: true,
    });
    expect(broken.failed[0].error).toContain("audit chain verification failed at sequence 1");
  });
});

describe("workspace retention sweep", () => {
  it("RETENTION-INT-001 sweeps each expiry class exactly at its boundary", async () => {
    const stub = env.WORKSPACE.getByName("retention-classes");
    const now = Date.parse("2027-05-01T00:00:00.000Z");

    await runInDurableObject<Workspace, void>(stub, (_instance, state) => {
      const sql = state.storage.sql;
      // Two rows per class: one exactly expired, one a millisecond early.
      sql.exec(
        `INSERT INTO idempotency_keys(scope, key, request_hash, response_json, status_code, created_at, expires_at)
         VALUES ('s', 'expired', 'h', '{}', 200, 0, ?), ('s', 'live', 'h', '{}', 200, 0, ?)`,
        now,
        now + 1,
      );
      sql.exec(
        `INSERT INTO replay_events(kind, audience_json, payload_json, created_at)
         VALUES ('k', '[]', '{}', ?), ('k', '[]', '{}', ?)`,
        now - RETENTION_MS.replayEvent,
        now - RETENTION_MS.replayEvent + 1,
      );
      sql.exec(
        `INSERT INTO pending_events(id, kind, payload_json, attempts, next_attempt_at, created_at, completed_at, status)
         VALUES ('delivered-expired', 'k', '{}', 1, 0, 0, ?, 'delivered'),
                ('delivered-live', 'k', '{}', 1, 0, 0, ?, 'delivered'),
                ('dead-expired', 'k', '{}', 5, 0, 0, ?, 'dead'),
                ('dead-live', 'k', '{}', 5, 0, 0, ?, 'dead'),
                ('pending-forever', 'k', '{}', 0, ?, 0, NULL, 'pending')`,
        now - RETENTION_MS.deliveredOutbox,
        now - RETENTION_MS.deliveredOutbox + 1,
        now - RETENTION_MS.deadOutbox,
        now - RETENTION_MS.deadOutbox + 1,
        now + 3_600_000,
      );
      sql.exec(
        `INSERT INTO due_work_failures(work_id, kind, attempts, error, failed_at)
         VALUES ('w', 'k', 5, 'e', ?), ('w', 'k', 5, 'e', ?)`,
        now - RETENTION_MS.schedulerFailure,
        now - RETENTION_MS.schedulerFailure + 1,
      );
    });

    await stub.scheduleWork([{ id: "sweep.now", kind: "retention_sweep", dueAt: now }], now);
    const report = await stub.runDueWork(now);
    expect(report.retention).toEqual({
      idempotencyResult: 1,
      replayEvent: 1,
      deliveredOutbox: 1,
      deadOutbox: 1,
      schedulerFailure: 1,
      auditEvent: 0,
    });

    await runInDurableObject<Workspace, void>(stub, (_instance, state) => {
      const ids = (query: string): string[] =>
        state.storage.sql.exec<{ id: string }>(query).toArray().map((row) => row.id);
      expect(ids("SELECT key AS id FROM idempotency_keys")).toEqual(["live"]);
      expect(ids("SELECT id FROM pending_events ORDER BY id")).toEqual([
        "dead-live",
        "delivered-live",
        "pending-forever",
      ]);
      expect(
        state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM replay_events").one().count,
      ).toBe(1);
      expect(
        state.storage.sql
          .exec<{ count: number }>("SELECT COUNT(*) AS count FROM due_work_failures")
          .one().count,
      ).toBe(1);
    });
  });

  it("RETENTION-INT-002 purges only anchored expired audit entries and keeps the chain verifiable", async () => {
    const stub = env.WORKSPACE.getByName("retention-audit");
    const old = Date.parse("2025-01-15T12:00:00.000Z");

    for (let index = 0; index < 3; index += 1) {
      await stub.recordAuditEvent(
        { eventType: "session.revoked", outcome: "allowed", requesterKind: "member", requesterId: "member-1" },
        old + index,
      );
    }
    const recent = old + 300 * DAY_MS;
    await stub.recordAuditEvent(
      { eventType: "session.revoked", outcome: "allowed", requesterKind: "member", requesterId: "member-2" },
      recent,
    );

    // Expired but not yet anchored: retention must not touch it.
    const sweepAt = old + 366 * DAY_MS;
    await stub.scheduleWork([{ id: "sweep.audit", kind: "retention_sweep", dueAt: sweepAt }], sweepAt);
    expect((await stub.runDueWork(sweepAt)).retention).toMatchObject({ auditEvent: 0 });
    expect(await stub.auditTrail()).toHaveLength(4);

    const anchorAt = old + DAY_MS;
    await stub.scheduleWork([{ id: "anchor.audit", kind: "audit_anchor", dueAt: anchorAt }], anchorAt);
    expect((await stub.runDueWork(anchorAt)).anchor).toMatchObject({ lastSequence: 3 });

    await stub.scheduleWork([{ id: "sweep.audit.2", kind: "retention_sweep", dueAt: sweepAt }], sweepAt);
    expect((await stub.runDueWork(sweepAt)).retention).toMatchObject({ auditEvent: 3 });

    const remaining = await stub.auditTrail();
    expect(remaining.map((entry) => entry.sequence)).toEqual([4]);
    // Verification resumes from the purged head rather than from genesis.
    expect(await stub.verifyAuditTrail()).toMatchObject({ ok: true, entryCount: 1 });

    await runInDurableObject<Workspace, void>(stub, (_instance, state) => {
      const retention = state.storage.sql
        .exec<{ purged_through_sequence: number; purged_through_hash: string; release_through_sequence: number }>(
          "SELECT purged_through_sequence, purged_through_hash, release_through_sequence FROM audit_retention",
        )
        .one();
      expect(retention.purged_through_sequence).toBe(3);
      expect(retention.purged_through_hash).toMatch(/^[0-9a-f]{64}$/);
      // The release closed behind the purge, so nothing else can be deleted.
      expect(retention.release_through_sequence).toBe(0);
      expect(() => state.storage.sql.exec("DELETE FROM audit_events WHERE sequence = 4")).toThrow(
        /retention release/,
      );
    });

    // The chain continues from the surviving head.
    await stub.recordAuditEvent(
      { eventType: "session.revoked", outcome: "allowed", requesterKind: "member", requesterId: "member-3" },
      recent + 1,
    );
    expect(await stub.verifyAuditTrail()).toMatchObject({ ok: true, entryCount: 2 });
  });
});
