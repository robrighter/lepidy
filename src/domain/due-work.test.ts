import { describe, expect, it } from "vitest";

import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  OUTBOX_BASE_BACKOFF_MS,
  OUTBOX_MAX_BACKOFF_MS,
  RETENTION_MS,
  dayBucket,
  earliestDueAt,
  nextAttemptAt,
  nextRecurrence,
  parseDueWorkId,
  redactedError,
  retryDelayMs,
} from "./due-work";

const OUTBOX = { baseMs: OUTBOX_BASE_BACKOFF_MS, maxMs: OUTBOX_MAX_BACKOFF_MS };

describe("due work scheduling rules", () => {
  it("SCHED-RULE-001 backs off deterministically and saturates at the ceiling", () => {
    expect([1, 2, 3, 4, 5].map((attempt) => retryDelayMs(attempt, OUTBOX))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000,
    ]);
    expect(retryDelayMs(40, OUTBOX)).toBe(OUTBOX_MAX_BACKOFF_MS);
    expect(retryDelayMs(3, OUTBOX)).toBe(retryDelayMs(3, OUTBOX));
    expect(nextAttemptAt(5_000, 2, OUTBOX)).toBe(7_000);
    expect(() => retryDelayMs(0, OUTBOX)).toThrow(/positive integer/);
  });

  it("SCHED-RULE-002 picks the earliest of several competing deadlines", () => {
    expect(earliestDueAt([{ dueAt: 500 }, { dueAt: 100 }, { dueAt: 300 }])).toBe(100);
    expect(earliestDueAt([])).toBeNull();
  });

  it("SCHED-RULE-003 collapses every slot missed while the object was evicted", () => {
    const start = 1_000;
    expect(nextRecurrence(start, DAY_MS, 500)).toBe(start);
    expect(nextRecurrence(start, DAY_MS, start)).toBe(start + DAY_MS);
    expect(nextRecurrence(start, DAY_MS, start + 10 * DAY_MS + 5)).toBe(start + 11 * DAY_MS);
    expect(() => nextRecurrence(start, 0, start)).toThrow(/positive interval/);
  });

  it("SCHED-RULE-004 names a UTC day bucket for the daily audit anchor", () => {
    expect(dayBucket(Date.parse("2026-09-06T23:59:59.999Z"))).toBe("2026-09-06");
    expect(dayBucket(Date.parse("2026-09-07T00:00:00.000Z"))).toBe("2026-09-07");
  });

  it("SCHED-RULE-005 keeps work ids transport safe", () => {
    expect(parseDueWorkId("system:retention_sweep")).toBe("system:retention_sweep");
    expect(parseDueWorkId("member_projection.op-1")).toBe("member_projection.op-1");
    expect(parseDueWorkId("")).toBeNull();
    expect(parseDueWorkId("has space")).toBeNull();
    expect(parseDueWorkId("-leading")).toBeNull();
    expect(parseDueWorkId(`a${"b".repeat(128)}`)).toBeNull();
    expect(parseDueWorkId(42)).toBeNull();
  });

  it("SCHED-RULE-006 bounds and flattens errors that reach retention tables", () => {
    expect(redactedError(new Error("failed\n  because of\tthings"))).toBe("failed because of things");
    expect(redactedError("x".repeat(500))).toHaveLength(200);
  });

  it("SCHED-RULE-007 states the D07 retention clocks once", () => {
    expect(RETENTION_MS).toEqual({
      idempotencyResult: 24 * HOUR_MS,
      replayEvent: 7 * DAY_MS,
      deliveredOutbox: 24 * HOUR_MS,
      deadOutbox: 30 * DAY_MS,
      schedulerFailure: 30 * DAY_MS,
      auditEvent: 365 * DAY_MS,
    });
    expect(HOUR_MS).toBe(60 * MINUTE_MS);
  });
});
