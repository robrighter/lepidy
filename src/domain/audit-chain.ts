import { createHash } from "node:crypto";

/**
 * Append-only workspace audit chain (D07 §6).
 *
 * Hashing is synchronous so an audit entry can commit inside the same SQLite
 * transaction as the mutation it describes. WebCrypto's digest is a promise and
 * cannot be used inside `storage.transactionSync`.
 */
export const AUDIT_CHAIN_VERSION = 1;

export type AuditOutcome = "allowed" | "denied" | "failed";
export type AuditRequesterKind = "member" | "agent" | "runner" | "system";
export type AuditMetadataValue = string | number | boolean | null;
export type AuditMetadata = Readonly<Record<string, AuditMetadataValue>>;

export type AuditEntryInput = {
  eventType: string;
  outcome: AuditOutcome;
  /** Who asked. */
  requesterKind: AuditRequesterKind;
  requesterId?: string | null;
  /** Whose authority the action ran under, when that differs from the requester. */
  operatingOwnerId?: string | null;
  /** Who approved it, when a decision was required. */
  approverId?: string | null;
  subjectKind?: string | null;
  subjectId?: string | null;
  metadata?: AuditMetadata;
};

export type AuditChainLink = AuditEntryInput & {
  workspaceKey: string;
  sequence: number;
  recordedAt: number;
  previousHash: string;
};

export type StoredAuditEntry = AuditChainLink & { entryHash: string };

export type AuditChainVerification =
  | { ok: true; entryCount: number; chainHash: string }
  | { ok: false; entryCount: number; brokenAtSequence: number; reason: string };

export const MAX_AUDIT_METADATA_KEYS = 24;
export const MAX_AUDIT_METADATA_KEY_LENGTH = 64;
export const MAX_AUDIT_METADATA_VALUE_LENGTH = 256;

/**
 * Audit metadata is redacted by construction: no message bodies, credential
 * values, vault material or local launch configuration may ever be hashed into
 * the chain, because the chain is exported and archived.
 */
const FORBIDDEN_METADATA_FRAGMENTS = [
  "argument",
  "argv",
  "body",
  "content",
  "cookie",
  "credential",
  "environment",
  "excerpt",
  "executable",
  "launch",
  "passphrase",
  "password",
  "plaintext",
  "private_key",
  "privatekey",
  "recovery",
  "secret",
  "token",
  "vault_root",
  "wrap",
] as const;

/**
 * Exact names only. `authorization` is a header; `authorization_epoch` is a
 * counter, and a substring rule would refuse the counter too.
 */
const FORBIDDEN_METADATA_NAMES = new Set(["authorization", "command", "message", "text", "value"]);

const METADATA_KEY = /^[a-z][a-z0-9_]*$/;

export function assertRedactedAuditMetadata(metadata: AuditMetadata | undefined): void {
  if (metadata === undefined) return;
  const keys = Object.keys(metadata);
  if (keys.length > MAX_AUDIT_METADATA_KEYS) {
    throw new Error(`audit metadata exceeds ${MAX_AUDIT_METADATA_KEYS} fields`);
  }
  for (const key of keys) {
    if (key.length > MAX_AUDIT_METADATA_KEY_LENGTH || !METADATA_KEY.test(key)) {
      throw new Error(`audit metadata field name is not a redacted identifier: ${key.slice(0, 64)}`);
    }
    const lowered = key.toLowerCase();
    const forbidden =
      FORBIDDEN_METADATA_NAMES.has(lowered) ||
      FORBIDDEN_METADATA_FRAGMENTS.some((fragment) => lowered.includes(fragment));
    if (forbidden) {
      throw new Error(`audit metadata rejects forbidden field: ${key}`);
    }
    const value = metadata[key];
    if (typeof value === "string" && value.length > MAX_AUDIT_METADATA_VALUE_LENGTH) {
      throw new Error(`audit metadata value for ${key} exceeds ${MAX_AUDIT_METADATA_VALUE_LENGTH} characters`);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`audit metadata value for ${key} is not a finite number`);
    }
    if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error(`audit metadata value for ${key} is not a scalar`);
    }
  }
}

/** Length-prefixed so no field value can imitate a field boundary. */
function field(value: string): string {
  return `${value.length}:${value}`;
}

export function canonicalAuditMetadata(metadata: AuditMetadata | undefined): string {
  if (metadata === undefined) return "";
  const keys = Object.keys(metadata).sort();
  return keys.map((key) => `${field(key)}=${field(JSON.stringify(metadata[key]))}`).join(",");
}

export function auditGenesisHash(workspaceKey: string): string {
  return createHash("sha256")
    .update(`lepidy.audit.genesis|${AUDIT_CHAIN_VERSION}|${field(workspaceKey)}`, "utf8")
    .digest("hex");
}

export function computeAuditEntryHash(link: AuditChainLink): string {
  assertRedactedAuditMetadata(link.metadata);
  const parts = [
    field(String(AUDIT_CHAIN_VERSION)),
    field(link.workspaceKey),
    field(String(link.sequence)),
    field(String(link.recordedAt)),
    field(link.eventType),
    field(link.outcome),
    field(link.requesterKind),
    field(link.requesterId ?? ""),
    field(link.operatingOwnerId ?? ""),
    field(link.approverId ?? ""),
    field(link.subjectKind ?? ""),
    field(link.subjectId ?? ""),
    field(canonicalAuditMetadata(link.metadata)),
    field(link.previousHash),
  ];
  return createHash("sha256").update(parts.join("|"), "utf8").digest("hex");
}

/**
 * Verify a contiguous run of stored entries against the hash that precedes it.
 * `startHash` is the genesis hash for an unpurged chain, or the hash of the last
 * entry removed by retention.
 */
export function verifyAuditChain(
  entries: readonly StoredAuditEntry[],
  options: { startHash: string; startSequence: number },
): AuditChainVerification {
  let previousHash = options.startHash;
  let expectedSequence = options.startSequence;
  let previousRecordedAt = Number.NEGATIVE_INFINITY;

  for (const entry of entries) {
    if (entry.sequence !== expectedSequence) {
      return {
        ok: false,
        entryCount: entries.length,
        brokenAtSequence: entry.sequence,
        reason: `expected sequence ${expectedSequence}`,
      };
    }
    if (entry.previousHash !== previousHash) {
      return {
        ok: false,
        entryCount: entries.length,
        brokenAtSequence: entry.sequence,
        reason: "previous hash does not match the preceding entry",
      };
    }
    if (entry.recordedAt < previousRecordedAt) {
      return {
        ok: false,
        entryCount: entries.length,
        brokenAtSequence: entry.sequence,
        reason: "recorded time moves backwards",
      };
    }
    let recomputed: string;
    try {
      recomputed = computeAuditEntryHash(entry);
    } catch (error) {
      return {
        ok: false,
        entryCount: entries.length,
        brokenAtSequence: entry.sequence,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (recomputed !== entry.entryHash) {
      return {
        ok: false,
        entryCount: entries.length,
        brokenAtSequence: entry.sequence,
        reason: "entry hash does not cover the stored fields",
      };
    }
    previousHash = entry.entryHash;
    previousRecordedAt = entry.recordedAt;
    expectedSequence += 1;
  }

  return { ok: true, entryCount: entries.length, chainHash: previousHash };
}
