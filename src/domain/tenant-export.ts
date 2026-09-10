/**
 * Taking a workspace out, and putting one back.
 *
 * These are two halves of one format, and they fail in opposite directions.
 * An export that omits something loses a customer's data. A restore that
 * includes something **brings authority back from the dead** — a session
 * somebody revoked, a delegation an offboarded owner granted, a credential
 * grant that was withdrawn during an incident. The second is worse, and it is
 * worse in a way nobody notices until it is used, so the refusals here are
 * structural rather than a checklist somebody follows.
 *
 * The organising idea: every record kind is classified once, in
 * [`RECORD_KINDS`], and both halves read that same table. A kind that is
 * exported for portability but must never be written back is marked exactly
 * that way, and the restore cannot write it because the classification is what
 * the restore is driven by — not a list of exceptions it remembers to check.
 */

import { PURGE_TABLES } from "./tenant-lifecycle";

/** The format version. A restore refuses anything it does not know. */
export const EXPORT_VERSION = 1;

/**
 * How long a server-side export chunk lives, downloaded or not.
 *
 * D07 §3. The chunks are a copy of a workspace's content sitting outside the
 * workspace, so their lifetime is a liability window: 24 hours is long enough
 * for a large export over a poor connection and short enough that an abandoned
 * one is not a second copy of somebody's messages lying around next month.
 */
export const CHUNK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * What a record kind is for.
 *
 * * `content` — the customer's own data. Exported, and restored.
 * * `settings` — durable product configuration. Exported, and restored.
 * * `authority` — **exported for the record, never restored.** Sessions,
 *   devices, delegations, grants, approvals, tokens. A person reading an export
 *   should be able to see who had access at the time, because that is often the
 *   whole reason an export was taken; putting it back is what D07 §4 forbids.
 * * `transient` — idempotency keys, nonces, queued work, replay events. Neither
 *   exported nor restored: they describe a moment that has passed, and a
 *   restored nonce is a replay window somebody already closed.
 */
export type RecordDisposition = "content" | "settings" | "authority" | "transient";

/**
 * Every table, classified once.
 *
 * Derived from the purge map so the two cannot drift: a table that exists is
 * purgeable, and this decides what happens to it in an export. The default is
 * deliberately **not** "content" — an unclassified table is a hard error, so
 * that a migration adding a table forces somebody to decide what an export and
 * a restore should do with it rather than silently taking one answer.
 */
export const RECORD_KINDS: Record<string, RecordDisposition> = {
  // Content: the conversations, the files, the things a customer would say are
  // theirs.
  messages: "content",
  message_mentions: "content",
  message_reactions: "content",
  message_snippets: "content",
  message_unfurls: "content",
  link_unfurls: "content",
  form_submission_content: "content",
  channels: "content",
  channel_members: "content",
  channel_pins: "content",
  channel_message_sequence: "content",
  saved_items: "content",
  custom_emoji: "content",
  files: "content",
  solo_upgrade_channels: "content",
  solo_upgrade_messages: "content",
  solo_upgrade_imports: "content",
  solo_upgrade_attachments: "content",
  members: "content",
  groups: "content",
  group_members: "content",
  agents: "content",
  agent_owners: "content",
  agent_scope_channels: "content",
  // The vault's ciphertext is content: it is the customer's, and Lepidy cannot
  // read it. What must never accompany it is a plaintext value or a
  // server-decryptable root, and there is none to accompany it — see
  // `assertVaultRecordIsCiphertextOnly`.
  vault_credentials: "content",
  vault_credential_key_wraps: "content",
  vault_member_keys: "content",
  audit_events: "content",
  audit_anchors: "content",

  // Settings: durable product configuration a restore should carry over.
  notification_preferences: "settings",
  channel_notification_preferences: "settings",
  notification_keywords: "settings",
  saved_searches: "settings",
  thread_subscriptions: "settings",
  vault_settings: "settings",
  agent_local_policies: "settings",
  vault_credential_acl: "settings",

  // Authority: exported so an export shows who had access, never restored.
  agent_sessions: "authority",
  agent_delegations: "authority",
  agent_session_write_limits: "authority",
  agent_session_message_attribution: "authority",
  mcp_write_limits: "authority",
  mcp_message_attribution: "authority",
  oauth_connections: "authority",
  oauth_codes: "authority",
  runner_devices: "authority",
  runner_agents: "authority",
  runner_preset_requests: "authority",
  agent_runtime_configs: "authority",
  vault_grants: "authority",
  vault_approvals: "authority",
  vault_approval_items: "authority",
  vault_approval_approvers: "authority",
  vault_credential_deletions: "authority",
  push_subscriptions: "authority",

  // Transient: a moment that has passed.
  export_runs: "transient",
  export_chunks: "transient",
  idempotency_keys: "transient",
  replay_events: "transient",
  pending_events: "transient",
  due_work: "transient",
  due_work_failures: "transient",
  applied_control_operations: "transient",
  agent_queue: "transient",
  runner_wakes: "transient",
  runtime_runs: "transient",
  custom_runtime_deliveries: "transient",
  anthropic_webhook_receipts: "transient",
  vault_proxy_requests: "transient",
  vault_usage_events: "transient",
  vault_canary_trips: "transient",
  notifications: "transient",
  message_drafts: "transient",
  scheduled_messages: "transient",
  channel_read_state: "transient",
  thread_read_state: "transient",
  audit_retention: "transient",
  // The search indexes are rebuilt from the content they index, so exporting
  // them would be exporting the same words twice.
  workspace_search: "transient",
  file_search: "transient",
  credential_search: "transient",
  form_submission_search: "transient",
};

export function dispositionOf(table: string): RecordDisposition {
  const disposition = RECORD_KINDS[table];
  if (disposition === undefined) {
    // A hard error rather than a default. A migration adding a table has to
    // make somebody decide, because both silent answers are wrong: silently
    // exporting could carry authority into a restore, and silently skipping
    // loses a customer's data with no sign that it happened.
    throw new Error(`${table} has no export disposition: classify it in RECORD_KINDS`);
  }
  return disposition;
}

/** What an export writes out, in an order a restore can insert in. */
export function exportedTables(): readonly string[] {
  return orderedTables().filter((table) => {
    const disposition = dispositionOf(table);
    return disposition === "content" || disposition === "settings" || disposition === "authority";
  });
}

/** What a restore may write. Never `authority`, never `transient`. */
export function restorableTables(): readonly string[] {
  return orderedTables().filter((table) => {
    const disposition = dispositionOf(table);
    return disposition === "content" || disposition === "settings";
  });
}

/**
 * Insert order, which is the reverse of purge order.
 *
 * A purge deletes attachments before content and members last, because of what
 * references what. A restore has to do the opposite, and deriving it rather
 * than writing a second list means the two can never disagree about which
 * table references which.
 */
function orderedTables(): readonly string[] {
  return [...Object.values(PURGE_TABLES).flat()].reverse();
}

/* -------------------------------------------------------------------------- */
/* Chunks                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A chunk's id, which is stable for a given export, table and offset.
 *
 * Stability is the whole of resumability: a client that lost its connection
 * asks for the same id and gets the same bytes, rather than a differently-sliced
 * export it cannot stitch to what it already has.
 */
export function chunkId(exportId: string, table: string, offset: number): string {
  if (!Number.isInteger(offset) || offset < 0) throw new Error("a chunk offset must be a whole number");
  return `${exportId}.${table}.${String(offset).padStart(9, "0")}`;
}

export type ChunkSummary = { id: string; rows: number; sha256: string };

/**
 * The manifest hash, over every chunk in order.
 *
 * Covers each chunk's id, row count and digest, so a manifest cannot be
 * reordered, truncated or have a chunk swapped without the final hash moving.
 * A checksum over the concatenated bytes alone would not catch reordering.
 */
export async function manifestHash(
  exportId: string,
  chunks: readonly ChunkSummary[],
): Promise<string> {
  const canonical = [
    `lepidy-export/${EXPORT_VERSION}`,
    exportId,
    ...chunks.map((chunk) => `${chunk.id}:${chunk.rows}:${chunk.sha256}`),
  ].join("\n");
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
}

export async function sha256(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/* -------------------------------------------------------------------------- */
/* What may not leave, and what may not come back                              */
/* -------------------------------------------------------------------------- */

/**
 * Fields that would mean the cloud had put a readable secret in an export.
 *
 * The vault is zero-knowledge: there is no server-side plaintext to export and
 * no server-decryptable root to accompany the ciphertext. This checks that
 * remains true of the rows actually being written, because the failure mode is
 * a future migration adding a convenience column — a cached name, a "last used
 * value", a decrypted preview — and an export is where that would first leave
 * the building.
 */
const FORBIDDEN_VAULT_FIELDS = [
  "value",
  "plaintext",
  "secret",
  "unwrapped",
  "vault_root",
  "recovery_code",
  "passphrase",
  "private_key",
];

export function assertVaultRecordIsCiphertextOnly(table: string, record: object): void {
  if (!table.startsWith("vault_")) return;
  for (const key of Object.keys(record)) {
    const lowered = key.toLowerCase();
    if (FORBIDDEN_VAULT_FIELDS.some((forbidden) => lowered === forbidden || lowered.endsWith(`_${forbidden}`))) {
      throw new Error(`${table}.${key} would put readable vault material in an export`);
    }
  }
}

export type RestoreDecision =
  | { write: true; table: string }
  | { write: false; table: string; because: RecordDisposition | "unknown_version" };

/**
 * Whether one exported table may be written into a replacement workspace.
 *
 * This is the function D07 §4's promise reduces to, and it is deliberately the
 * only way the restore decides. A restore that consulted a list of exclusions
 * would be one exclusion away from resurrecting a revoked grant; a restore
 * driven by the classification cannot write an `authority` row because there is
 * no branch in which it would.
 */
export function restoreDecision(table: string, version: number): RestoreDecision {
  if (version !== EXPORT_VERSION) return { write: false, table, because: "unknown_version" };
  const disposition = dispositionOf(table);
  if (disposition === "content" || disposition === "settings") return { write: true, table };
  return { write: false, table, because: disposition };
}

/**
 * What a restore always begins as, and why it is not optional.
 *
 * A replacement workspace is quarantined until its verification passes, and it
 * takes a **new routing epoch** so that anything still holding the old one —
 * a socket, a signed device request, a runner lease — is refused rather than
 * silently accepted against restored data. The epoch is the mechanism that
 * makes "does not resurrect a live session" true for the sessions this object
 * never saw.
 */
export function replacementRoutingEpoch(previous: number): number {
  if (!Number.isInteger(previous) || previous < 1) throw new Error("a routing epoch is a positive integer");
  return previous + 1;
}
