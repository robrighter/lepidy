/**
 * Deleting a workspace, and proving afterwards that it is gone.
 *
 * The whole of this file is shaped by one asymmetry: **a purge cannot be
 * undone.** Every other destructive thing in this product is recoverable —
 * a revoked grant can be granted again, an offboarded member can be re-invited,
 * a deleted message leaves a tombstone. This removes a company's conversations,
 * their attachments and their credential ciphertext, and no amount of authority
 * afterwards brings any of it back.
 *
 * So the gate is deliberately awkward, the window exists so that a mistake has
 * somewhere to be noticed, and skipping the window is its own separate act
 * rather than a checkbox on the first one.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a deleted workspace stays recoverable.
 *
 * Seven days rather than a day: the person who deletes a workspace is often not
 * the person who notices, and the ones who notice are the ones who come back
 * from a weekend to find their workspace missing.
 */
export const CANCELLATION_WINDOW_MS = 7 * DAY_MS;

/** How long a deletion receipt is kept. Ids, counts and hashes only. */
export const RECEIPT_RETENTION_MS = 30 * DAY_MS;

export type DeletionRequest = {
  workspaceId: string;
  requestedByMemberId: string;
  requestedAt: number;
  /** The moment the purge may begin without an explicit skip. */
  purgeAfter: number;
};

/**
 * The exact phrase somebody has to type to delete a workspace.
 *
 * The workspace's own slug, for the same reason ownership transfer asks for the
 * destination's handle: a confirmation somebody can satisfy without reading it
 * is a confirmation that does not exist. "DELETE" would be muscle memory within
 * a week; the name of the thing being destroyed cannot be typed absent-mindedly.
 */
export function deletionConfirmation(slug: string): string {
  return slug.trim().toLowerCase();
}

export function planDeletion(input: {
  workspaceId: string;
  requestedByMemberId: string;
  slug: string;
  confirmation: string;
  stepUpVerified: boolean;
  now: number;
}): DeletionRequest {
  if (deletionConfirmation(input.confirmation) !== deletionConfirmation(input.slug)) {
    throw new Error("the confirmation did not match this workspace's name");
  }
  // A gesture the operating system verified, on this device, now. Deleting a
  // workspace is the one action in this product with no recovery path at all,
  // so it is the one action that always asks.
  if (!input.stepUpVerified) {
    throw new Error("deleting a workspace requires a verified gesture");
  }
  return {
    workspaceId: input.workspaceId,
    requestedByMemberId: input.requestedByMemberId,
    requestedAt: input.now,
    purgeAfter: input.now + CANCELLATION_WINDOW_MS,
  };
}

export type PurgeAuthorization =
  | { allowed: true; reason: "window_elapsed" | "explicitly_skipped" }
  | { allowed: false; reason: "window_open" };

/**
 * May the purge start?
 *
 * The window elapsing is one way. The other is somebody explicitly saying
 * *purge now* — a second act, after the first, with its own confirmation. It is
 * deliberately not a checkbox on the deletion form: a person who has just typed
 * a workspace's name is in exactly the state of mind where one more click is
 * automatic, and this is the click that removes the seven days in which a
 * mistake could have been noticed.
 */
export function authorizePurge(input: {
  request: DeletionRequest;
  now: number;
  skipWindow?: { confirmation: string; slug: string; stepUpVerified: boolean };
}): PurgeAuthorization {
  if (input.now >= input.request.purgeAfter) return { allowed: true, reason: "window_elapsed" };
  const skip = input.skipWindow;
  if (
    skip
    && deletionConfirmation(skip.confirmation) === deletionConfirmation(skip.slug)
    && skip.stepUpVerified
  ) {
    return { allowed: true, reason: "explicitly_skipped" };
  }
  return { allowed: false, reason: "window_open" };
}

/**
 * Every store a purge has to touch, in the order it touches them.
 *
 * A list rather than a sequence of calls, so that "did it touch everything" is
 * a question with an answer. The order matters in one place and not the rest:
 * **routing goes last**, because a workspace whose routing is gone is one
 * nothing can reach — including the purge that had not finished.
 */
export const PURGE_STAGES = [
  "attachments",
  "content",
  "vault",
  "audit",
  "scheduler",
  "control_rows",
  "routing",
] as const;

export type PurgeStage = (typeof PURGE_STAGES)[number];

export type PurgeProgress = { stage: PurgeStage; removed: number; completedAt: number };

/**
 * The tables this object keeps *through* a purge.
 *
 * Short on purpose, and each one is here for a reason that is not "it seemed
 * harmless". The schema tables must survive or the object cannot answer what
 * version it is; `workspace_config` holds storage mode and routing epoch, which
 * the control plane still reads while retiring the route; and the deletion and
 * checkpoint tables are the record of the purge itself, which cannot delete the
 * evidence that it ran.
 */
export const PURGE_KEEPS: readonly string[] = [
  "_schema",
  "_migration_failures",
  "workspace_config",
  "workspace_deletion",
  "purge_stages",
  // The runtime's own bookkeeping. Not ours to drop, and dropping it would
  // break the object rather than empty it.
  "_cf_METADATA",
];

/**
 * Which stage owns which table.
 *
 * Written out rather than derived, because the *ordering* between stages is a
 * real constraint — attachments before content, members after everything that
 * references them — and a derivation would have to encode that anyway.
 *
 * What is derived is the completeness check: a test reads `sqlite_master` and
 * fails if any table is in neither this map nor [`PURGE_KEEPS`]. That is the
 * guard that matters, because the way this breaks in practice is a migration
 * three months from now adding a table nobody thinks to purge, and a workspace
 * deletion quietly leaving it behind.
 */
export const PURGE_TABLES: Record<PurgeStage, readonly string[]> = {
  attachments: ["files", "file_search", "solo_upgrade_attachments"],
  // Children before parents, always. The purge does not strictly need this —
  // most of these cascade — but the **reverse** of this order is what a restore
  // inserts in (see `tenant-export.ts`), and there a parent that does not exist
  // yet is a foreign-key failure. One ordered list serving both directions is
  // what keeps them from disagreeing about which table references which.
  // Children before parents, always, and a full-text index after the table it
  // indexes. The purge does not strictly need the first — most of these
  // cascade — but the **reverse** of this order is what a restore inserts in
  // (see `tenant-export.ts`), and there a parent that does not exist yet is a
  // foreign-key failure. One ordered list serving both directions is what keeps
  // them from disagreeing about which table references which.
  content: [
    // Everything that points at a message.
    "message_mentions",
    "message_reactions",
    "message_snippets",
    "message_unfurls",
    "form_submission_content",
    "saved_items",
    "channel_pins",
    "thread_read_state",
    "thread_subscriptions",
    "scheduled_messages",
    "message_drafts",
    "notifications",
    "messages",
    // The search indexes, and this is the one nobody thinks of: a purge that
    // dropped every message and left the full-text index behind would leave a
    // deleted workspace's content still searchable, in a table whose rows are
    // the words themselves. They go after their content, because an
    // external-content index cannot be emptied before the table it mirrors.
    "workspace_search",
    "form_submission_search",
    // Everything that points at a channel.
    "channel_members",
    "channel_read_state",
    "channel_message_sequence",
    "channel_notification_preferences",
    "notification_keywords",
    "notification_preferences",
    "saved_searches",
    "custom_emoji",
    "link_unfurls",
    "solo_upgrade_messages",
    "solo_upgrade_channels",
    "solo_upgrade_imports",
    // An agent's scope names rooms, so it belongs with the rooms rather than
    // with the agents: on the way back in, the channel has to exist first.
    "agent_scope_channels",
    "channels",
  ],
  vault: [
    "vault_canary_trips",
    "vault_usage_events",
    "vault_proxy_requests",
    "vault_approval_approvers",
    "vault_approval_items",
    "vault_approvals",
    "vault_grants",
    "vault_credential_deletions",
    "vault_credential_acl",
    "vault_credential_key_wraps",
    "vault_credentials",
    "credential_search",
    "vault_member_keys",
    "vault_settings",
  ],
  audit: ["audit_events", "audit_anchors", "audit_retention"],
  scheduler: [
    // An export is a copy of this workspace's content; a purge that left one
    // behind would leave the content behind with it.
    "export_chunks",
    "export_runs",
    "pending_events",
    "due_work",
    "due_work_failures",
    "replay_events",
    "idempotency_keys",
    "applied_control_operations",
    "usage_buckets",
    "resource_limit_events",
  ],
  control_rows: [
    "push_subscriptions",
    "agent_session_message_attribution",
    "agent_session_write_limits",
    "agent_sessions",
    "agent_delegations",
    "agent_queue",
    "agent_local_policies",
    "agent_runtime_configs",
    "agent_owners",
    "agents",
    "mcp_message_attribution",
    "mcp_write_limits",
    "oauth_codes",
    "oauth_connections",
    "runner_preset_requests",
    "runner_wakes",
    "runner_agents",
    "runner_devices",
    "runtime_runs",
    "custom_runtime_deliveries",
    "anthropic_webhook_receipts",
    "group_members",
    "groups",
    "members",
  ],
  // Routing lives in the control plane. The stage exists so the receipt records
  // that it was reached, and so the ordering constraint — routing last — has
  // somewhere to be true.
  routing: [],
};

/** The next stage to run, or `null` when every stage has completed. */
export function nextPurgeStage(completed: readonly PurgeStage[]): PurgeStage | null {
  const done = new Set(completed);
  return PURGE_STAGES.find((stage) => !done.has(stage)) ?? null;
}

export type DeletionReceipt = {
  workspaceId: string;
  requestId: string;
  requestedAt: number;
  completedAt: number;
  jurisdiction: string;
  stages: readonly { stage: PurgeStage; removed: number }[];
  /** A digest over the stage counts, so a receipt cannot be edited unnoticed. */
  verification: string;
};

/**
 * Keys a receipt may never carry.
 *
 * A deletion receipt is the one artefact that outlives the workspace, and it is
 * kept precisely so somebody can prove the deletion happened. That makes it the
 * single most tempting place to keep "just the channel names" — which would
 * mean a deleted workspace left a list of its rooms behind for thirty days.
 */
const FORBIDDEN_RECEIPT_KEYS = [
  "name",
  "slug",
  "channels",
  "members",
  "handles",
  "messages",
  "body",
  "email",
  "files",
  "credentials",
];

export function assertReceiptCarriesNoContent(receipt: object): void {
  const seen = JSON.stringify(receipt).toLowerCase();
  for (const key of FORBIDDEN_RECEIPT_KEYS) {
    if (seen.includes(`"${key}"`)) {
      throw new Error(`a deletion receipt may not carry ${key}`);
    }
  }
}

export async function receiptVerification(
  workspaceId: string,
  stages: readonly { stage: PurgeStage; removed: number }[],
): Promise<string> {
  const canonical = `${workspaceId}|${stages.map((entry) => `${entry.stage}:${entry.removed}`).join(",")}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * What a Solo purge may and may not claim.
 *
 * The cloud holds Solo channel metadata and routing; the content lives on one
 * designated computer. Deleting the cloud side does not erase that computer,
 * and it certainly does not erase a backup somebody made of it. Saying "your
 * data has been deleted" would be false in the one case where being wrong
 * matters most, so the sentence is fixed here rather than written per-surface.
 */
export function soloDeletionCaveat(): string {
  return (
    "This removes the channel metadata and routing Lepidy holds in the cloud. "
    + "The messages, attachments and vault ciphertext on your designated computer "
    + "are not in the cloud and are not erased by this: delete them there, and "
    + "remember any backup you made of that computer still holds them."
  );
}
