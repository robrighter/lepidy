/**
 * Scheduler, outbox and retention rules shared by the workspace Durable Object
 * and its tests. A Durable Object owns exactly one alarm, so every deadline the
 * tenant has multiplexes through one due-work table (HLD §10.3) and every clock
 * here is injected rather than read from `Date.now`.
 */

/**
 * Payloads cross the Durable Object RPC boundary. The depth is bounded rather
 * than recursive: the Workers RPC type mapper cannot resolve a self-referential
 * JSON type, and scheduler and outbox payloads are records of identifiers and
 * counters, never documents.
 */
export type JsonPrimitive = string | number | boolean | null;
export type JsonLeaf = JsonPrimitive | readonly JsonPrimitive[];
export type JsonRecord = { readonly [key: string]: JsonLeaf | { readonly [key: string]: JsonLeaf } };
export type JsonValue = JsonLeaf | JsonRecord | readonly JsonRecord[];

export const SECOND_MS = 1_000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Retention clocks from the D07 contract, expressed once. */
export const RETENTION_MS = {
  idempotencyResult: 24 * HOUR_MS,
  replayEvent: 7 * DAY_MS,
  deliveredOutbox: 24 * HOUR_MS,
  deadOutbox: 30 * DAY_MS,
  schedulerFailure: 30 * DAY_MS,
  auditEvent: 365 * DAY_MS,
} as const;

export type RetentionClass = keyof typeof RETENTION_MS;

export const OUTBOX_MAX_ATTEMPTS = 5;
export const OUTBOX_BASE_BACKOFF_MS = SECOND_MS;
export const OUTBOX_MAX_BACKOFF_MS = 15 * MINUTE_MS;

export const DUE_WORK_MAX_ATTEMPTS = 5;
export const DUE_WORK_BASE_BACKOFF_MS = 5 * SECOND_MS;
export const DUE_WORK_MAX_BACKOFF_MS = HOUR_MS;

/** How many items one alarm invocation processes before re-arming. */
export const DUE_WORK_BATCH_SIZE = 32;
export const OUTBOX_BATCH_SIZE = 32;

export type BackoffOptions = { baseMs: number; maxMs: number };

/**
 * Deterministic exponential backoff. There is no jitter: a workspace object is a
 * single serialized actor, so jitter would only make failures unreproducible.
 */
export function retryDelayMs(attempts: number, options: BackoffOptions): number {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("retry attempt count must be a positive integer");
  }
  const exponent = Math.min(attempts - 1, 30);
  const delay = options.baseMs * 2 ** exponent;
  return Math.min(delay, options.maxMs);
}

export function nextAttemptAt(now: number, attempts: number, options: BackoffOptions): number {
  return now + retryDelayMs(attempts, options);
}

export function earliestDueAt(items: readonly { dueAt: number }[]): number | null {
  let earliest: number | null = null;
  for (const item of items) {
    if (earliest === null || item.dueAt < earliest) earliest = item.dueAt;
  }
  return earliest;
}

/**
 * Advance a recurring deadline onto the next slot strictly after `now`, skipping
 * every slot missed while the object was evicted. Catching up slot by slot would
 * turn a long eviction into a burst of duplicate sweeps.
 */
export function nextRecurrence(dueAt: number, intervalMs: number, now: number): number {
  if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
    throw new Error("recurring work needs a positive interval");
  }
  if (dueAt > now) return dueAt;
  const missed = Math.floor((now - dueAt) / intervalMs) + 1;
  return dueAt + missed * intervalMs;
}

/** UTC day bucket used to name a daily audit anchor. */
export function dayBucket(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

const WORK_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export function parseDueWorkId(value: unknown): string | null {
  if (typeof value !== "string" || !WORK_ID.test(value)) return null;
  return value;
}

/** Errors reach retention tables and diagnostics, so they are bounded and redacted. */
export function redactedError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replaceAll(/\s+/g, " ").trim().slice(0, 200);
}
