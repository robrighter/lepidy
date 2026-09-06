import {
  assertRedactedAuditMetadata,
  auditGenesisHash,
  computeAuditEntryHash,
  verifyAuditChain,
  type AuditChainVerification,
  type AuditEntryInput,
  type AuditMetadata,
  type AuditOutcome,
  type AuditRequesterKind,
  type StoredAuditEntry,
} from "../domain/audit-chain";
import {
  DUE_WORK_BASE_BACKOFF_MS,
  DUE_WORK_MAX_ATTEMPTS,
  DUE_WORK_MAX_BACKOFF_MS,
  OUTBOX_BASE_BACKOFF_MS,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_MAX_BACKOFF_MS,
  RETENTION_MS,
  dayBucket,
  nextAttemptAt,
  nextRecurrence,
  parseDueWorkId,
  redactedError,
  type JsonValue,
  type RetentionClass,
} from "../domain/due-work";

export type DueWorkInput = {
  id: string;
  kind: string;
  dueAt: number;
  /** Present for recurring work such as the daily sweep. */
  intervalMs?: number | null;
  payload?: JsonValue;
};

export type DueWorkRow = {
  id: string;
  kind: string;
  dueAt: number;
  intervalMs: number | null;
  payload: JsonValue;
  attempts: number;
};

export type OutboxEventInput = {
  id: string;
  kind: string;
  payload: JsonValue;
  /**
   * Stable across retries of the originating request. A second enqueue with the
   * same key is dropped, so a replayed mutation never produces a second delivery.
   */
  dedupeKey?: string | null;
  maxAttempts?: number;
  availableAt?: number;
};

export type OutboxEntry = {
  id: string;
  kind: string;
  payload: JsonValue;
  dedupeKey: string | null;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
};

export type OutboxOutcome =
  | { status: "delivered" }
  | { status: "retry"; error: string }
  | { status: "permanent"; error: string };

export type OutboxDispatcher = (entry: OutboxEntry) => Promise<OutboxOutcome> | OutboxOutcome;

export type ReplayEventInput = {
  kind: string;
  audience: readonly string[];
  payload: JsonValue;
};

export type MutationEffects = {
  audit?: AuditEntryInput;
  outbox?: readonly OutboxEventInput[];
  replay?: readonly ReplayEventInput[];
  dueWork?: readonly DueWorkInput[];
};

export type AppendedAudit = { sequence: number; entryHash: string };

const OUTBOX_BACKOFF = { baseMs: OUTBOX_BASE_BACKOFF_MS, maxMs: OUTBOX_MAX_BACKOFF_MS };
const DUE_WORK_BACKOFF = { baseMs: DUE_WORK_BASE_BACKOFF_MS, maxMs: DUE_WORK_MAX_BACKOFF_MS };

function requireWorkId(value: string): string {
  const parsed = parseDueWorkId(value);
  if (parsed === null) throw new Error(`invalid durable work id: ${String(value).slice(0, 64)}`);
  return parsed;
}

function requireTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a whole millisecond timestamp`);
  return value;
}

/* -------------------------------------------------------------------------- */
/* Due-work scheduler                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Upsert scheduled work, keeping the earliest deadline. Two callers racing to
 * schedule the same logical item collapse into one row rather than firing twice.
 */
export function scheduleDueWork(
  storage: DurableObjectStorage,
  items: readonly DueWorkInput[],
  now: number,
): void {
  requireTimestamp(now, "now");
  for (const item of items) {
    const id = requireWorkId(item.id);
    requireTimestamp(item.dueAt, `due date for ${id}`);
    if (item.intervalMs !== undefined && item.intervalMs !== null && (!Number.isInteger(item.intervalMs) || item.intervalMs <= 0)) {
      throw new Error(`recurring work ${id} needs a positive interval`);
    }
    storage.sql.exec(
      `INSERT INTO due_work(id, kind, due_at, interval_ms, payload_json, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         due_at = MIN(due_work.due_at, excluded.due_at),
         interval_ms = COALESCE(excluded.interval_ms, due_work.interval_ms),
         payload_json = excluded.payload_json,
         updated_at = excluded.updated_at`,
      id,
      item.kind,
      item.dueAt,
      item.intervalMs ?? null,
      JSON.stringify(item.payload ?? null),
      now,
      now,
    );
  }
}

/** Insert recurring baseline work once; never move a deadline that already exists. */
export function ensureRecurringWork(
  storage: DurableObjectStorage,
  items: readonly DueWorkInput[],
  now: number,
): void {
  for (const item of items) {
    const id = requireWorkId(item.id);
    storage.sql.exec(
      `INSERT INTO due_work(id, kind, due_at, interval_ms, payload_json, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      id,
      item.kind,
      item.dueAt,
      item.intervalMs ?? null,
      JSON.stringify(item.payload ?? null),
      now,
      now,
    );
  }
}

export function nextDueAt(storage: DurableObjectStorage): number | null {
  const row = storage.sql
    .exec<{ due_at: number | null }>("SELECT MIN(due_at) AS due_at FROM due_work")
    .one();
  return row.due_at;
}

export function listDueWork(storage: DurableObjectStorage): DueWorkRow[] {
  return storage.sql
    .exec<{
      id: string;
      kind: string;
      due_at: number;
      interval_ms: number | null;
      payload_json: string;
      attempts: number;
    }>("SELECT id, kind, due_at, interval_ms, payload_json, attempts FROM due_work ORDER BY due_at, id")
    .toArray()
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      dueAt: row.due_at,
      intervalMs: row.interval_ms,
      payload: JSON.parse(row.payload_json) as JsonValue,
      attempts: row.attempts,
    }));
}

export function claimDueWork(storage: DurableObjectStorage, now: number, limit: number): DueWorkRow[] {
  return storage.sql
    .exec<{
      id: string;
      kind: string;
      due_at: number;
      interval_ms: number | null;
      payload_json: string;
      attempts: number;
    }>(
      `SELECT id, kind, due_at, interval_ms, payload_json, attempts
       FROM due_work WHERE due_at <= ? ORDER BY due_at, id LIMIT ?`,
      now,
      limit,
    )
    .toArray()
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      dueAt: row.due_at,
      intervalMs: row.interval_ms,
      payload: JSON.parse(row.payload_json) as JsonValue,
      attempts: row.attempts,
    }));
}

/** Remove one-shot work, or move recurring work onto its next unmissed slot. */
export function completeDueWork(storage: DurableObjectStorage, item: DueWorkRow, now: number): void {
  if (item.intervalMs === null) {
    storage.sql.exec("DELETE FROM due_work WHERE id = ?", item.id);
    return;
  }
  storage.sql.exec(
    "UPDATE due_work SET due_at = ?, attempts = 0, last_error = NULL, updated_at = ? WHERE id = ?",
    nextRecurrence(item.dueAt, item.intervalMs, now),
    now,
    item.id,
  );
}

/**
 * A handler failure backs the item off. Exhausting the attempt budget records a
 * redacted failure and drops the item so one broken kind cannot wedge the alarm.
 */
export function deferDueWork(
  storage: DurableObjectStorage,
  item: DueWorkRow,
  now: number,
  error: unknown,
): { retried: boolean; attempts: number } {
  const attempts = item.attempts + 1;
  const message = redactedError(error);
  if (attempts >= DUE_WORK_MAX_ATTEMPTS) {
    storage.sql.exec(
      `INSERT INTO due_work_failures(work_id, kind, attempts, error, failed_at) VALUES (?, ?, ?, ?, ?)`,
      item.id,
      item.kind,
      attempts,
      message,
      now,
    );
    if (item.intervalMs === null) {
      storage.sql.exec("DELETE FROM due_work WHERE id = ?", item.id);
    } else {
      storage.sql.exec(
        "UPDATE due_work SET due_at = ?, attempts = 0, last_error = ?, updated_at = ? WHERE id = ?",
        nextRecurrence(item.dueAt, item.intervalMs, now),
        message,
        now,
        item.id,
      );
    }
    return { retried: false, attempts };
  }
  storage.sql.exec(
    "UPDATE due_work SET attempts = ?, due_at = ?, last_error = ?, updated_at = ? WHERE id = ?",
    attempts,
    nextAttemptAt(now, attempts, DUE_WORK_BACKOFF),
    message,
    now,
    item.id,
  );
  return { retried: true, attempts };
}

/* -------------------------------------------------------------------------- */
/* Transactional outbox                                                        */
/* -------------------------------------------------------------------------- */

export function enqueueOutbox(
  storage: DurableObjectStorage,
  events: readonly OutboxEventInput[],
  now: number,
): number {
  let queued = 0;
  for (const event of events) {
    const id = requireWorkId(event.id);
    const maxAttempts = event.maxAttempts ?? OUTBOX_MAX_ATTEMPTS;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error(`outbox event ${id} needs a positive attempt budget`);
    }
    if (event.dedupeKey) {
      const existing = storage.sql
        .exec<{ id: string }>("SELECT id FROM pending_events WHERE dedupe_key = ?", event.dedupeKey)
        .toArray()[0];
      if (existing) continue;
    }
    const result = storage.sql.exec(
      `INSERT INTO pending_events(
         id, kind, payload_json, attempts, next_attempt_at, created_at, status, dedupe_key, max_attempts
       ) VALUES (?, ?, ?, 0, ?, ?, 'pending', ?, ?)
       ON CONFLICT(id) DO NOTHING`,
      id,
      event.kind,
      JSON.stringify(event.payload ?? null),
      event.availableAt ?? now,
      now,
      event.dedupeKey ?? null,
      maxAttempts,
    );
    if (result.rowsWritten > 0) queued += 1;
  }
  return queued;
}

export function claimOutboxBatch(storage: DurableObjectStorage, now: number, limit: number): OutboxEntry[] {
  return storage.sql
    .exec<{
      id: string;
      kind: string;
      payload_json: string;
      dedupe_key: string | null;
      attempts: number;
      max_attempts: number;
      created_at: number;
    }>(
      `SELECT id, kind, payload_json, dedupe_key, attempts, max_attempts, created_at
       FROM pending_events
       WHERE status = 'pending' AND next_attempt_at <= ?
       ORDER BY next_attempt_at, created_at, id LIMIT ?`,
      now,
      limit,
    )
    .toArray()
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      payload: JSON.parse(row.payload_json) as JsonValue,
      dedupeKey: row.dedupe_key,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      createdAt: row.created_at,
    }));
}

export function settleOutbox(
  storage: DurableObjectStorage,
  entry: OutboxEntry,
  outcome: OutboxOutcome,
  now: number,
): "delivered" | "pending" | "dead" {
  const attempts = entry.attempts + 1;
  if (outcome.status === "delivered") {
    storage.sql.exec(
      `UPDATE pending_events SET status = 'delivered', attempts = ?, completed_at = ?, last_error = NULL
       WHERE id = ? AND status = 'pending'`,
      attempts,
      now,
      entry.id,
    );
    return "delivered";
  }
  const message = redactedError(outcome.error);
  if (outcome.status === "permanent" || attempts >= entry.maxAttempts) {
    storage.sql.exec(
      `UPDATE pending_events SET status = 'dead', attempts = ?, completed_at = ?, last_error = ?
       WHERE id = ? AND status = 'pending'`,
      attempts,
      now,
      message,
      entry.id,
    );
    return "dead";
  }
  storage.sql.exec(
    `UPDATE pending_events SET attempts = ?, next_attempt_at = ?, last_error = ?
     WHERE id = ? AND status = 'pending'`,
    attempts,
    nextAttemptAt(now, attempts, OUTBOX_BACKOFF),
    message,
    entry.id,
  );
  return "pending";
}

export function nextPendingOutboxAt(storage: DurableObjectStorage): number | null {
  return storage.sql
    .exec<{ due_at: number | null }>(
      "SELECT MIN(next_attempt_at) AS due_at FROM pending_events WHERE status = 'pending'",
    )
    .one().due_at;
}

export function appendReplayEvents(
  storage: DurableObjectStorage,
  events: readonly ReplayEventInput[],
  now: number,
): number {
  for (const event of events) {
    storage.sql.exec(
      "INSERT INTO replay_events(kind, audience_json, payload_json, created_at) VALUES (?, ?, ?, ?)",
      event.kind,
      JSON.stringify([...event.audience]),
      JSON.stringify(event.payload ?? null),
      now,
    );
  }
  return events.length;
}

/* -------------------------------------------------------------------------- */
/* Audit chain                                                                 */
/* -------------------------------------------------------------------------- */

type AuditRetentionRow = {
  purged_through_sequence: number;
  purged_through_hash: string;
  release_through_sequence: number;
};

function auditRetention(storage: DurableObjectStorage): AuditRetentionRow {
  return storage.sql
    .exec<AuditRetentionRow>(
      "SELECT purged_through_sequence, purged_through_hash, release_through_sequence FROM audit_retention WHERE singleton = 1",
    )
    .one();
}

/** The hash a verification run starts from: genesis, or the last purged entry. */
export function auditChainAnchorHash(storage: DurableObjectStorage, workspaceKey: string): {
  startHash: string;
  startSequence: number;
} {
  const retention = auditRetention(storage);
  if (retention.purged_through_sequence > 0 && retention.purged_through_hash !== "") {
    return { startHash: retention.purged_through_hash, startSequence: retention.purged_through_sequence + 1 };
  }
  return { startHash: auditGenesisHash(workspaceKey), startSequence: 1 };
}

export function appendAuditEntry(
  storage: DurableObjectStorage,
  workspaceKey: string,
  entry: AuditEntryInput,
  now: number,
): AppendedAudit {
  requireTimestamp(now, "audit timestamp");
  assertRedactedAuditMetadata(entry.metadata);

  const head = storage.sql
    .exec<{ sequence: number | null; entry_hash: string | null }>(
      `SELECT sequence, entry_hash FROM audit_events ORDER BY sequence DESC LIMIT 1`,
    )
    .toArray()[0];
  const anchor = auditChainAnchorHash(storage, workspaceKey);
  const previousHash = head?.entry_hash ?? anchor.startHash;
  const sequence = (head?.sequence ?? anchor.startSequence - 1) + 1;

  const entryHash = computeAuditEntryHash({
    ...entry,
    workspaceKey,
    sequence,
    recordedAt: now,
    previousHash,
  });

  storage.sql.exec(
    `INSERT INTO audit_events(
       sequence, event_type, outcome, requester_kind, requester_id, operating_owner_id, approver_id,
       subject_kind, subject_id, metadata_json, recorded_at, previous_hash, entry_hash
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    sequence,
    entry.eventType,
    entry.outcome,
    entry.requesterKind,
    entry.requesterId ?? null,
    entry.operatingOwnerId ?? null,
    entry.approverId ?? null,
    entry.subjectKind ?? null,
    entry.subjectId ?? null,
    JSON.stringify(entry.metadata ?? {}),
    now,
    previousHash,
    entryHash,
  );

  return { sequence, entryHash };
}

export function readAuditEntries(
  storage: DurableObjectStorage,
  workspaceKey: string,
  fromSequence = 0,
  limit = 1_000,
): StoredAuditEntry[] {
  return storage.sql
    .exec<{
      sequence: number;
      event_type: string;
      outcome: AuditOutcome;
      requester_kind: AuditRequesterKind;
      requester_id: string | null;
      operating_owner_id: string | null;
      approver_id: string | null;
      subject_kind: string | null;
      subject_id: string | null;
      metadata_json: string;
      recorded_at: number;
      previous_hash: string;
      entry_hash: string;
    }>(
      `SELECT sequence, event_type, outcome, requester_kind, requester_id, operating_owner_id, approver_id,
              subject_kind, subject_id, metadata_json, recorded_at, previous_hash, entry_hash
       FROM audit_events WHERE sequence > ? ORDER BY sequence LIMIT ?`,
      fromSequence,
      limit,
    )
    .toArray()
    .map((row) => ({
      workspaceKey,
      sequence: row.sequence,
      eventType: row.event_type,
      outcome: row.outcome,
      requesterKind: row.requester_kind,
      requesterId: row.requester_id,
      operatingOwnerId: row.operating_owner_id,
      approverId: row.approver_id,
      subjectKind: row.subject_kind,
      subjectId: row.subject_id,
      metadata: JSON.parse(row.metadata_json) as AuditMetadata,
      recordedAt: row.recorded_at,
      previousHash: row.previous_hash,
      entryHash: row.entry_hash,
    }));
}

export function verifyStoredAuditChain(
  storage: DurableObjectStorage,
  workspaceKey: string,
): AuditChainVerification {
  const anchor = auditChainAnchorHash(storage, workspaceKey);
  return verifyAuditChain(readAuditEntries(storage, workspaceKey), anchor);
}

export type AuditAnchor = {
  day: string;
  firstSequence: number;
  lastSequence: number;
  entryCount: number;
  chainHash: string;
};

/**
 * Anchor the chain for a completed day. Verification runs first, so a tampered
 * chain is refused rather than sealed over.
 */
export function writeAuditAnchor(
  storage: DurableObjectStorage,
  workspaceKey: string,
  now: number,
): AuditAnchor | null {
  const verification = verifyStoredAuditChain(storage, workspaceKey);
  if (!verification.ok) {
    throw new Error(
      `audit chain verification failed at sequence ${verification.brokenAtSequence}: ${verification.reason}`,
    );
  }
  const day = dayBucket(now - RETENTION_MS.idempotencyResult);
  const dayStart = Date.parse(`${day}T00:00:00.000Z`);
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;
  const bounds = storage.sql
    .exec<{ first_sequence: number | null; last_sequence: number | null; entry_count: number }>(
      `SELECT MIN(sequence) AS first_sequence, MAX(sequence) AS last_sequence, COUNT(*) AS entry_count
       FROM audit_events WHERE recorded_at >= ? AND recorded_at < ?`,
      dayStart,
      dayEnd,
    )
    .one();
  if (bounds.first_sequence === null || bounds.last_sequence === null) return null;

  const chainHash = storage.sql
    .exec<{ entry_hash: string }>("SELECT entry_hash FROM audit_events WHERE sequence = ?", bounds.last_sequence)
    .one().entry_hash;

  storage.sql.exec(
    `INSERT INTO audit_anchors(day, first_sequence, last_sequence, entry_count, chain_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET
       first_sequence = excluded.first_sequence,
       last_sequence = excluded.last_sequence,
       entry_count = excluded.entry_count,
       chain_hash = excluded.chain_hash,
       created_at = excluded.created_at`,
    day,
    bounds.first_sequence,
    bounds.last_sequence,
    bounds.entry_count,
    chainHash,
    now,
  );

  return {
    day,
    firstSequence: bounds.first_sequence,
    lastSequence: bounds.last_sequence,
    entryCount: bounds.entry_count,
    chainHash,
  };
}

/* -------------------------------------------------------------------------- */
/* Retention sweep                                                             */
/* -------------------------------------------------------------------------- */

export type RetentionSweepReport = Record<RetentionClass, number>;

/**
 * Delete rows whose D07 retention clock has expired. Audit entries are released
 * through the retention row first: the delete trigger refuses anything newer, so
 * an operator cannot quietly drop recent evidence.
 */
export function sweepRetention(storage: DurableObjectStorage, now: number): RetentionSweepReport {
  requireTimestamp(now, "sweep time");
  const deleted = (statement: string, ...bindings: unknown[]): number =>
    storage.sql.exec(statement, ...bindings).rowsWritten;

  const report: RetentionSweepReport = {
    idempotencyResult: deleted("DELETE FROM idempotency_keys WHERE expires_at <= ?", now),
    replayEvent: deleted("DELETE FROM replay_events WHERE created_at <= ?", now - RETENTION_MS.replayEvent),
    deliveredOutbox: deleted(
      "DELETE FROM pending_events WHERE status = 'delivered' AND completed_at <= ?",
      now - RETENTION_MS.deliveredOutbox,
    ),
    deadOutbox: deleted(
      "DELETE FROM pending_events WHERE status = 'dead' AND completed_at <= ?",
      now - RETENTION_MS.deadOutbox,
    ),
    schedulerFailure: deleted(
      "DELETE FROM due_work_failures WHERE failed_at <= ?",
      now - RETENTION_MS.schedulerFailure,
    ),
    auditEvent: purgeExpiredAudit(storage, now),
  };

  return report;
}

function purgeExpiredAudit(storage: DurableObjectStorage, now: number): number {
  const cutoff = now - RETENTION_MS.auditEvent;
  const anchoredThrough = storage.sql
    .exec<{ last_sequence: number | null }>("SELECT MAX(last_sequence) AS last_sequence FROM audit_anchors")
    .one().last_sequence;
  if (anchoredThrough === null) return 0;

  const floor = storage.sql
    .exec<{ sequence: number | null }>(
      "SELECT MAX(sequence) AS sequence FROM audit_events WHERE recorded_at <= ? AND sequence <= ?",
      cutoff,
      anchoredThrough,
    )
    .one().sequence;
  if (floor === null) return 0;

  const retention = auditRetention(storage);
  if (floor <= retention.purged_through_sequence) return 0;

  const floorHash = storage.sql
    .exec<{ entry_hash: string }>("SELECT entry_hash FROM audit_events WHERE sequence = ?", floor)
    .one().entry_hash;

  storage.sql.exec(
    "UPDATE audit_retention SET release_through_sequence = ?, updated_at = ? WHERE singleton = 1",
    floor,
    now,
  );
  const removed = storage.sql.exec("DELETE FROM audit_events WHERE sequence <= ?", floor).rowsWritten;
  storage.sql.exec(
    `UPDATE audit_retention
     SET purged_through_sequence = ?, purged_through_hash = ?, release_through_sequence = 0, updated_at = ?
     WHERE singleton = 1`,
    floor,
    floorHash,
    now,
    );
  return removed;
}
