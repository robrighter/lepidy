import { DurableObject } from "cloudflare:workers";

import {
  migrateWorkspaceSchema,
  readWorkspaceSchema,
  type WorkspaceSchemaState,
} from "./workspace-migrations";
import {
  appendAuditEntry,
  appendReplayEvents,
  claimDueWork,
  claimOutboxBatch,
  completeDueWork,
  deferDueWork,
  enqueueOutbox,
  ensureRecurringWork,
  listDueWork,
  nextDueAt,
  nextPendingOutboxAt,
  readAuditEntries,
  scheduleDueWork,
  settleOutbox,
  sweepRetention,
  verifyStoredAuditChain,
  writeAuditAnchor,
  type AppendedAudit,
  type AuditAnchor,
  type DueWorkInput,
  type DueWorkRow,
  type MutationEffects,
  type OutboxDispatcher,
  type OutboxEntry,
  type OutboxOutcome,
  type RetentionSweepReport,
} from "./workspace-scheduler";
import type { AuditChainVerification, AuditEntryInput, StoredAuditEntry } from "../domain/audit-chain";
import {
  DAY_MS,
  DUE_WORK_BATCH_SIZE,
  OUTBOX_BATCH_SIZE,
  RETENTION_MS,
  redactedError,
} from "../domain/due-work";
import { parseIdempotencyKey } from "../domain/idempotency-key";
import {
  ACCESS_TOKEN_TTL_MS,
  AUTHORIZATION_CODE_TTL_MS,
  checkCodeExchange,
  checkPresentedToken,
  decideRefresh,
  formatToken,
  hashSecret,
  parseToken,
  parseTokenOfKind,
  randomSecret,
  verifyCodeVerifier,
  workspaceSlugFromResource,
  type SupportedScope,
} from "../domain/mcp-oauth";
import {
  directMessageIdentity,
  parseChannelName,
  parseChannelSlug,
  parseChannelTopic,
  MAX_MESSAGE_LENGTH,
  clampHistoryLimit,
  parseMessageBody,
  parseReactionEmoji,
  parseSnippet,
  resolveThreadPlacement,
  snippetMessageBody,
  type ChannelKind,
} from "../domain/rooms";
import {
  canReceiveChannelEvent,
  canSeeChannel,
  type ChannelVisibility,
} from "../domain/visibility";
import {
  PRESENCE_TTL_MS,
  advanceReadCursor,
  summariseUnread,
  type UnreadSummary,
} from "../domain/read-state";
import {
  SOCKET_PING,
  SOCKET_PONG,
  encodeServerFrame,
  parseClientFrame,
  type ServerFrame,
} from "../domain/socket-protocol";
import { parseMentions } from "../domain/mentions";
import { isEmojiToken, parseCustomEmojiName } from "../domain/emoji";
import {
  agentMayPostIn,
  decideEnqueue,
  flagSuspiciousContent,
  mayRemoveOwner,
  type AgentScope,
} from "../domain/agent-scope";
import {
  SECURITY_PREAMBLE_VERSION,
  assembleBrief,
  parseAgentBrief,
  type BriefTier,
} from "../domain/agent-preamble";
import { commandMessageBody, parseComposerInput } from "../domain/slash-commands";
import { parseAgentHandle } from "../domain/mention-handle";
import {
  addChannelMembers,
  addReaction,
  annotateMessages,
  applyMessageDelete,
  applyMessageEdit,
  archiveChannel,
  channelMemberIds,
  insertChannel,
  insertMessage,
  isChannelMember,
  listChannelHistory,
  listThreadHistory,
  agentOwnerIds,
  agentQueueDepth,
  agentScopeChannelIds,
  claimDueScheduledMessages,
  customEmojiExists,
  deleteCustomEmoji,
  deleteDraft,
  insertCustomEmoji,
  insertSnippet,
  enqueueAgentWork,
  listAgentQueue,
  listAgentRows,
  listCustomEmoji,
  insertScheduledMessage,
  listDraftsForMember,
  listPinnedMessages,
  listSavedPointers,
  listScheduledForMember,
  nextScheduledSendAt,
  readAgent,
  readAgentByHandle,
  readDraft,
  readScheduledMessage,
  replaceAgentScope,
  readSnippets,
  settleScheduledMessage,
  updateScheduledMessage,
  writeDraft,
  consumeOauthCode,
  deleteExpiredOauthCodes,
  insertOauthCode,
  insertOauthConnection,
  listOauthConnectionsForMember,
  readConnectionByAccessHash,
  readConnectionByRefreshHash,
  readOauthCode,
  readOauthConnection,
  revokeOauthConnectionRow,
  rotateOauthConnection,
  touchOauthConnection,
  listVisibleChannels,
  nextChannelSequence,
  pinMessage,
  pinnedMessageIds,
  saveMessageForMember,
  savedMessageIds,
  unpinMessage,
  unsaveMessageForMember,
  readChannel,
  readChannelByDirectMessageKey,
  readChannelBySlug,
  latestChannelSequence,
  latestThreadSequence,
  readChannelCursor,
  readMessage,
  readThreadCursor,
  readUnreadFacts,
  removeChannelMember,
  removeReaction,
  replaceMentions,
  resolveMentionTargets,
  writeChannelCursor,
  writeThreadCursor,
  type AgentRow,
  type ChannelRow,
  type CustomEmojiRow,
  type QueueItemRow,
  type DraftRow,
  type MessagePage,
  type MessageRow,
  type ScheduledMessageRow,
} from "./workspace-rooms";
import { verifySoloSnapshot, type SoloContentSnapshot } from "../domain/solo-snapshot";

export type WorkspaceHealth = {
  ok: boolean;
  schemaVersion: number;
  status: WorkspaceSchemaState["status"];
  error: string | null;
};

export type MemberProjection = {
  operationId: string;
  memberId: string;
  accountId: string;
  handle: string;
  displayName: string;
  role: "owner" | "admin" | "member" | "guest";
  status: "pending" | "active" | "suspended" | "removed";
  authorizationEpoch: number;
  version: number;
  now: number;
};

export type WorkspaceStorageMode = "local_host" | "cloud";

export type OpaqueRelayFrameMetadata = {
  workspaceId: string;
  hostEpoch: number;
  sequence: number;
  requestId: string;
  direction: "to_host" | "from_host";
  ciphertextBytes: number;
};

export type MutationOutcome<T> = {
  replayed: boolean;
  result: T;
  audit: AppendedAudit | null;
  outboxQueued: number;
  alarmAt: number | null;
};

export type DueWorkReport = {
  now: number;
  processed: readonly string[];
  failed: readonly { id: string; kind: string; error: string; retried: boolean }[];
  outbox: { attempted: number; delivered: number; retried: number; dead: number };
  retention: RetentionSweepReport | null;
  anchor: AuditAnchor | null;
  scheduledSends: { sent: number; failed: number };
  alarmAt: number | null;
};

export type SchedulerState = {
  alarmAt: number | null;
  dueWork: readonly DueWorkRow[];
  pendingOutbox: number;
  deadOutbox: number;
  auditSequence: number;
};

/** Recurring work every workspace owns from the moment it exists. */
export const RETENTION_SWEEP_WORK_ID = "system:retention_sweep";
export const AUDIT_ANCHOR_WORK_ID = "system:audit_anchor";
export const OUTBOX_FLUSH_WORK_ID = "system:outbox_flush";

export type ShellChannel = {
  id: string;
  kind: "public" | "private" | "dm" | "group_dm";
  slug: string | null;
  name: string | null;
  isMember: boolean;
};

export type ShellAgent = {
  id: string;
  handle: string;
  displayName: string;
  status: "active" | "paused" | "archived";
};

export type ShellViewer = {
  memberId: string;
  handle: string;
  displayName: string;
  role: MemberProjection["role"];
  authorizationEpoch: number;
};

export type WorkspaceShellSnapshot = {
  viewer: ShellViewer;
  channels: readonly ShellChannel[];
  agents: readonly ShellAgent[];
  storageMode: WorkspaceStorageMode | null;
  schemaVersion: number;
};

export type Actor = { memberId: string; authorizationEpoch: number };

export type ActiveMember = {
  id: string;
  handle: string;
  displayName: string;
  role: MemberProjection["role"];
};

export type CreatedChannel = { channelId: string; kind: ChannelKind; created: boolean };

export type SentMessage = {
  messageId: string;
  channelId: string;
  threadRootId: string | null;
  channelSequence: number;
  createdAt: number;
  replayed: boolean;
};

/** What a hibernated socket remembers about itself. */
export type SocketAttachment = {
  memberId: string;
  authorizationEpoch: number;
  /** Highest replay sequence this socket has been sent. */
  cursor: number;
  connectedAt: number;
};

export type AgentSummary = {
  id: string;
  handle: string;
  displayName: string;
  description: string | null;
  status: "active" | "paused" | "archived";
  scopeMode: "any" | "listed";
  /** Only the scoped rooms this reader may see. */
  scopeChannelIds: readonly string[];
  scopeChannelCount: number;
  ownerIds: readonly string[];
  isOwner: boolean;
  /** Only an owner sees a queue depth. */
  queueDepth: number | null;
};

export type ComposerOutcome =
  | { kind: "sent"; messageId: string }
  | { kind: "acted"; command: "join" | "leave" | "archive" }
  | { kind: "rejected"; reason: string };

export type DraftSaveResult =
  | { status: "saved"; draft: DraftRow }
  | { status: "cleared"; draft: null }
  /** Another device moved the draft on; this is what is actually stored. */
  | { status: "conflict"; draft: DraftRow };

/**
 * OAuth protocol answers are values, not exceptions.
 *
 * An OAuth endpoint has to reply with a specific error code in a JSON body, so
 * the object decides the code once and the route reports it. Turning an
 * exception's message back into a code at the route would be a second place
 * where the refusal is decided, and the two would eventually disagree.
 */
export type OauthCodeResult =
  | { ok: true; code: string }
  | { ok: false; error: string; description: string };

export type OauthGrant = {
  connectionId: string;
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  scope: string;
};

export type OauthGrantResult =
  | { ok: true; grant: OauthGrant }
  | { ok: false; error: string; description: string };

/** Who a verified access token acts as. Derived from the token and nowhere else. */
export type OauthPrincipal = {
  connectionId: string;
  memberId: string;
  handle: string;
  displayName: string;
  role: MemberProjection["role"];
  authorizationEpoch: number;
  scope: string;
  clientId: string;
  clientName: string | null;
};

export type OauthPrincipalResult =
  | { ok: true; principal: OauthPrincipal }
  | { ok: false; error: "invalid_token" | "insufficient_scope"; description: string };

export type OauthConnectionSummary = {
  id: string;
  clientId: string;
  clientName: string | null;
  scope: string;
  createdAt: number;
  lastUsedAt: number | null;
  rotationCount: number;
};

/** One multiplexed deadline covers every pending scheduled send. */
export const SCHEDULED_SEND_WORK_ID = "system:scheduled_send";
const SCHEDULED_SEND_BATCH = 25;
/** A year is already further ahead than anybody means; beyond it is a mistake. */
const MAX_SCHEDULE_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;

/** Roles that may create rooms. A guest joins what they are invited to. */
const ROOM_CREATOR_ROLES: ReadonlySet<MemberProjection["role"]> = new Set(["owner", "admin", "member"]);

export class Workspace extends DurableObject<CloudflareEnv> {
  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);

    ctx.blockConcurrencyWhile(async () => {
      const schema = migrateWorkspaceSchema(ctx.storage);
      if (schema.status !== "ready") return;
      const now = Date.now();
      ctx.storage.transactionSync(() => {
        ensureRecurringWork(
          ctx.storage,
          [
            { id: RETENTION_SWEEP_WORK_ID, kind: "retention_sweep", dueAt: now + DAY_MS, intervalMs: DAY_MS },
            { id: AUDIT_ANCHOR_WORK_ID, kind: "audit_anchor", dueAt: now + DAY_MS, intervalMs: DAY_MS },
          ],
          now,
        );
      });
      // An evicted object loses nothing: the alarm is rebuilt from durable state.
      await this.armAlarm();
    });

    // Keepalives are answered by the runtime without waking this object, so a
    // room full of idle tabs costs nothing and writes nothing.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(SOCKET_PING, SOCKET_PONG));
  }

  health(): WorkspaceHealth {
    const state = readWorkspaceSchema(this.ctx.storage);

    return {
      ok: state.status === "ready",
      schemaVersion: state.version,
      status: state.status,
      error: state.error,
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/_internal/member-socket" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Not found", { status: 404 });
    }
    const memberId = request.headers.get("x-lepidy-member-id") ?? "";
    const authorizationEpoch = Number(request.headers.get("x-lepidy-authorization-epoch"));
    if (!this.authorizeMember(memberId, authorizationEpoch)) {
      return new Response("Forbidden", { status: 403 });
    }
    const since = Number(url.searchParams.get("since") ?? "0");
    const now = Date.now();
    const pair = new WebSocketPair();
    // The tag is how a woken socket is recognised after hibernation; the
    // attachment carries the rest and survives with it.
    this.ctx.acceptWebSocket(pair[1], [memberId]);
    const attachment: SocketAttachment = {
      memberId,
      authorizationEpoch,
      cursor: Number.isSafeInteger(since) && since >= 0 ? since : 0,
      connectedAt: now,
    };
    pair[1].serializeAttachment(attachment);

    this.sendFrame(pair[1], {
      type: "welcome",
      memberId,
      sequence: this.latestReplaySequence(),
      presence: this.onlineMemberIds(),
    });
    if (attachment.cursor > 0) this.replayForSocket(pair[1], attachment, attachment.cursor);
    this.broadcastPresence(memberId, true);

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  initializeWorkspace(input: {
    storageMode: WorkspaceStorageMode;
    hostEpoch: number;
    routingEpoch: number;
    /**
     * The workspace's own slug, so the object can later refuse an OAuth
     * audience naming somebody else. It is written once and never changed:
     * the slug is what routes, and a workspace that could rename itself could
     * take over another workspace's tokens.
     */
    workspaceSlug?: string;
    now: number;
  }): void {
    const schema = readWorkspaceSchema(this.ctx.storage);
    if (schema.status !== "ready") throw new Error("workspace is quarantined");
    this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql
        .exec<{ storage_mode: WorkspaceStorageMode }>(
          "SELECT storage_mode FROM workspace_config WHERE singleton = 1",
        )
        .toArray()[0];
      if (existing && existing.storage_mode !== input.storageMode) {
        throw new Error("workspace storage mode requires a routed migration");
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO workspace_config(
           singleton, storage_mode, host_epoch, routing_epoch, workspace_slug, initialized_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           host_epoch = excluded.host_epoch,
           routing_epoch = excluded.routing_epoch,
           workspace_slug = COALESCE(workspace_config.workspace_slug, excluded.workspace_slug),
           updated_at = excluded.updated_at`,
        input.storageMode,
        input.hostEpoch,
        input.routingEpoch,
        input.workspaceSlug ?? null,
        input.now,
        input.now,
      );
    });
  }

  async applyMembership(member: MemberProjection): Promise<{ applied: boolean; version: number }> {
    const schema = readWorkspaceSchema(this.ctx.storage);
    if (schema.status !== "ready") throw new Error("workspace is quarantined");

    const outcome = await this.commitMutation({ scope: "membership", now: member.now }, () => {
      const replay = this.ctx.storage.sql
        .exec<{ version: number }>(
          "SELECT version FROM applied_control_operations WHERE operation_id = ?",
          member.operationId,
        )
        .toArray()[0];
      if (replay) return { result: { applied: false, version: replay.version } };

      const existing = this.ctx.storage.sql
        .exec<{ control_version: number }>(
          "SELECT control_version FROM members WHERE id = ?",
          member.memberId,
        )
        .toArray()[0];
      if (existing && existing.control_version >= member.version) {
        throw new Error("membership projection version is stale");
      }

      this.ctx.storage.sql.exec(
        `INSERT INTO members(
           id, account_id, handle, display_name, role, status,
           authorization_epoch, control_version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           handle = excluded.handle,
           display_name = excluded.display_name,
           role = excluded.role,
           status = excluded.status,
           authorization_epoch = excluded.authorization_epoch,
           control_version = excluded.control_version,
           updated_at = excluded.updated_at`,
        member.memberId,
        member.accountId,
        member.handle,
        member.displayName,
        member.role,
        member.status,
        member.authorizationEpoch,
        member.version,
        member.now,
        member.now,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO applied_control_operations(operation_id, kind, aggregate_id, version, applied_at)
         VALUES (?, 'membership_upsert', ?, ?, ?)`,
        member.operationId,
        member.memberId,
        member.version,
        member.now,
      );
      const projection = {
        memberId: member.memberId,
        handle: member.handle,
        role: member.role,
        status: member.status,
        authorizationEpoch: member.authorizationEpoch,
        version: member.version,
      };
      return {
        result: { applied: true, version: member.version },
        effects: {
          audit: {
            eventType: "membership.projected",
            outcome: "allowed",
            requesterKind: "system",
            subjectKind: "member",
            subjectId: member.memberId,
            metadata: {
              role: member.role,
              member_status: member.status,
              authorization_epoch: member.authorizationEpoch,
              control_version: member.version,
              operation_id: member.operationId,
            },
          },
          outbox: [
            {
              id: `member_projection.${member.operationId}`,
              kind: "member_projection_changed",
              dedupeKey: `member:${member.memberId}:${member.version}`,
              payload: projection,
            },
          ],
          replay: [{ kind: "member.updated", audience: ["workspace"], payload: projection }],
        } satisfies MutationEffects,
      };
    });
    if (outcome.result.applied && (member.authorizationEpoch > 1 || member.status !== "active")) {
      this.closeMemberSockets(member.memberId);
    }
    return outcome.result;
  }

  getMember(memberId: string): {
    id: string;
    handle: string;
    role: MemberProjection["role"];
    status: MemberProjection["status"];
    controlVersion: number;
  } | null {
    const row = this.ctx.storage.sql
      .exec<{
        id: string;
        handle: string;
        role: MemberProjection["role"];
        status: MemberProjection["status"];
        control_version: number;
      }>("SELECT id, handle, role, status, control_version FROM members WHERE id = ?", memberId)
      .toArray()[0];
    return row
      ? {
          id: row.id,
          handle: row.handle,
          role: row.role,
          status: row.status,
          controlVersion: row.control_version,
        }
      : null;
  }

  authorizeMember(memberId: string, authorizationEpoch: number): boolean {
    const row = this.ctx.storage.sql
      .exec<{ allowed: number }>(
        `SELECT 1 AS allowed FROM members
         WHERE id = ? AND status = 'active' AND authorization_epoch = ?`,
        memberId,
        authorizationEpoch,
      )
      .toArray()[0];
    return row?.allowed === 1;
  }

  closeMemberSockets(memberId: string, reason = "membership authority changed"): number {
    const sockets = this.ctx.getWebSockets(memberId);
    for (const socket of sockets) socket.close(4003, reason.slice(0, 123));
    return sockets.length;
  }

  designateSoloHost(input: { deviceId: string; newHostEpoch: number; now: number }): void {
    this.ctx.storage.transactionSync(() => {
      const config = this.workspaceConfig();
      if (config.storage_mode !== "local_host") throw new Error("workspace is not local-hosted");
      if (input.newHostEpoch !== config.host_epoch + 1) throw new Error("host epoch must advance by one");
      this.ctx.storage.sql.exec(
        `UPDATE workspace_config
         SET designated_host_device_id = ?, host_epoch = ?, host_lease_expires_at = NULL,
             relay_sequence_to_host = 0, relay_sequence_from_host = 0, updated_at = ?
         WHERE singleton = 1`,
        input.deviceId,
        input.newHostEpoch,
        input.now,
      );
    });
  }

  renewSoloHostLease(input: { deviceId: string; hostEpoch: number; now: number; ttlMs: number }): number {
    if (input.ttlMs < 1_000 || input.ttlMs > 120_000) throw new Error("invalid host lease duration");
    return this.ctx.storage.transactionSync(() => {
      const config = this.workspaceConfig();
      if (
        config.storage_mode !== "local_host" ||
        config.designated_host_device_id !== input.deviceId ||
        config.host_epoch !== input.hostEpoch
      ) {
        throw new Error("stale or unauthorized solo host");
      }
      const expiresAt = input.now + input.ttlMs;
      this.ctx.storage.sql.exec(
        "UPDATE workspace_config SET host_lease_expires_at = ?, updated_at = ? WHERE singleton = 1",
        expiresAt,
        input.now,
      );
      return expiresAt;
    });
  }

  routeOpaqueFrame(input: OpaqueRelayFrameMetadata, now: number): { routed: true; sequence: number } {
    if (
      input.sequence < 1 ||
      input.ciphertextBytes < 17 ||
      input.ciphertextBytes > 1_048_576 ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(input.requestId)
    ) {
      throw new Error("invalid opaque relay frame metadata");
    }
    return this.ctx.storage.transactionSync(() => {
      const config = this.workspaceConfig();
      if (
        config.storage_mode !== "local_host" ||
        !config.designated_host_device_id ||
        config.host_epoch !== input.hostEpoch ||
        config.host_lease_expires_at === null ||
        config.host_lease_expires_at <= now
      ) {
        throw new Error("host_offline");
      }
      const currentSequence =
        input.direction === "to_host" ? config.relay_sequence_to_host : config.relay_sequence_from_host;
      if (input.sequence <= currentSequence) throw new Error("stale relay sequence");
      const column = input.direction === "to_host" ? "relay_sequence_to_host" : "relay_sequence_from_host";
      this.ctx.storage.sql.exec(
        `UPDATE workspace_config SET ${column} = ?, updated_at = ? WHERE singleton = 1`,
        input.sequence,
        now,
      );
      return { routed: true as const, sequence: input.sequence };
    });
  }

  async stageSoloUpgrade(input: {
    importId: string;
    snapshot: SoloContentSnapshot;
    now: number;
  }): Promise<{ staged: true; replayed: boolean }> {
    await verifySoloSnapshot(input.snapshot);
    return this.ctx.storage.transactionSync(() => {
      const config = this.workspaceConfig();
      if (config.storage_mode !== "local_host") throw new Error("workspace is not local-hosted");
      if (config.host_epoch !== input.snapshot.hostEpoch) throw new Error("stale host epoch");
      const existing = this.ctx.storage.sql
        .exec<{ snapshot_checksum: string; status: string }>(
          "SELECT snapshot_checksum, status FROM solo_upgrade_imports WHERE import_id = ?",
          input.importId,
        )
        .toArray()[0];
      if (existing) {
        if (existing.snapshot_checksum !== input.snapshot.checksum) throw new Error("import id conflict");
        return { staged: true as const, replayed: true };
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO solo_upgrade_imports(import_id, snapshot_checksum, workspace_id, host_epoch, status, started_at)
         VALUES (?, ?, ?, ?, 'staged', ?)`,
        input.importId,
        input.snapshot.checksum,
        input.snapshot.workspaceId,
        input.snapshot.hostEpoch,
        input.now,
      );
      for (const record of input.snapshot.channels) {
        this.ctx.storage.sql.exec(
          "INSERT INTO solo_upgrade_channels(import_id, record_id, record_json) VALUES (?, ?, ?)",
          input.importId,
          record.id,
          JSON.stringify(record),
        );
      }
      for (const record of input.snapshot.messages) {
        this.ctx.storage.sql.exec(
          "INSERT INTO solo_upgrade_messages(import_id, record_id, record_json) VALUES (?, ?, ?)",
          input.importId,
          record.id,
          JSON.stringify(record),
        );
      }
      for (const record of input.snapshot.attachments) {
        this.ctx.storage.sql.exec(
          "INSERT INTO solo_upgrade_attachments(import_id, record_id, record_json) VALUES (?, ?, ?)",
          input.importId,
          record.id,
          JSON.stringify(record),
        );
      }
      return { staged: true as const, replayed: false };
    });
  }

  async finalizeSoloUpgrade(input: {
    importId: string;
    expectedWorkspaceId: string;
    now: number;
  }): Promise<{ storageMode: "cloud"; routingEpoch: number; replayed: boolean }> {
    const staged = this.readStagedSnapshot(input.importId);
    if (staged.workspaceId !== input.expectedWorkspaceId) throw new Error("snapshot workspace mismatch");
    await verifySoloSnapshot(staged);
    return this.ctx.storage.transactionSync(() => {
      const config = this.workspaceConfig();
      const record = this.ctx.storage.sql
        .exec<{ status: "staged" | "complete"; snapshot_checksum: string }>(
          "SELECT status, snapshot_checksum FROM solo_upgrade_imports WHERE import_id = ?",
          input.importId,
        )
        .one();
      if (record.status === "complete") {
        return { storageMode: "cloud" as const, routingEpoch: config.routing_epoch, replayed: true };
      }
      if (config.storage_mode !== "local_host" || config.host_epoch !== staged.hostEpoch) {
        throw new Error("workspace authority changed during import");
      }
      for (const channel of staged.channels) {
        this.ctx.storage.sql.exec(
          `INSERT INTO channels(id, kind, slug, name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, slug=excluded.slug,
             name=excluded.name, updated_at=excluded.updated_at`,
          channel.id,
          channel.kind,
          channel.slug,
          channel.name,
          channel.createdAt,
          channel.updatedAt,
        );
      }
      for (const message of staged.messages) {
        this.ctx.storage.sql.exec(
          `INSERT INTO messages(id, channel_id, author_kind, author_id, author_display_snapshot, body_markdown, created_at)
           VALUES (?, ?, 'imported', ?, ?, ?, ?)`,
          message.id,
          message.channelId,
          message.authorId,
          message.authorId,
          message.bodyMarkdown,
          message.createdAt,
        );
      }
      for (const attachment of staged.attachments) {
        this.ctx.storage.sql.exec(
          `INSERT INTO attachments(id, message_id, file_name, media_type, byte_length, object_key, sha256)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          attachment.id,
          attachment.messageId,
          attachment.fileName,
          attachment.mediaType,
          attachment.byteLength,
          attachment.relativePath,
          attachment.sha256,
        );
      }
      const routingEpoch = config.routing_epoch + 1;
      this.ctx.storage.sql.exec(
        `UPDATE workspace_config SET storage_mode = 'cloud', routing_epoch = ?,
           designated_host_device_id = NULL, host_lease_expires_at = NULL, updated_at = ?
         WHERE singleton = 1`,
        routingEpoch,
        input.now,
      );
      this.ctx.storage.sql.exec(
        "UPDATE solo_upgrade_imports SET status = 'complete', completed_at = ? WHERE import_id = ?",
        input.now,
        input.importId,
      );
      return { storageMode: "cloud" as const, routingEpoch, replayed: false };
    });
  }

  /**
   * The navigation and profile data one member may see. Visibility is applied
   * here, in the object, rather than trusted from the caller: a private room is
   * returned only to a member of that room, and the caller's membership epoch
   * must still match the projection this workspace holds.
   */
  shellSnapshot(input: { memberId: string; authorizationEpoch: number }): WorkspaceShellSnapshot {
    const schema = readWorkspaceSchema(this.ctx.storage);
    if (schema.status !== "ready") throw new Error("workspace is quarantined");
    if (!this.authorizeMember(input.memberId, input.authorizationEpoch)) {
      throw new Error("member is not authorized for this workspace");
    }

    const viewerRow = this.ctx.storage.sql
      .exec<{
        id: string;
        handle: string;
        display_name: string;
        role: MemberProjection["role"];
        authorization_epoch: number;
      }>(
        "SELECT id, handle, display_name, role, authorization_epoch FROM members WHERE id = ?",
        input.memberId,
      )
      .one();

    const channels = this.ctx.storage.sql
      .exec<{
        id: string;
        kind: ShellChannel["kind"];
        slug: string | null;
        name: string | null;
        is_member: number;
      }>(
        `SELECT c.id, c.kind, c.slug, c.name,
                CASE WHEN cm.member_id IS NULL THEN 0 ELSE 1 END AS is_member
         FROM channels c
         LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.member_id = ?
         WHERE c.archived_at IS NULL AND (c.kind = 'public' OR cm.member_id IS NOT NULL)
         ORDER BY c.kind, COALESCE(c.slug, c.name, c.id)`,
        input.memberId,
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        slug: row.slug,
        name: row.name,
        isMember: row.is_member === 1,
      }));

    const agents = this.ctx.storage.sql
      .exec<{ id: string; handle: string; display_name: string; status: ShellAgent["status"] }>(
        "SELECT id, handle, display_name, status FROM agents WHERE status <> 'archived' ORDER BY handle",
      )
      .toArray()
      .map((row) => ({
        id: row.id,
        handle: row.handle,
        displayName: row.display_name,
        status: row.status,
      }));

    const config = this.ctx.storage.sql
      .exec<{ storage_mode: WorkspaceStorageMode }>(
        "SELECT storage_mode FROM workspace_config WHERE singleton = 1",
      )
      .toArray()[0];

    return {
      viewer: {
        memberId: viewerRow.id,
        handle: viewerRow.handle,
        displayName: viewerRow.display_name,
        role: viewerRow.role,
        authorizationEpoch: viewerRow.authorization_epoch,
      },
      channels,
      agents,
      storageMode: config?.storage_mode ?? null,
      schemaVersion: schema.version,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Live delivery, read state and presence (C03)                        */
  /* ------------------------------------------------------------------ */

  /**
   * Frames arrive after authentication but decide nothing about who is acting:
   * the actor comes from the socket's own attachment, never from the payload.
   * Nothing here writes storage except an actual read-cursor advance.
   */
  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    const attachment = this.attachmentOf(socket);
    if (attachment === null) {
      socket.close(4001, "socket has no identity");
      return;
    }
    // Authority is rechecked live, so a revoked member's open tab stops working.
    if (!this.authorizeMember(attachment.memberId, attachment.authorizationEpoch)) {
      socket.close(4003, "membership authority changed");
      return;
    }

    const frame = parseClientFrame(typeof message === "string" ? message : null);
    switch (frame.type) {
      case "invalid":
        this.sendFrame(socket, { type: "error", reason: frame.reason });
        return;
      case "resume":
        this.replayForSocket(socket, attachment, frame.since);
        return;
      case "read":
        this.applyChannelRead(socket, attachment, frame.channelId, frame.sequence, Date.now());
        return;
      case "thread_read":
        this.applyThreadRead(socket, attachment, frame.threadRootId, frame.sequence, Date.now());
        return;
      case "typing":
        // Ephemeral by design: typing is relayed and never stored.
        this.relayTyping(attachment, frame.channelId, Date.now());
        return;
    }
  }

  webSocketClose(socket: WebSocket): void {
    const attachment = this.attachmentOf(socket);
    if (attachment === null) return;
    if (this.socketsFor(attachment.memberId).length <= 1) {
      this.broadcastPresence(attachment.memberId, false);
    }
  }

  webSocketError(socket: WebSocket): void {
    this.webSocketClose(socket);
  }

  /** Members with at least one live socket. Derived, never written down. */
  onlineMemberIds(): string[] {
    const ids = new Set<string>();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.attachmentOf(socket);
      if (attachment) ids.add(attachment.memberId);
    }
    return [...ids].sort();
  }

  presence(): { memberIds: readonly string[]; ttlMs: number } {
    return { memberIds: this.onlineMemberIds(), ttlMs: PRESENCE_TTL_MS };
  }

  /** A cursor per member per room: reading on the phone reads on the laptop. */
  markChannelRead(input: {
    actor: Actor;
    channelId: string;
    sequence: number;
    now: number;
  }): { sequence: number } {
    const actor = this.authorizeActor(input.actor);
    const channel = this.requireVisibleChannel(input.channelId, actor.id);
    const sequence = this.advanceChannelCursor(channel.id, actor.id, input.sequence, input.now);
    this.broadcastToMember(actor.id, { type: "read", channelId: channel.id, sequence });
    return { sequence };
  }

  /** Thread read state is separate from the channel's, as the product promises. */
  markThreadRead(input: {
    actor: Actor;
    threadRootId: string;
    sequence: number;
    now: number;
  }): { sequence: number } {
    const actor = this.authorizeActor(input.actor);
    const root = readMessage(this.ctx.storage, input.threadRootId);
    if (root === null || root.threadRootId !== null) throw new Error("thread not found");
    this.requireVisibleChannel(root.channelId, actor.id);
    const sequence = this.advanceThreadCursor(root.id, actor.id, input.sequence, input.now);
    this.broadcastToMember(actor.id, { type: "thread_read", threadRootId: root.id, sequence });
    return { sequence };
  }

  unreadSummary(input: { actor: Actor }): UnreadSummary {
    const actor = this.authorizeActor(input.actor);
    return summariseUnread(readUnreadFacts(this.ctx.storage, actor.id));
  }

  /* -- realtime internals ---------------------------------------------- */

  private attachmentOf(socket: WebSocket): SocketAttachment | null {
    const raw = socket.deserializeAttachment() as SocketAttachment | null;
    return raw && typeof raw.memberId === "string" ? raw : null;
  }

  private socketsFor(memberId: string): WebSocket[] {
    return this.ctx.getWebSockets(memberId);
  }

  private sendFrame(socket: WebSocket, frame: ServerFrame): void {
    try {
      socket.send(encodeServerFrame(frame));
    } catch {
      // A socket that has gone away is not an error worth failing a write for.
    }
  }

  private latestReplaySequence(): number {
    return (
      this.ctx.storage.sql
        .exec<{ sequence: number | null }>("SELECT MAX(sequence) AS sequence FROM replay_events")
        .one().sequence ?? 0
    );
  }

  private oldestReplaySequence(): number {
    return (
      this.ctx.storage.sql
        .exec<{ sequence: number | null }>("SELECT MIN(sequence) AS sequence FROM replay_events")
        .one().sequence ?? 0
    );
  }

  /**
   * Replay from the client's cursor, filtered through the same visibility rule
   * the query path uses. A cursor older than the retention window is answered
   * with a reset rather than a silent gap.
   */
  private replayForSocket(socket: WebSocket, attachment: SocketAttachment, since: number): void {
    const oldest = this.oldestReplaySequence();
    if (oldest > 0 && since > 0 && since < oldest - 1) {
      this.sendFrame(socket, { type: "reset", reason: "replay window has expired" });
      this.updateAttachment(socket, { ...attachment, cursor: this.latestReplaySequence() });
      return;
    }

    const rows = this.ctx.storage.sql
      .exec<{ sequence: number; kind: string; audience_json: string; payload_json: string }>(
        "SELECT sequence, kind, audience_json, payload_json FROM replay_events WHERE sequence > ? ORDER BY sequence",
        since,
      )
      .toArray();

    let cursor = Math.max(attachment.cursor, since);
    for (const row of rows) {
      const audience = JSON.parse(row.audience_json) as string[];
      const channelId = audience[0] ?? "";
      // Re-check now, against current membership: an event stored while the
      // member could see the room must not be replayed after they left it.
      if (!this.socketMaySee(channelId, attachment.memberId)) {
        cursor = Math.max(cursor, row.sequence);
        continue;
      }
      this.sendFrame(socket, {
        type: "event",
        sequence: row.sequence,
        kind: row.kind,
        channelId,
        payload: JSON.parse(row.payload_json) as unknown,
      });
      cursor = Math.max(cursor, row.sequence);
    }
    this.updateAttachment(socket, { ...attachment, cursor });
  }

  private updateAttachment(socket: WebSocket, attachment: SocketAttachment): void {
    try {
      socket.serializeAttachment(attachment);
    } catch {
      // A closing socket cannot carry state forward, and does not need to.
    }
  }

  private socketMaySee(channelId: string, memberId: string): boolean {
    const channel = readChannel(this.ctx.storage, channelId);
    if (channel === null) return false;
    return canReceiveChannelEvent(this.channelVisibility(channel, memberId));
  }

  private channelVisibility(channel: ChannelRow, memberId: string): ChannelVisibility {
    return {
      kind: channel.kind,
      archivedAt: channel.archivedAt,
      isMember: isChannelMember(this.ctx.storage, channel.id, memberId),
    };
  }

  /**
   * Persist, then broadcast, filtered per socket. A client can never be told
   * about a message that is not already durable.
   */
  private broadcastChannelEvent(
    channel: ChannelRow,
    sequence: number,
    kind: string,
    payload: unknown,
  ): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.attachmentOf(socket);
      if (attachment === null) continue;
      if (!this.authorizeMember(attachment.memberId, attachment.authorizationEpoch)) continue;
      if (!canReceiveChannelEvent(this.channelVisibility(channel, attachment.memberId))) continue;
      this.sendFrame(socket, { type: "event", sequence, kind, channelId: channel.id, payload });
      this.updateAttachment(socket, { ...attachment, cursor: Math.max(attachment.cursor, sequence) });
    }
  }

  private broadcastToMember(memberId: string, frame: ServerFrame): void {
    for (const socket of this.socketsFor(memberId)) this.sendFrame(socket, frame);
  }

  private broadcastPresence(memberId: string, online: boolean): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.attachmentOf(socket);
      if (attachment === null || attachment.memberId === memberId) continue;
      this.sendFrame(socket, { type: "presence", memberId, online });
    }
  }

  private relayTyping(attachment: SocketAttachment, channelId: string, now: number): void {
    const channel = readChannel(this.ctx.storage, channelId);
    if (channel === null) return;
    if (!canSeeChannel(this.channelVisibility(channel, attachment.memberId))) return;
    for (const socket of this.ctx.getWebSockets()) {
      const other = this.attachmentOf(socket);
      if (other === null || other.memberId === attachment.memberId) continue;
      if (!canReceiveChannelEvent(this.channelVisibility(channel, other.memberId))) continue;
      this.sendFrame(socket, {
        type: "typing",
        channelId: channel.id,
        memberId: attachment.memberId,
        at: now,
      });
    }
  }

  private applyChannelRead(
    socket: WebSocket,
    attachment: SocketAttachment,
    channelId: string,
    requested: number,
    now: number,
  ): void {
    const channel = readChannel(this.ctx.storage, channelId);
    if (channel === null || !canSeeChannel(this.channelVisibility(channel, attachment.memberId))) {
      this.sendFrame(socket, { type: "error", reason: "channel not found" });
      return;
    }
    const sequence = this.advanceChannelCursor(channel.id, attachment.memberId, requested, now);
    this.broadcastToMember(attachment.memberId, { type: "read", channelId: channel.id, sequence });
  }

  private applyThreadRead(
    socket: WebSocket,
    attachment: SocketAttachment,
    threadRootId: string,
    requested: number,
    now: number,
  ): void {
    const root = readMessage(this.ctx.storage, threadRootId);
    if (root === null || root.threadRootId !== null) {
      this.sendFrame(socket, { type: "error", reason: "thread not found" });
      return;
    }
    const channel = readChannel(this.ctx.storage, root.channelId);
    if (channel === null || !canSeeChannel(this.channelVisibility(channel, attachment.memberId))) {
      this.sendFrame(socket, { type: "error", reason: "thread not found" });
      return;
    }
    const sequence = this.advanceThreadCursor(root.id, attachment.memberId, requested, now);
    this.broadcastToMember(attachment.memberId, {
      type: "thread_read",
      threadRootId: root.id,
      sequence,
    });
  }

  private advanceChannelCursor(
    channelId: string,
    memberId: string,
    requested: number,
    now: number,
  ): number {
    return this.ctx.storage.transactionSync(() => {
      const current = readChannelCursor(this.ctx.storage, channelId, memberId);
      const latest = latestChannelSequence(this.ctx.storage, channelId);
      const next = advanceReadCursor(current, requested, latest);
      if (next !== current) writeChannelCursor(this.ctx.storage, channelId, memberId, next, now);
      return next;
    });
  }

  private advanceThreadCursor(
    threadRootId: string,
    memberId: string,
    requested: number,
    now: number,
  ): number {
    return this.ctx.storage.transactionSync(() => {
      const current = readThreadCursor(this.ctx.storage, threadRootId, memberId);
      const latest = latestThreadSequence(this.ctx.storage, threadRootId);
      const next = advanceReadCursor(current, requested, latest);
      if (next !== current) writeThreadCursor(this.ctx.storage, threadRootId, memberId, next, now);
      return next;
    });
  }

  /* ------------------------------------------------------------------ */
  /* Rooms, direct messages and message writes (C02)                     */
  /* ------------------------------------------------------------------ */

  /**
   * Create a named room. The slug is normalised before it is stored, so two
   * spellings of the same name cannot become two rooms that look identical in a
   * sidebar, and a repeated request under the same idempotency key returns the
   * room the first one made rather than a second room.
   */
  async createChannel(input: {
    actor: Actor;
    idempotencyKey: string;
    kind: "public" | "private";
    slug: string;
    name?: string | null;
    topic?: string | null;
    memberIds?: readonly string[];
    now: number;
  }): Promise<CreatedChannel> {
    const actor = this.authorizeActor(input.actor);
    if (!ROOM_CREATOR_ROLES.has(actor.role)) throw new Error("this role cannot create rooms");
    if (input.kind !== "public" && input.kind !== "private") throw new Error("unknown room kind");

    const slug = parseChannelSlug(input.slug);
    if (slug === null) throw new Error("invalid channel slug");
    const name = parseChannelName(input.name, slug);
    const topic = parseChannelTopic(input.topic);
    const invited = this.resolveActiveMemberIds(input.memberIds ?? []);

    const outcome = await this.commitMutation(
      {
        scope: "channel.create",
        idempotencyKey: input.idempotencyKey,
        requestHash: `${actor.id}|${input.kind}|${slug}`,
        now: input.now,
      },
      () => {
        const existing = readChannelBySlug(this.ctx.storage, slug);
        if (existing) throw new Error("channel slug is already taken");

        const channelId = crypto.randomUUID();
        insertChannel(this.ctx.storage, {
          id: channelId,
          kind: input.kind,
          slug,
          name,
          topic,
          dmKey: null,
          createdByMemberId: actor.id,
          now: input.now,
        });
        const members = [...new Set([actor.id, ...invited])];
        addChannelMembers(this.ctx.storage, channelId, members, input.now);

        return {
          result: { channelId, kind: input.kind as ChannelKind, created: true },
          effects: this.channelEffects("channel.created", channelId, actor, {
            channel_kind: input.kind,
            member_count: members.length,
          }),
        };
      },
    );
    return { ...outcome.result, created: !outcome.replayed };
  }

  /**
   * Open the conversation between a set of people. The same set always resolves
   * to the same room, whoever opens it and in whatever order, so two people
   * cannot end up in two parallel copies of one conversation.
   */
  async openDirectMessage(input: {
    actor: Actor;
    idempotencyKey: string;
    participantMemberIds: readonly string[];
    now: number;
  }): Promise<CreatedChannel> {
    const actor = this.authorizeActor(input.actor);
    const identity = directMessageIdentity([actor.id, ...input.participantMemberIds]);
    if (identity === null) throw new Error("invalid direct message participants");

    const others = identity.participantIds.filter((id) => id !== actor.id);
    if (this.resolveActiveMemberIds(others).length !== others.length) {
      throw new Error("every participant must be an active member");
    }

    const outcome = await this.commitMutation(
      {
        scope: "channel.direct",
        idempotencyKey: input.idempotencyKey,
        requestHash: identity.key,
        now: input.now,
      },
      () => {
        const existing = readChannelByDirectMessageKey(this.ctx.storage, identity.key);
        if (existing) {
          return { result: { channelId: existing.id, kind: existing.kind, created: false } };
        }
        const channelId = crypto.randomUUID();
        insertChannel(this.ctx.storage, {
          id: channelId,
          kind: identity.kind,
          slug: null,
          name: null,
          topic: null,
          dmKey: identity.key,
          createdByMemberId: actor.id,
          now: input.now,
        });
        addChannelMembers(this.ctx.storage, channelId, identity.participantIds, input.now);
        return {
          result: { channelId, kind: identity.kind as ChannelKind, created: true },
          effects: this.channelEffects("channel.direct_opened", channelId, actor, {
            channel_kind: identity.kind,
            member_count: identity.participantIds.length,
          }),
        };
      },
    );
    return { ...outcome.result, created: outcome.replayed ? false : outcome.result.created };
  }

  /** Anyone in the workspace may join an open room; a closed one needs an invite. */
  async joinChannel(input: { actor: Actor; channelId: string; now: number }): Promise<{ joined: boolean }> {
    const actor = this.authorizeActor(input.actor);
    const channel = this.requireVisibleChannel(input.channelId, actor.id);
    if (channel.kind !== "public") throw new Error("this room is joined by invitation only");
    if (channel.archivedAt !== null) throw new Error("this room is archived");

    const outcome = await this.commitMutation({ scope: "channel.join", now: input.now }, () => {
      const added = addChannelMembers(this.ctx.storage, channel.id, [actor.id], input.now);
      if (added.length === 0) return { result: { joined: false } };
      return {
        result: { joined: true },
        effects: this.channelEffects("channel.member_joined", channel.id, actor, {
          channel_kind: channel.kind,
        }),
      };
    });
    return outcome.result;
  }

  /** Adding someone else requires already being in the room you are adding them to. */
  async addChannelMember(input: {
    actor: Actor;
    channelId: string;
    memberId: string;
    now: number;
  }): Promise<{ added: boolean }> {
    const actor = this.authorizeActor(input.actor);
    const channel = this.requireChannelParticipant(input.channelId, actor.id);
    if (channel.kind === "dm" || channel.kind === "group_dm") {
      throw new Error("a conversation's participants are fixed when it is opened");
    }
    if (channel.archivedAt !== null) throw new Error("this room is archived");
    if (this.resolveActiveMemberIds([input.memberId]).length !== 1) {
      throw new Error("member is not active in this workspace");
    }

    const outcome = await this.commitMutation({ scope: "channel.add_member", now: input.now }, () => {
      const added = addChannelMembers(this.ctx.storage, channel.id, [input.memberId], input.now);
      if (added.length === 0) return { result: { added: false } };
      return {
        result: { added: true },
        effects: this.channelEffects("channel.member_added", channel.id, actor, {
          channel_kind: channel.kind,
          subject_member_id: input.memberId,
        }),
      };
    });
    return outcome.result;
  }

  /** Leaving is idempotent: a retry after a lost response is not an error. */
  async leaveChannel(input: { actor: Actor; channelId: string; now: number }): Promise<{ left: boolean }> {
    const actor = this.authorizeActor(input.actor);
    const channel = this.requireVisibleChannel(input.channelId, actor.id);
    if (channel.kind === "dm" || channel.kind === "group_dm") {
      throw new Error("a conversation cannot be left, only muted");
    }

    const outcome = await this.commitMutation({ scope: "channel.leave", now: input.now }, () => {
      const removed = removeChannelMember(this.ctx.storage, channel.id, actor.id);
      if (!removed) return { result: { left: false } };
      return {
        result: { left: true },
        effects: this.channelEffects("channel.member_left", channel.id, actor, {
          channel_kind: channel.kind,
        }),
      };
    });
    return outcome.result;
  }

  async archiveChannel(input: { actor: Actor; channelId: string; now: number }): Promise<{ archived: boolean }> {
    const actor = this.authorizeActor(input.actor);
    const channel = this.requireVisibleChannel(input.channelId, actor.id);
    if (channel.kind === "dm" || channel.kind === "group_dm") {
      throw new Error("a conversation cannot be archived");
    }
    const permitted =
      actor.role === "owner" || actor.role === "admin" || channel.createdByMemberId === actor.id;
    if (!permitted) throw new Error("only an admin or the room's creator may archive it");
    if (channel.archivedAt !== null) return { archived: false };

    const outcome = await this.commitMutation({ scope: "channel.archive", now: input.now }, () => {
      archiveChannel(this.ctx.storage, channel.id, input.now);
      return {
        result: { archived: true },
        effects: this.channelEffects("channel.archived", channel.id, actor, {
          channel_kind: channel.kind,
        }),
      };
    });
    return outcome.result;
  }

  /**
   * Write a message. This is the plan authority check: on a Solo workspace the
   * designated host owns content and this object must refuse, because storing
   * the body here is exactly what the free-plan contract forbids.
   *
   * On a Team workspace the row, the channel and thread aggregates, the audit
   * entry, the realtime replay entry and the delivery record commit in one
   * transaction, and a retry under the same idempotency key returns the first
   * message rather than writing a second one.
   */
  async sendMessage(input: {
    actor: Actor;
    idempotencyKey: string;
    channelId: string;
    bodyMarkdown: string;
    threadParentId?: string | null;
    now: number;
  }): Promise<SentMessage> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();

    const channel = this.requireChannelParticipant(input.channelId, actor.id);
    if (channel.archivedAt !== null) throw new Error("this room is archived");

    const body = parseMessageBody(input.bodyMarkdown);
    if (body === null) throw new Error("message body is empty or too long");

    const parent = input.threadParentId ? readMessage(this.ctx.storage, input.threadParentId) : null;
    if (input.threadParentId && parent === null) throw new Error("thread parent not found");
    const placement = resolveThreadPlacement(parent, channel.id);
    if (placement.kind === "invalid") throw new Error(placement.reason);
    const threadRootId = placement.kind === "reply" ? placement.threadRootId : null;

    const outcome = await this.commitMutation(
      {
        scope: "message.send",
        idempotencyKey: input.idempotencyKey,
        requestHash: `${actor.id}|${channel.id}|${threadRootId ?? ""}|${body.length}`,
        now: input.now,
      },
      () => {
        const messageId = crypto.randomUUID();
        const channelSequence = nextChannelSequence(this.ctx.storage, channel.id);
        const mentions = resolveMentionTargets(this.ctx.storage, parseMentions(body));
        insertMessage(this.ctx.storage, {
          id: messageId,
          channelId: channel.id,
          threadRootId,
          authorKind: "member",
          authorId: actor.id,
          authorDisplaySnapshot: actor.displayName,
          bodyMarkdown: body,
          channelSequence,
          now: input.now,
        });
        replaceMentions(this.ctx.storage, messageId, mentions, input.now);
        // A mention becomes work in the same transaction as the message, so a
        // queue item can never exist for a message that was rolled back.
        const enqueued = this.enqueueAgentMentions({
          messageId,
          channelId: channel.id,
          authorKind: "member",
          authorId: actor.id,
          bodyMarkdown: body,
          mentions,
          isHistorical: false,
          now: input.now,
        });

        return {
          result: {
            messageId,
            channelId: channel.id,
            threadRootId,
            channelSequence,
            createdAt: input.now,
            replayed: false,
          },
          effects: {
            // No body, anywhere: an audit record explains who acted, not what
            // they said, and it is retained far longer than the message is.
            audit: {
              eventType: "message.created",
              outcome: "allowed" as const,
              requesterKind: "member" as const,
              requesterId: actor.id,
              subjectKind: "message",
              subjectId: messageId,
              metadata: {
                channel_id: channel.id,
                channel_kind: channel.kind,
                in_thread: threadRootId !== null,
                channel_sequence: channelSequence,
                mention_count: mentions.length,
                agent_work_enqueued: enqueued,
              },
            },
            // Delivery carries identifiers; a reader fetches the message it is
            // authorised for rather than receiving a copy in the event.
            replay: [
              {
                kind: "message.created",
                audience: [channel.id],
                payload: {
                  messageId,
                  channelId: channel.id,
                  threadRootId,
                  channelSequence,
                  authorId: actor.id,
                  createdAt: input.now,
                },
              },
            ],
            outbox: [
              {
                id: `message.${messageId}`,
                kind: "message_created",
                dedupeKey: `message:${messageId}`,
                payload: { messageId, channelId: channel.id, threadRootId },
              },
            ],
          } satisfies MutationEffects,
        };
      },
    );

    // Persist, then broadcast: the write is already durable, and the ordering
    // clients observe is the ordering the database has.
    if (!outcome.replayed) {
      this.broadcastChannelEvent(channel, this.latestReplaySequence(), "message.created", {
        messageId: outcome.result.messageId,
        channelId: channel.id,
        threadRootId: outcome.result.threadRootId,
        channelSequence: outcome.result.channelSequence,
        authorId: actor.id,
        createdAt: input.now,
      });
    }
    return { ...outcome.result, replayed: outcome.replayed };
  }

  /**
   * Only the author may rewrite what they said. An edit keeps the message's
   * place in the room and its sequence, re-derives who it addresses, and leaves
   * a visible marker rather than changing the record silently.
   */
  async editMessage(input: {
    actor: Actor;
    messageId: string;
    bodyMarkdown: string;
    now: number;
  }): Promise<{ messageId: string; editedAt: number }> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const { message, channel } = this.requireOwnMessage(input.messageId, actor.id, "edit");

    const body = parseMessageBody(input.bodyMarkdown);
    if (body === null) throw new Error("message body is empty or too long");

    const outcome = await this.commitMutation({ scope: "message.edit", now: input.now }, () => {
      applyMessageEdit(this.ctx.storage, message.id, body, input.now);
      const mentions = resolveMentionTargets(this.ctx.storage, parseMentions(body));
      replaceMentions(this.ctx.storage, message.id, mentions, input.now);
      return {
        result: { messageId: message.id, editedAt: input.now },
        effects: this.messageEffects("message.edited", message.id, channel, actor, {
          mention_count: mentions.length,
        }),
      };
    });

    this.broadcastChannelEvent(channel, this.latestReplaySequence(), "message.edited", {
      messageId: message.id,
      channelId: channel.id,
      editedAt: input.now,
    });
    return outcome.result;
  }

  /**
   * A delete removes the content, not the row. The tombstone keeps the thread
   * readable and the sequence intact; the body, its mentions and its reactions
   * leave every read immediately. An admin may delete somebody else's message,
   * and the audit record says who did.
   */
  async deleteMessage(input: {
    actor: Actor;
    messageId: string;
    now: number;
  }): Promise<{ messageId: string; deletedAt: number }> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const message = readMessage(this.ctx.storage, input.messageId);
    if (message === null || message.deletedAt !== null) throw new Error("message not found");
    const channel = this.requireVisibleChannel(message.channelId, actor.id);
    const moderator = actor.role === "owner" || actor.role === "admin";
    if (message.authorId !== actor.id && !moderator) {
      throw new Error("only the author or an admin may delete a message");
    }

    const outcome = await this.commitMutation({ scope: "message.delete", now: input.now }, () => {
      applyMessageDelete(this.ctx.storage, message.id, actor.id, input.now);
      return {
        result: { messageId: message.id, deletedAt: input.now },
        effects: this.messageEffects("message.deleted", message.id, channel, actor, {
          by_author: message.authorId === actor.id,
        }),
      };
    });

    this.broadcastChannelEvent(channel, this.latestReplaySequence(), "message.deleted", {
      messageId: message.id,
      channelId: channel.id,
      deletedAt: input.now,
    });
    return outcome.result;
  }

  /** Reacting is idempotent: one person and one emoji is one reaction. */
  async reactToMessage(input: {
    actor: Actor;
    messageId: string;
    emoji: string;
    now: number;
  }): Promise<{ added: boolean }> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const { message, channel } = this.requireReactableMessage(input.messageId, actor.id);
    const emoji = this.requireUsableReaction(input.emoji);

    const outcome = await this.commitMutation({ scope: "message.react", now: input.now }, () => {
      const added = addReaction(this.ctx.storage, message.id, actor.id, emoji, input.now);
      if (!added) return { result: { added: false } };
      return {
        result: { added: true },
        effects: this.messageEffects("message.reacted", message.id, channel, actor, {
          reaction_length: emoji.length,
        }),
      };
    });

    if (outcome.result.added) {
      this.broadcastChannelEvent(channel, this.latestReplaySequence(), "message.reacted", {
        messageId: message.id,
        channelId: channel.id,
        emoji,
        memberId: actor.id,
        added: true,
      });
    }
    return outcome.result;
  }

  async unreactToMessage(input: {
    actor: Actor;
    messageId: string;
    emoji: string;
    now: number;
  }): Promise<{ removed: boolean }> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const { message, channel } = this.requireReactableMessage(input.messageId, actor.id);
    // Removing is allowed even for a name since withdrawn, so a reaction cannot
    // be stranded by an admin deleting the emoji.
    const emoji = parseReactionEmoji(input.emoji);
    if (emoji === null) throw new Error("invalid reaction");

    const removed = this.ctx.storage.transactionSync(() =>
      removeReaction(this.ctx.storage, message.id, actor.id, emoji),
    );
    if (removed) {
      this.broadcastChannelEvent(channel, this.latestReplaySequence(), "message.reacted", {
        messageId: message.id,
        channelId: channel.id,
        emoji,
        memberId: actor.id,
        added: false,
      });
    }
    return { removed };
  }

  /**
   * A reaction is a literal emoji, or the name of one this workspace has
   * defined. An unnamed `:token:` is refused rather than stored, or the column
   * becomes a second message body nobody indexed.
   */
  private requireUsableReaction(value: string): string {
    const emoji = parseReactionEmoji(value);
    if (emoji === null) throw new Error("invalid reaction");
    if (!isEmojiToken(emoji)) return emoji;
    const name = parseCustomEmojiName(emoji);
    if (name === null || !customEmojiExists(this.ctx.storage, name)) {
      throw new Error("no custom emoji by that name");
    }
    return emoji;
  }

  private requireOwnMessage(
    messageId: string,
    memberId: string,
    verb: string,
  ): { message: MessageRow; channel: ChannelRow } {
    const message = readMessage(this.ctx.storage, messageId);
    if (message === null || message.deletedAt !== null) throw new Error("message not found");
    const channel = this.requireVisibleChannel(message.channelId, memberId);
    if (message.authorId !== memberId || message.authorKind !== "member") {
      throw new Error(`only the author may ${verb} a message`);
    }
    if (channel.archivedAt !== null) throw new Error("this room is archived");
    return { message, channel };
  }

  private requireReactableMessage(
    messageId: string,
    memberId: string,
  ): { message: MessageRow; channel: ChannelRow } {
    const message = readMessage(this.ctx.storage, messageId);
    if (message === null || message.deletedAt !== null) throw new Error("message not found");
    const channel = this.requireChannelParticipant(message.channelId, memberId);
    if (channel.archivedAt !== null) throw new Error("this room is archived");
    return { message, channel };
  }

  private messageEffects(
    eventType: string,
    messageId: string,
    channel: ChannelRow,
    actor: ActiveMember,
    metadata: Record<string, string | number | boolean | null>,
  ): MutationEffects {
    return {
      audit: {
        eventType,
        outcome: "allowed",
        requesterKind: "member",
        requesterId: actor.id,
        subjectKind: "message",
        subjectId: messageId,
        metadata: { channel_id: channel.id, ...metadata },
      },
      replay: [
        {
          kind: eventType,
          audience: [channel.id],
          payload: { messageId, channelId: channel.id, actorId: actor.id },
        },
      ],
    };
  }

  /* ------------------------------------------------------------------ */
  /* Pins, saved items and forwarding (C05a)                             */
  /* ------------------------------------------------------------------ */

  /** A pin belongs to the room, so pinning requires being in it. */
  async pinMessage(input: {
    actor: Actor;
    messageId: string;
    now: number;
  }): Promise<{ pinned: boolean }> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const { message, channel } = this.requireReactableMessage(input.messageId, actor.id);

    const outcome = await this.commitMutation({ scope: "message.pin", now: input.now }, () => {
      const pinned = pinMessage(this.ctx.storage, channel.id, message.id, actor.id, input.now);
      if (!pinned) return { result: { pinned: false } };
      return {
        result: { pinned: true },
        effects: this.messageEffects("message.pinned", message.id, channel, actor, {}),
      };
    });

    if (outcome.result.pinned) {
      this.broadcastChannelEvent(channel, this.latestReplaySequence(), "message.pinned", {
        messageId: message.id,
        channelId: channel.id,
        pinned: true,
      });
    }
    return outcome.result;
  }

  async unpinMessage(input: {
    actor: Actor;
    messageId: string;
    now: number;
  }): Promise<{ unpinned: boolean }> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const { message, channel } = this.requireReactableMessage(input.messageId, actor.id);

    const unpinned = this.ctx.storage.transactionSync(() =>
      unpinMessage(this.ctx.storage, channel.id, message.id),
    );
    if (unpinned) {
      this.broadcastChannelEvent(channel, this.latestReplaySequence(), "message.pinned", {
        messageId: message.id,
        channelId: channel.id,
        pinned: false,
      });
    }
    return { unpinned };
  }

  /** The room's pins, for anybody the room is visible to. */
  listPins(input: { actor: Actor; channelId: string; limit?: number }): { messages: readonly MessageRow[] } {
    const actor = this.authorizeActor(input.actor);
    const channel = this.requireVisibleChannel(input.channelId, actor.id);
    const messages = listPinnedMessages(this.ctx.storage, channel.id, clampHistoryLimit(input.limit));
    return {
      messages: this.decorateMessages(messages, actor.id).messages,
    };
  }

  /**
   * Saving is private and requires being able to read the message now. It saves
   * a pointer, not a copy and not a permission.
   */
  async saveMessage(input: {
    actor: Actor;
    messageId: string;
    now: number;
  }): Promise<{ saved: boolean }> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const message = readMessage(this.ctx.storage, input.messageId);
    if (message === null || message.deletedAt !== null) throw new Error("message not found");
    // Visible, not necessarily joined: you may save something from an open room.
    this.requireVisibleChannel(message.channelId, actor.id);

    const saved = this.ctx.storage.transactionSync(() =>
      saveMessageForMember(this.ctx.storage, actor.id, message.id, input.now),
    );
    return { saved };
  }

  async unsaveMessage(input: {
    actor: Actor;
    messageId: string;
  }): Promise<{ removed: boolean }> {
    const actor = this.authorizeActor(input.actor);
    // Removing a pointer needs no visibility: it is this member's own list, and
    // refusing would strand a saved item in a room they can no longer see.
    const removed = this.ctx.storage.transactionSync(() =>
      unsaveMessageForMember(this.ctx.storage, actor.id, input.messageId),
    );
    return { removed };
  }

  /**
   * This member's saved messages.
   *
   * Every pointer is rechecked against the room as it stands now. A message
   * saved from a room the member has since left, or that has since been
   * deleted, is not returned — the saved list is not a way to keep reading
   * something you can no longer read.
   */
  listSavedItems(input: { actor: Actor; limit?: number }): {
    items: readonly { message: MessageRow; savedAt: number }[];
    /** Pointers dropped because the member may no longer read them. */
    unavailable: number;
  } {
    const actor = this.authorizeActor(input.actor);
    const limit = clampHistoryLimit(input.limit);
    const pointers = listSavedPointers(this.ctx.storage, actor.id, limit);

    const readable: { message: MessageRow; savedAt: number }[] = [];
    let unavailable = 0;
    for (const pointer of pointers) {
      if (pointer.message.deletedAt !== null) {
        unavailable += 1;
        continue;
      }
      const channel = readChannel(this.ctx.storage, pointer.message.channelId);
      if (channel === null || !canSeeChannel(this.channelVisibility(channel, actor.id))) {
        unavailable += 1;
        continue;
      }
      readable.push(pointer);
    }

    const decorated = this.decorateMessages(
      readable.map((entry) => entry.message),
      actor.id,
    ).messages;
    return {
      items: decorated.map((message, index) => ({ message, savedAt: readable[index].savedAt })),
      unavailable,
    };
  }

  /**
   * Forward a message into another room.
   *
   * A forward is a new message carrying a copy, not a window into the room it
   * came from: the copy is made by somebody who can read the original, and it
   * is written into a room they may post in. Both are checked here, and the
   * provenance is resolved for each reader separately when it is displayed.
   */
  async forwardMessage(input: {
    actor: Actor;
    idempotencyKey: string;
    messageId: string;
    targetChannelId: string;
    comment?: string | null;
    now: number;
  }): Promise<SentMessage> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();

    const source = readMessage(this.ctx.storage, input.messageId);
    if (source === null || source.deletedAt !== null) throw new Error("message not found");
    // Readable by this member right now, not merely once.
    const sourceChannel = this.requireVisibleChannel(source.channelId, actor.id);
    const target = this.requireChannelParticipant(input.targetChannelId, actor.id);
    if (target.archivedAt !== null) throw new Error("this room is archived");

    const comment = input.comment ? parseMessageBody(input.comment) : null;
    if (input.comment && comment === null) throw new Error("message body is empty or too long");
    const body = parseMessageBody(comment ? `${comment}\n\n${source.bodyMarkdown}` : source.bodyMarkdown);
    if (body === null) throw new Error("message body is empty or too long");

    const outcome = await this.commitMutation(
      {
        scope: "message.forward",
        idempotencyKey: input.idempotencyKey,
        requestHash: `${actor.id}|${source.id}|${target.id}`,
        now: input.now,
      },
      () => {
        const messageId = crypto.randomUUID();
        const channelSequence = nextChannelSequence(this.ctx.storage, target.id);
        const mentions = resolveMentionTargets(this.ctx.storage, parseMentions(body));
        insertMessage(this.ctx.storage, {
          id: messageId,
          channelId: target.id,
          threadRootId: null,
          authorKind: "member",
          authorId: actor.id,
          authorDisplaySnapshot: actor.displayName,
          bodyMarkdown: body,
          channelSequence,
          forwardedFrom: {
            messageId: source.id,
            channelId: sourceChannel.id,
            authorDisplaySnapshot: source.authorDisplaySnapshot,
          },
          now: input.now,
        });
        replaceMentions(this.ctx.storage, messageId, mentions, input.now);

        return {
          result: {
            messageId,
            channelId: target.id,
            threadRootId: null,
            channelSequence,
            createdAt: input.now,
            replayed: false,
          },
          effects: {
            audit: {
              eventType: "message.forwarded",
              outcome: "allowed" as const,
              requesterKind: "member" as const,
              requesterId: actor.id,
              subjectKind: "message",
              subjectId: messageId,
              metadata: {
                channel_id: target.id,
                source_channel_id: sourceChannel.id,
                source_message_id: source.id,
              },
            },
            replay: [
              {
                kind: "message.created",
                audience: [target.id],
                payload: {
                  messageId,
                  channelId: target.id,
                  threadRootId: null,
                  channelSequence,
                  authorId: actor.id,
                  createdAt: input.now,
                },
              },
            ],
            outbox: [
              {
                id: `message.${messageId}`,
                kind: "message_created",
                dedupeKey: `message:${messageId}`,
                payload: { messageId, channelId: target.id, threadRootId: null },
              },
            ],
          } satisfies MutationEffects,
        };
      },
    );

    if (!outcome.replayed) {
      this.broadcastChannelEvent(target, this.latestReplaySequence(), "message.created", {
        messageId: outcome.result.messageId,
        channelId: target.id,
        threadRootId: null,
        channelSequence: outcome.result.channelSequence,
        authorId: actor.id,
        createdAt: input.now,
      });
    }
    return { ...outcome.result, replayed: outcome.replayed };
  }

  /**
   * Attach per-reader state to a page: reactions, mentions, whether this member
   * pinned or saved each message, and whether they may see where a forward came
   * from. Provenance is resolved per reader because the room a copy came from
   * may be one this reader cannot see.
   */
  private decorateMessages(messages: readonly MessageRow[], memberId: string): MessagePage {
    const annotated = annotateMessages(this.ctx.storage, { messages, nextCursor: null });
    const saved = savedMessageIds(this.ctx.storage, memberId);
    const snippets = readSnippets(
      this.ctx.storage,
      messages.map((message) => message.id),
    );
    const pinsByChannel = new Map<string, Set<string>>();

    const decorated = annotated.messages.map((message) => {
      if (!pinsByChannel.has(message.channelId)) {
        pinsByChannel.set(message.channelId, pinnedMessageIds(this.ctx.storage, message.channelId));
      }
      let forwardedFrom = message.forwardedFrom;
      if (forwardedFrom !== null) {
        const sourceChannel = readChannel(this.ctx.storage, forwardedFrom.channelId);
        const visible =
          sourceChannel !== null && canSeeChannel(this.channelVisibility(sourceChannel, memberId));
        forwardedFrom = {
          ...forwardedFrom,
          sourceVisible: visible,
          // The room's name is withheld from a reader who cannot see the room.
          sourceChannelLabel:
            visible && sourceChannel ? (sourceChannel.slug ?? sourceChannel.name ?? sourceChannel.id) : null,
          channelId: visible ? forwardedFrom.channelId : "",
        };
      }
      return {
        ...message,
        forwardedFrom,
        isSaved: saved.has(message.id),
        isPinned: pinsByChannel.get(message.channelId)!.has(message.id),
        snippet: snippets.get(message.id) ?? null,
      };
    });

    return { messages: decorated, nextCursor: annotated.nextCursor };
  }

  /* ------------------------------------------------------------------ */
  /* Synced drafts and scheduled messages (C05b)                         */
  /* ------------------------------------------------------------------ */

  /**
   * Save a draft for this member and this composing surface.
   *
   * Drafts follow a person between devices, which means two devices can edit
   * one draft. The caller sends the revision it was editing from; if the stored
   * draft has moved on, this refuses and hands back what is actually stored
   * rather than silently overwriting whatever the other device typed.
   */
  saveDraft(input: {
    actor: Actor;
    channelId: string;
    threadRootId?: string | null;
    bodyMarkdown: string;
    baseRevision?: number;
    now: number;
  }): DraftSaveResult {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    this.requireChannelParticipant(input.channelId, actor.id);
    const threadKey = this.requireThreadKey(input.channelId, input.threadRootId ?? null);

    const body = input.bodyMarkdown.slice(0, MAX_MESSAGE_LENGTH);

    return this.ctx.storage.transactionSync(() => {
      const existing = readDraft(this.ctx.storage, actor.id, input.channelId, threadKey);

      // An empty body clears the draft rather than storing nothing.
      if (body.trim().length === 0) {
        if (existing && input.baseRevision !== undefined && existing.revision !== input.baseRevision) {
          return { status: "conflict" as const, draft: existing };
        }
        deleteDraft(this.ctx.storage, actor.id, input.channelId, threadKey);
        return { status: "cleared" as const, draft: null };
      }

      if (existing && input.baseRevision !== undefined && existing.revision !== input.baseRevision) {
        return { status: "conflict" as const, draft: existing };
      }

      const revision = (existing?.revision ?? 0) + 1;
      writeDraft(this.ctx.storage, actor.id, input.channelId, threadKey, body, revision, input.now);
      return {
        status: "saved" as const,
        draft: {
          channelId: input.channelId,
          threadRootId: threadKey === "" ? null : threadKey,
          bodyMarkdown: body,
          revision,
          updatedAt: input.now,
        },
      };
    });
  }

  getDraft(input: {
    actor: Actor;
    channelId: string;
    threadRootId?: string | null;
  }): { draft: DraftRow | null } {
    const actor = this.authorizeActor(input.actor);
    const channel = this.requireVisibleChannel(input.channelId, actor.id);
    const threadKey = input.threadRootId ?? "";
    return { draft: readDraft(this.ctx.storage, actor.id, channel.id, threadKey) };
  }

  /**
   * Every draft this member has, filtered to rooms they can still see. A draft
   * left in a room they have since left is not handed back to them.
   */
  listDrafts(input: { actor: Actor }): { drafts: readonly DraftRow[]; unavailable: number } {
    const actor = this.authorizeActor(input.actor);
    const all = listDraftsForMember(this.ctx.storage, actor.id);
    const drafts: DraftRow[] = [];
    let unavailable = 0;
    for (const draft of all) {
      const channel = readChannel(this.ctx.storage, draft.channelId);
      if (channel === null || !canSeeChannel(this.channelVisibility(channel, actor.id))) {
        unavailable += 1;
        continue;
      }
      drafts.push(draft);
    }
    return { drafts, unavailable };
  }

  /**
   * Schedule a message for later.
   *
   * The body is validated now so a scheduled send cannot become a surprise
   * failure at three in the morning, and the deadline rides the object's one
   * alarm through the F06 scheduler rather than a timer of its own.
   */
  async scheduleMessage(input: {
    actor: Actor;
    idempotencyKey: string;
    channelId: string;
    bodyMarkdown: string;
    threadParentId?: string | null;
    sendAt: number;
    now: number;
  }): Promise<{ id: string; sendAt: number; replayed: boolean }> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const channel = this.requireChannelParticipant(input.channelId, actor.id);
    if (channel.archivedAt !== null) throw new Error("this room is archived");

    const sendAt = this.requireSendAt(input.sendAt, input.now);
    const body = parseMessageBody(input.bodyMarkdown);
    if (body === null) throw new Error("message body is empty or too long");
    const threadRootId = this.resolveScheduledThreadRoot(input.threadParentId ?? null, channel.id);

    const outcome = await this.commitMutation(
      {
        scope: "message.schedule",
        idempotencyKey: input.idempotencyKey,
        requestHash: `${actor.id}|${channel.id}|${sendAt}`,
        now: input.now,
      },
      () => {
        const id = crypto.randomUUID();
        insertScheduledMessage(this.ctx.storage, {
          id,
          memberId: actor.id,
          channelId: channel.id,
          threadRootId,
          bodyMarkdown: body,
          sendAt,
          now: input.now,
        });
        return {
          result: { id, sendAt },
          effects: {
            audit: {
              eventType: "message.scheduled",
              outcome: "allowed" as const,
              requesterKind: "member" as const,
              requesterId: actor.id,
              subjectKind: "scheduled_message",
              subjectId: id,
              metadata: { channel_id: channel.id, send_at: sendAt },
            },
            dueWork: [{ id: SCHEDULED_SEND_WORK_ID, kind: "scheduled_send", dueAt: sendAt }],
          } satisfies MutationEffects,
        };
      },
    );

    await this.armScheduledSends(input.now);
    return { ...outcome.result, replayed: outcome.replayed };
  }

  /** Only the person who scheduled it may change it, and only before it fires. */
  async updateScheduledMessage(input: {
    actor: Actor;
    id: string;
    bodyMarkdown?: string;
    sendAt?: number;
    now: number;
  }): Promise<{ updated: boolean; sendAt: number }> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const scheduled = this.requireOwnScheduledMessage(input.id, actor.id);

    const changes: { bodyMarkdown?: string; sendAt?: number } = {};
    if (input.bodyMarkdown !== undefined) {
      const body = parseMessageBody(input.bodyMarkdown);
      if (body === null) throw new Error("message body is empty or too long");
      changes.bodyMarkdown = body;
    }
    if (input.sendAt !== undefined) changes.sendAt = this.requireSendAt(input.sendAt, input.now);

    const updated = this.ctx.storage.transactionSync(() =>
      updateScheduledMessage(this.ctx.storage, scheduled.id, changes, input.now),
    );
    await this.armScheduledSends(input.now);
    return { updated, sendAt: changes.sendAt ?? scheduled.sendAt };
  }

  async cancelScheduledMessage(input: {
    actor: Actor;
    id: string;
    now: number;
  }): Promise<{ cancelled: boolean }> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const scheduled = this.requireOwnScheduledMessage(input.id, actor.id);
    const cancelled = this.ctx.storage.transactionSync(() =>
      settleScheduledMessage(this.ctx.storage, scheduled.id, { status: "cancelled" }, input.now),
    );
    await this.armScheduledSends(input.now);
    return { cancelled };
  }

  listScheduledMessages(input: { actor: Actor; limit?: number }): {
    scheduled: readonly ScheduledMessageRow[];
  } {
    const actor = this.authorizeActor(input.actor);
    return {
      scheduled: listScheduledForMember(this.ctx.storage, actor.id, clampHistoryLimit(input.limit)),
    };
  }

  /**
   * Send everything that has come due.
   *
   * Authority is rechecked at the moment of sending, not at the moment of
   * scheduling: somebody suspended, removed from the room, or whose room was
   * archived in the meantime does not get a message posted in their name. A
   * refusal settles the row with a reason instead of retrying forever.
   *
   * The send itself is keyed on the scheduled id, so a duplicate alarm returns
   * the message the first one wrote rather than posting a second.
   */
  async deliverDueScheduledMessages(now: number): Promise<{
    sent: number;
    failed: number;
    considered: number;
  }> {
    const due = claimDueScheduledMessages(this.ctx.storage, now, SCHEDULED_SEND_BATCH);
    let sent = 0;
    let failed = 0;

    for (const scheduled of due) {
      const refusal = this.scheduledSendRefusal(scheduled);
      if (refusal !== null) {
        this.ctx.storage.transactionSync(() =>
          settleScheduledMessage(
            this.ctx.storage,
            scheduled.id,
            { status: "failed", reason: refusal },
            now,
          ),
        );
        failed += 1;
        continue;
      }

      try {
        const result = await this.sendMessage({
          actor: {
            memberId: scheduled.memberId,
            authorizationEpoch: this.memberAuthorizationEpoch(scheduled.memberId),
          },
          // Keyed on the scheduled row, so a duplicate alarm cannot post twice.
          idempotencyKey: `scheduled:${scheduled.id}`,
          channelId: scheduled.channelId,
          bodyMarkdown: scheduled.bodyMarkdown,
          threadParentId: scheduled.threadRootId,
          now,
        });
        this.ctx.storage.transactionSync(() =>
          settleScheduledMessage(
            this.ctx.storage,
            scheduled.id,
            { status: "sent", messageId: result.messageId },
            now,
          ),
        );
        sent += 1;
      } catch (error) {
        this.ctx.storage.transactionSync(() =>
          settleScheduledMessage(
            this.ctx.storage,
            scheduled.id,
            { status: "failed", reason: redactedError(error) },
            now,
          ),
        );
        failed += 1;
      }
    }

    await this.armScheduledSends(now);
    return { sent, failed, considered: due.length };
  }

  /* -- scheduling helpers ---------------------------------------------- */

  /** Why this scheduled message must not be sent, or null if it may be. */
  private scheduledSendRefusal(scheduled: ScheduledMessageRow): string | null {
    const member = this.ctx.storage.sql
      .exec<{ status: string }>("SELECT status FROM members WHERE id = ?", scheduled.memberId)
      .toArray()[0];
    if (!member || member.status !== "active") return "author is no longer an active member";

    const channel = readChannel(this.ctx.storage, scheduled.channelId);
    if (channel === null) return "channel no longer exists";
    if (channel.archivedAt !== null) return "channel was archived before the send time";
    if (!isChannelMember(this.ctx.storage, channel.id, scheduled.memberId)) {
      return "author is no longer in the channel";
    }
    return null;
  }

  private memberAuthorizationEpoch(memberId: string): number {
    return (
      this.ctx.storage.sql
        .exec<{ authorization_epoch: number }>(
          "SELECT authorization_epoch FROM members WHERE id = ?",
          memberId,
        )
        .toArray()[0]?.authorization_epoch ?? 0
    );
  }

  /** Keep the object's one alarm pointed at the next scheduled send. */
  private async armScheduledSends(now: number): Promise<void> {
    const next = nextScheduledSendAt(this.ctx.storage);
    if (next === null) return;
    this.ctx.storage.transactionSync(() =>
      scheduleDueWork(
        this.ctx.storage,
        [{ id: SCHEDULED_SEND_WORK_ID, kind: "scheduled_send", dueAt: next }],
        now,
      ),
    );
    await this.armAlarm();
  }

  private requireSendAt(sendAt: number, now: number): number {
    if (!Number.isSafeInteger(sendAt)) throw new Error("send time must be a whole timestamp");
    if (sendAt <= now) throw new Error("send time must be in the future");
    if (sendAt - now > MAX_SCHEDULE_AHEAD_MS) throw new Error("send time is too far ahead");
    return sendAt;
  }

  private requireOwnScheduledMessage(id: string, memberId: string): ScheduledMessageRow {
    const scheduled = readScheduledMessage(this.ctx.storage, id);
    // Somebody else's scheduled message is reported as missing, not forbidden.
    if (scheduled === null || scheduled.memberId !== memberId) {
      throw new Error("scheduled message not found");
    }
    if (scheduled.status !== "scheduled") throw new Error("this message has already been settled");
    return scheduled;
  }

  private resolveScheduledThreadRoot(parentId: string | null, channelId: string): string | null {
    if (parentId === null) return null;
    const parent = readMessage(this.ctx.storage, parentId);
    if (parent === null) throw new Error("thread parent not found");
    const placement = resolveThreadPlacement(parent, channelId);
    if (placement.kind === "invalid") throw new Error(placement.reason);
    return placement.kind === "reply" ? placement.threadRootId : null;
  }

  /** A draft's thread key must name a real thread root in that same room. */
  private requireThreadKey(channelId: string, threadRootId: string | null): string {
    if (threadRootId === null || threadRootId === "") return "";
    const root = readMessage(this.ctx.storage, threadRootId);
    if (root === null || root.channelId !== channelId || root.threadRootId !== null) {
      throw new Error("thread not found");
    }
    return root.id;
  }

  /* ------------------------------------------------------------------ */
  /* Snippets, slash commands and custom emoji (C05c)                    */
  /* ------------------------------------------------------------------ */

  /**
   * Post a snippet: a message whose real content is too long to be one.
   *
   * The message itself carries a one-line summary so history stays readable;
   * the body travels beside it and is loaded with the page that shows it.
   */
  async sendSnippet(input: {
    actor: Actor;
    idempotencyKey: string;
    channelId: string;
    title?: string | null;
    language?: string | null;
    body: string;
    threadParentId?: string | null;
    now: number;
  }): Promise<SentMessage> {
    const actor = this.authorizeActor(input.actor);
    this.requireCloudContentAuthority();
    const channel = this.requireChannelParticipant(input.channelId, actor.id);
    if (channel.archivedAt !== null) throw new Error("this room is archived");

    const snippet = parseSnippet({
      title: input.title,
      language: input.language,
      body: input.body,
    });
    if (snippet === null) throw new Error("snippet is empty or too long");

    const parent = input.threadParentId ? readMessage(this.ctx.storage, input.threadParentId) : null;
    if (input.threadParentId && parent === null) throw new Error("thread parent not found");
    const placement = resolveThreadPlacement(parent, channel.id);
    if (placement.kind === "invalid") throw new Error(placement.reason);
    const threadRootId = placement.kind === "reply" ? placement.threadRootId : null;

    const summary = snippetMessageBody(snippet);

    const outcome = await this.commitMutation(
      {
        scope: "message.snippet",
        idempotencyKey: input.idempotencyKey,
        requestHash: `${actor.id}|${channel.id}|${snippet.body.length}`,
        now: input.now,
      },
      () => {
        const messageId = crypto.randomUUID();
        const channelSequence = nextChannelSequence(this.ctx.storage, channel.id);
        insertMessage(this.ctx.storage, {
          id: messageId,
          channelId: channel.id,
          threadRootId,
          authorKind: "member",
          authorId: actor.id,
          authorDisplaySnapshot: actor.displayName,
          bodyMarkdown: summary,
          channelSequence,
          now: input.now,
        });
        insertSnippet(this.ctx.storage, { messageId, ...snippet });

        return {
          result: {
            messageId,
            channelId: channel.id,
            threadRootId,
            channelSequence,
            createdAt: input.now,
            replayed: false,
          },
          effects: {
            audit: {
              eventType: "message.snippet_created",
              outcome: "allowed" as const,
              requesterKind: "member" as const,
              requesterId: actor.id,
              subjectKind: "message",
              subjectId: messageId,
              // Counts and a language, never the snippet itself.
              metadata: {
                channel_id: channel.id,
                line_count: snippet.lineCount,
                language: snippet.language,
              },
            },
            replay: [
              {
                kind: "message.created",
                audience: [channel.id],
                payload: {
                  messageId,
                  channelId: channel.id,
                  threadRootId,
                  channelSequence,
                  authorId: actor.id,
                  createdAt: input.now,
                },
              },
            ],
            outbox: [
              {
                id: `message.${messageId}`,
                kind: "message_created",
                dedupeKey: `message:${messageId}`,
                payload: { messageId, channelId: channel.id, threadRootId },
              },
            ],
          } satisfies MutationEffects,
        };
      },
    );

    if (!outcome.replayed) {
      this.broadcastChannelEvent(channel, this.latestReplaySequence(), "message.created", {
        messageId: outcome.result.messageId,
        channelId: channel.id,
        threadRootId,
        channelSequence: outcome.result.channelSequence,
        authorId: actor.id,
        createdAt: input.now,
      });
    }
    return { ...outcome.result, replayed: outcome.replayed };
  }

  /**
   * Run what somebody typed into the composer.
   *
   * Parsing decided only what was meant. Everything a command does goes through
   * the same authorized method the button would have called, so a command can
   * never reach further than the person typing it already could.
   */
  async runComposerInput(input: {
    actor: Actor;
    idempotencyKey: string;
    channelId: string;
    raw: string;
    threadParentId?: string | null;
    now: number;
  }): Promise<ComposerOutcome> {
    const parsed = parseComposerInput(input.raw);

    switch (parsed.kind) {
      case "empty":
        return { kind: "rejected", reason: "There is nothing to send." };

      case "unknown_command":
        // Refused, not posted: somebody who mistypes a command did not mean to
        // say it out loud to the room.
        return {
          kind: "rejected",
          reason: `${parsed.typed} is not a command. Start a message with // to say it literally.`,
        };

      case "message": {
        const sent = await this.sendMessage({
          actor: input.actor,
          idempotencyKey: input.idempotencyKey,
          channelId: input.channelId,
          bodyMarkdown: parsed.bodyMarkdown,
          threadParentId: input.threadParentId ?? null,
          now: input.now,
        });
        return { kind: "sent", messageId: sent.messageId };
      }

      case "command": {
        const body = commandMessageBody(parsed.name, parsed.argument);
        if (body !== null) {
          const sent = await this.sendMessage({
            actor: input.actor,
            idempotencyKey: input.idempotencyKey,
            channelId: input.channelId,
            bodyMarkdown: body,
            threadParentId: input.threadParentId ?? null,
            now: input.now,
          });
          return { kind: "sent", messageId: sent.messageId };
        }

        switch (parsed.name) {
          case "join":
            await this.joinChannel({
              actor: input.actor,
              channelId: input.channelId,
              now: input.now,
            });
            return { kind: "acted", command: "join" };
          case "leave":
            await this.leaveChannel({
              actor: input.actor,
              channelId: input.channelId,
              now: input.now,
            });
            return { kind: "acted", command: "leave" };
          case "archive":
            await this.archiveChannel({
              actor: input.actor,
              channelId: input.channelId,
              now: input.now,
            });
            return { kind: "acted", command: "archive" };
          default:
            return { kind: "rejected", reason: "That command needs something to say." };
        }
      }
    }
  }

  /** Naming an emoji is workspace administration, not an ordinary member action. */
  async createCustomEmoji(input: {
    actor: Actor;
    name: string;
    aliasEmoji: string;
    now: number;
  }): Promise<{ created: boolean; name: string }> {
    const actor = this.authorizeActor(input.actor);
    if (actor.role !== "owner" && actor.role !== "admin") {
      throw new Error("only an admin may name a custom emoji");
    }
    const name = parseCustomEmojiName(input.name);
    if (name === null) throw new Error("invalid custom emoji name");
    const alias = parseReactionEmoji(input.aliasEmoji);
    if (alias === null || isEmojiToken(alias)) throw new Error("a custom emoji needs a real emoji");

    const outcome = await this.commitMutation({ scope: "emoji.create", now: input.now }, () => {
      const created = insertCustomEmoji(this.ctx.storage, name, alias, actor.id, input.now);
      if (!created) return { result: { created: false, name } };
      return {
        result: { created: true, name },
        effects: {
          audit: {
            eventType: "emoji.created",
            outcome: "allowed" as const,
            requesterKind: "member" as const,
            requesterId: actor.id,
            subjectKind: "custom_emoji",
            subjectId: name,
            metadata: {},
          },
        } satisfies MutationEffects,
      };
    });
    return outcome.result;
  }

  async deleteCustomEmoji(input: {
    actor: Actor;
    name: string;
    now: number;
  }): Promise<{ deleted: boolean }> {
    const actor = this.authorizeActor(input.actor);
    if (actor.role !== "owner" && actor.role !== "admin") {
      throw new Error("only an admin may remove a custom emoji");
    }
    const name = parseCustomEmojiName(input.name);
    if (name === null) throw new Error("invalid custom emoji name");

    const outcome = await this.commitMutation({ scope: "emoji.delete", now: input.now }, () => {
      const deleted = deleteCustomEmoji(this.ctx.storage, name);
      if (!deleted) return { result: { deleted: false } };
      return {
        result: { deleted: true },
        effects: {
          audit: {
            eventType: "emoji.deleted",
            outcome: "allowed" as const,
            requesterKind: "member" as const,
            requesterId: actor.id,
            subjectKind: "custom_emoji",
            subjectId: name,
            metadata: {},
          },
        } satisfies MutationEffects,
      };
    });
    return outcome.result;
  }

  /** Every member can read the workspace's emoji; only admins can change them. */
  listCustomEmoji(input: { actor: Actor }): { emoji: readonly CustomEmojiRow[] } {
    this.authorizeActor(input.actor);
    return { emoji: listCustomEmoji(this.ctx.storage) };
  }

  /* ------------------------------------------------------------------ */
  /* Agent identities, ownership, briefs and scope (A01)                 */
  /* ------------------------------------------------------------------ */

  /**
   * Create an agent.
   *
   * Anyone in the workspace may create one, and whoever does becomes its first
   * owner, because an agent nobody owns is an agent nobody is accountable for.
   * An agent is not a login: it has no account, no session and no membership
   * row, and it can never be an actor.
   */
  async createAgent(input: {
    actor: Actor;
    idempotencyKey: string;
    handle: string;
    displayName?: string | null;
    description?: string | null;
    prompt?: string | null;
    scopeMode?: "any" | "listed";
    scopeChannelIds?: readonly string[];
    now: number;
  }): Promise<{ agentId: string; handle: string; created: boolean }> {
    const actor = this.authorizeActor(input.actor);
    if (actor.role === "guest") throw new Error("this role cannot create agents");

    const handle = parseAgentHandle(input.handle);
    if (handle === null) throw new Error("an agent handle must be in the a. namespace");
    const displayName = parseChannelName(input.displayName, handle.slice(2));
    const description = parseChannelTopic(input.description);
    const prompt = parseAgentBrief(input.prompt);
    const scopeMode = input.scopeMode === "listed" ? "listed" : "any";
    const scopeChannelIds =
      scopeMode === "listed" ? this.resolveScopeChannels(input.scopeChannelIds ?? [], actor.id) : [];

    const outcome = await this.commitMutation(
      {
        scope: "agent.create",
        idempotencyKey: input.idempotencyKey,
        requestHash: `${actor.id}|${handle}`,
        now: input.now,
      },
      () => {
        if (readAgentByHandle(this.ctx.storage, handle) !== null) {
          throw new Error("that agent handle is already taken");
        }
        const agentId = crypto.randomUUID();
        this.ctx.storage.sql.exec(
          `INSERT INTO agents(id, handle, display_name, description, status, prompt, scope_mode,
                              created_by_member_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
          agentId,
          handle,
          displayName,
          description,
          prompt,
          scopeMode,
          actor.id,
          input.now,
          input.now,
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO agent_owners(agent_id, member_id, added_by_member_id, added_at) VALUES (?, ?, ?, ?)",
          agentId,
          actor.id,
          actor.id,
          input.now,
        );
        replaceAgentScope(this.ctx.storage, agentId, scopeChannelIds, input.now);

        return {
          result: { agentId, handle, created: true },
          effects: {
            audit: {
              eventType: "agent.created",
              outcome: "allowed" as const,
              requesterKind: "member" as const,
              requesterId: actor.id,
              subjectKind: "agent",
              subjectId: agentId,
              metadata: { agent_handle: handle, scope_mode: scopeMode, scope_size: scopeChannelIds.length },
            },
          } satisfies MutationEffects,
        };
      },
    );
    return { ...outcome.result, created: !outcome.replayed };
  }

  /** Owners are the agent's accountable humans, so only an owner may add one. */
  async addAgentOwner(input: {
    actor: Actor;
    agentId: string;
    memberId: string;
    now: number;
  }): Promise<{ added: boolean }> {
    const actor = this.authorizeActor(input.actor);
    const agent = this.requireOwnedAgent(input.agentId, actor.id);
    if (this.resolveActiveMemberIds([input.memberId]).length !== 1) {
      throw new Error("member is not active in this workspace");
    }

    const outcome = await this.commitMutation({ scope: "agent.add_owner", now: input.now }, () => {
      const result = this.ctx.storage.sql.exec(
        `INSERT INTO agent_owners(agent_id, member_id, added_by_member_id, added_at)
         VALUES (?, ?, ?, ?) ON CONFLICT(agent_id, member_id) DO NOTHING`,
        agent.id,
        input.memberId,
        actor.id,
        input.now,
      );
      if (result.rowsWritten === 0) return { result: { added: false } };
      return {
        result: { added: true },
        effects: this.agentEffects("agent.owner_added", agent, actor, {
          subject_member_id: input.memberId,
        }),
      };
    });
    return outcome.result;
  }

  /**
   * Remove an owner, unless they are the last one.
   *
   * The database enforces this too, but refusing here means the caller gets a
   * sentence rather than a constraint violation.
   */
  async removeAgentOwner(input: {
    actor: Actor;
    agentId: string;
    memberId: string;
    now: number;
  }): Promise<{ removed: boolean }> {
    const actor = this.authorizeActor(input.actor);
    const agent = this.requireOwnedAgent(input.agentId, actor.id);
    const owners = agentOwnerIds(this.ctx.storage, agent.id);
    if (!owners.includes(input.memberId)) return { removed: false };
    if (!mayRemoveOwner(owners, input.memberId)) {
      throw new Error("an agent must keep at least one owner");
    }

    const outcome = await this.commitMutation({ scope: "agent.remove_owner", now: input.now }, () => {
      this.ctx.storage.sql.exec(
        "DELETE FROM agent_owners WHERE agent_id = ? AND member_id = ?",
        agent.id,
        input.memberId,
      );
      return {
        result: { removed: true },
        effects: this.agentEffects("agent.owner_removed", agent, actor, {
          subject_member_id: input.memberId,
        }),
      };
    });
    return outcome.result;
  }

  /** The brief is tier two. Owners write it; the ceiling above it is not theirs. */
  async setAgentBrief(input: {
    actor: Actor;
    agentId: string;
    prompt: string | null;
    now: number;
  }): Promise<{ prompt: string | null }> {
    const actor = this.authorizeActor(input.actor);
    const agent = this.requireOwnedAgent(input.agentId, actor.id);
    const prompt = parseAgentBrief(input.prompt);

    const outcome = await this.commitMutation({ scope: "agent.set_brief", now: input.now }, () => {
      this.ctx.storage.sql.exec(
        "UPDATE agents SET prompt = ?, updated_at = ? WHERE id = ?",
        prompt,
        input.now,
        agent.id,
      );
      return {
        result: { prompt },
        // The brief's length is recorded; its text is not, because an audit
        // record outlives the thing it describes.
        effects: this.agentEffects("agent.brief_set", agent, actor, {
          brief_length: prompt?.length ?? 0,
        }),
      };
    });
    return outcome.result;
  }

  /**
   * Set the agent's scope.
   *
   * There is deliberately no path to this from an agent's own tools: a boundary
   * an agent can widen is advisory. Only an owner, acting as themselves, may
   * change it, and only to rooms that owner can actually reach.
   */
  async setAgentScope(input: {
    actor: Actor;
    agentId: string;
    mode: "any" | "listed";
    channelIds?: readonly string[];
    now: number;
  }): Promise<{ mode: "any" | "listed"; channelIds: readonly string[] }> {
    const actor = this.authorizeActor(input.actor);
    const agent = this.requireOwnedAgent(input.agentId, actor.id);
    const mode: "any" | "listed" = input.mode === "listed" ? "listed" : "any";
    const channelIds = mode === "listed" ? this.resolveScopeChannels(input.channelIds ?? [], actor.id) : [];

    const outcome = await this.commitMutation({ scope: "agent.set_scope", now: input.now }, () => {
      this.ctx.storage.sql.exec(
        "UPDATE agents SET scope_mode = ?, updated_at = ? WHERE id = ?",
        mode,
        input.now,
        agent.id,
      );
      replaceAgentScope(this.ctx.storage, agent.id, channelIds, input.now);
      return {
        result: { mode, channelIds },
        effects: this.agentEffects("agent.scope_set", agent, actor, {
          scope_mode: mode,
          scope_size: channelIds.length,
        }),
      };
    });
    return outcome.result;
  }

  async setAgentStatus(input: {
    actor: Actor;
    agentId: string;
    status: "active" | "paused" | "archived";
    now: number;
  }): Promise<{ status: string }> {
    const actor = this.authorizeActor(input.actor);
    const agent = this.requireOwnedAgent(input.agentId, actor.id);
    if (!["active", "paused", "archived"].includes(input.status)) throw new Error("unknown agent status");

    const outcome = await this.commitMutation({ scope: "agent.set_status", now: input.now }, () => {
      this.ctx.storage.sql.exec(
        "UPDATE agents SET status = ?, updated_at = ? WHERE id = ?",
        input.status,
        input.now,
        agent.id,
      );
      return {
        result: { status: input.status },
        effects: this.agentEffects("agent.status_set", agent, actor, { agent_status: input.status }),
      };
    });
    return outcome.result;
  }

  /** The directory: every live agent, its owners, its scope and its queue depth. */
  listAgents(input: { actor: Actor }): { agents: readonly AgentSummary[] } {
    const actor = this.authorizeActor(input.actor);
    const agents = listAgentRows(this.ctx.storage).map((agent) => {
      const ownerIds = agentOwnerIds(this.ctx.storage, agent.id);
      const scopeChannelIds = agentScopeChannelIds(this.ctx.storage, agent.id);
      return {
        id: agent.id,
        handle: agent.handle,
        displayName: agent.displayName,
        description: agent.description,
        status: agent.status,
        scopeMode: agent.scopeMode,
        // Only rooms this reader may see; an agent's scope is not a way to
        // learn that a private room exists.
        scopeChannelIds: scopeChannelIds.filter((channelId) => {
          const channel = readChannel(this.ctx.storage, channelId);
          return channel !== null && canSeeChannel(this.channelVisibility(channel, actor.id));
        }),
        scopeChannelCount: scopeChannelIds.length,
        ownerIds,
        isOwner: ownerIds.includes(actor.id),
        queueDepth: ownerIds.includes(actor.id) ? agentQueueDepth(this.ctx.storage, agent.id) : null,
      };
    });
    return { agents };
  }

  /**
   * The three tiers, as an owner sees them on the agent's page.
   *
   * The preamble is returned read-only. An owner who cannot see the ceiling will
   * eventually write a brief that argues with it and wonder why the agent
   * refuses.
   */
  readAgentBrief(input: { actor: Actor; agentId: string }): {
    tiers: readonly BriefTier[];
    preambleVersion: number;
  } {
    const actor = this.authorizeActor(input.actor);
    const agent = this.requireOwnedAgent(input.agentId, actor.id);
    const owners = agentOwnerIds(this.ctx.storage, agent.id).map(
      (memberId) =>
        this.ctx.storage.sql
          .exec<{ display_name: string }>("SELECT display_name FROM members WHERE id = ?", memberId)
          .toArray()[0]?.display_name ?? memberId,
    );
    return {
      tiers: assembleBrief({ agentBrief: agent.prompt, messageBody: "", ownerNames: owners }),
      preambleVersion: SECURITY_PREAMBLE_VERSION,
    };
  }

  /** An owner's view of what has been queued for their agent. */
  readAgentQueue(input: {
    actor: Actor;
    agentId: string;
    limit?: number;
    unreadOnly?: boolean;
  }): { items: readonly QueueItemRow[]; depth: number } {
    const actor = this.authorizeActor(input.actor);
    const agent = this.requireOwnedAgent(input.agentId, actor.id);
    return {
      items: listAgentQueue(
        this.ctx.storage,
        agent.id,
        clampHistoryLimit(input.limit),
        input.unreadOnly !== false,
      ),
      depth: agentQueueDepth(this.ctx.storage, agent.id),
    };
  }

  /**
   * Whether this agent may write into this room.
   *
   * The same rule the enqueue side uses. A01 wires the read side; the write
   * side calls this from the agent's own tools in A03.
   */
  agentMayPost(input: { agentId: string; channelId: string }): boolean {
    const agent = readAgent(this.ctx.storage, input.agentId);
    if (agent === null) return false;
    return agentMayPostIn({
      agentStatus: agent.status,
      scope: this.agentScope(agent),
      channelId: input.channelId,
    });
  }

  /* -- agent helpers ---------------------------------------------------- */

  private agentScope(agent: AgentRow): AgentScope {
    return agent.scopeMode === "any"
      ? { mode: "any" }
      : { mode: "listed", channelIds: agentScopeChannelIds(this.ctx.storage, agent.id) };
  }

  /**
   * An agent an owner may administer. Somebody else's agent is reported as
   * missing rather than forbidden, the same as a room they cannot see.
   */
  private requireOwnedAgent(agentId: string, memberId: string): AgentRow {
    const agent = readAgent(this.ctx.storage, agentId);
    if (agent === null) throw new Error("agent not found");
    if (!agentOwnerIds(this.ctx.storage, agent.id).includes(memberId)) {
      throw new Error("agent not found");
    }
    return agent;
  }

  /** An owner cannot scope an agent to a room they cannot reach themselves. */
  private resolveScopeChannels(channelIds: readonly string[], memberId: string): string[] {
    const unique = [...new Set(channelIds)];
    return unique.map((channelId) => this.requireVisibleChannel(channelId, memberId).id);
  }

  private agentEffects(
    eventType: string,
    agent: AgentRow,
    actor: ActiveMember,
    metadata: Record<string, string | number | boolean | null>,
  ): MutationEffects {
    return {
      audit: {
        eventType,
        outcome: "allowed",
        requesterKind: "member",
        requesterId: actor.id,
        subjectKind: "agent",
        subjectId: agent.id,
        metadata: { agent_handle: agent.handle, ...metadata },
      },
    };
  }

  /**
   * Turn the agent mentions on a message into queued work.
   *
   * Every brake lives in `decideEnqueue`, so this only supplies the facts and
   * records what came back. An out-of-scope or agent-authored mention leaves no
   * queue row at all: the message never reaches the agent's context and never
   * reaches an owner's view.
   */
  private enqueueAgentMentions(input: {
    messageId: string;
    channelId: string;
    authorKind: "member" | "agent" | "imported";
    authorId: string;
    bodyMarkdown: string;
    mentions: readonly { kind: string; handle: string; resolvedId: string | null }[];
    isHistorical: boolean;
    now: number;
  }): number {
    let enqueued = 0;
    const flags = flagSuspiciousContent(input.bodyMarkdown);

    for (const mention of input.mentions) {
      if (mention.kind !== "agent" || mention.resolvedId === null) continue;
      const agent = readAgent(this.ctx.storage, mention.resolvedId);
      if (agent === null) continue;

      const decision = decideEnqueue({
        authorKind: input.authorKind,
        authorId: input.authorId,
        agentId: agent.id,
        agentStatus: agent.status,
        scope: this.agentScope(agent),
        channelId: input.channelId,
        isHistorical: input.isHistorical,
      });
      if (!decision.enqueue) continue;

      if (
        enqueueAgentWork(this.ctx.storage, {
          id: crypto.randomUUID(),
          agentId: agent.id,
          messageId: input.messageId,
          channelId: input.channelId,
          flags,
          now: input.now,
        })
      ) {
        enqueued += 1;
      }
    }
    return enqueued;
  }

  /** Newest-first channel history, refused outright for a room the caller cannot see. */
  readChannelHistory(input: {
    actor: Actor;
    channelId: string;
    cursor?: string | null;
    limit?: number;
  }): MessagePage {
    const actor = this.authorizeActor(input.actor);
    const channel = this.requireVisibleChannel(input.channelId, actor.id);
    const page = listChannelHistory(this.ctx.storage, channel.id, input.cursor ?? null, input.limit);
    return { ...this.decorateMessages(page.messages, actor.id), nextCursor: page.nextCursor };
  }

  readThreadHistory(input: {
    actor: Actor;
    threadRootId: string;
    cursor?: string | null;
    limit?: number;
  }): MessagePage {
    const actor = this.authorizeActor(input.actor);
    const root = readMessage(this.ctx.storage, input.threadRootId);
    if (root === null || root.threadRootId !== null) throw new Error("thread not found");
    this.requireVisibleChannel(root.channelId, actor.id);
    const page = listThreadHistory(this.ctx.storage, root.id, input.cursor ?? null, input.limit);
    return { ...this.decorateMessages(page.messages, actor.id), nextCursor: page.nextCursor };
  }

  browseChannels(input: { actor: Actor; includeArchived?: boolean }): {
    channels: readonly (ChannelRow & { isMember: boolean; participantIds: readonly string[] })[];
  } {
    const actor = this.authorizeActor(input.actor);
    const channels = listVisibleChannels(
      this.ctx.storage,
      actor.id,
      input.includeArchived === true,
    ).map((channel) => ({
      ...channel,
      isMember: isChannelMember(this.ctx.storage, channel.id, actor.id),
      participantIds:
        channel.kind === "dm" || channel.kind === "group_dm"
          ? channelMemberIds(this.ctx.storage, channel.id)
          : [],
    }));
    return { channels };
  }

  /* ------------------------------------------------------------------ */
  /* MCP OAuth authorization and connections (A02)                       */
  /* ------------------------------------------------------------------ */

  /**
   * The tenant is the authorization server's storage for everything that names
   * one of its people: codes and connections. Only the client registry lives in
   * the control plane, because a client registers before a workspace is known.
   *
   * Protocol failures are returned rather than thrown. An OAuth endpoint has to
   * answer with a specific error code in a JSON body, and turning an exception
   * message back into a code at the route would be a second place where the
   * refusal is decided.
   */
  async beginOauthAuthorization(input: {
    actor: Actor;
    workspaceSlug: string;
    clientId: string;
    clientName: string | null;
    redirectUri: string;
    codeChallenge: string;
    scope: string;
    resource: string;
    now: number;
  }): Promise<OauthCodeResult> {
    const actor = this.authorizeActor(input.actor);
    const slug = this.requireWorkspaceSlug(input.workspaceSlug);
    if (workspaceSlugFromResource(input.resource) !== slug) {
      return {
        ok: false,
        error: "invalid_target",
        description: "resource does not name this workspace",
      };
    }

    const code = formatToken("code", slug, randomSecret());
    const codeHash = await hashSecret(code);
    const expiresAt = input.now + AUTHORIZATION_CODE_TTL_MS;

    const outcome = await this.commitMutation(
      { scope: "oauth.authorize", now: input.now },
      () => {
        // Codes are swept on the way past rather than by their own alarm: the
        // only time an expired code matters is when a new one is written.
        deleteExpiredOauthCodes(this.ctx.storage, input.now);
        insertOauthCode(this.ctx.storage, {
          codeHash,
          clientId: input.clientId,
          memberId: actor.id,
          redirectUri: input.redirectUri,
          codeChallenge: input.codeChallenge,
          resource: input.resource,
          scope: input.scope,
          now: input.now,
          expiresAt,
        });
        return {
          result: { code },
          effects: {
            audit: {
              eventType: "oauth.authorized",
              outcome: "allowed" as const,
              requesterKind: "member" as const,
              requesterId: actor.id,
              subjectKind: "oauth_client",
              subjectId: input.clientId,
              // The code never reaches the audit; what is worth keeping is who
              // agreed to what, not the credential it produced.
              metadata: { scope: input.scope, client_name: input.clientName ?? "" },
            },
          } satisfies MutationEffects,
        };
      },
    );
    return { ok: true, code: outcome.result.code };
  }

  async exchangeOauthCode(input: {
    workspaceSlug: string;
    code: string;
    clientId: string;
    clientName: string | null;
    redirectUri: unknown;
    codeVerifier: unknown;
    resource?: unknown;
    now: number;
  }): Promise<OauthGrantResult> {
    const slug = this.requireWorkspaceSlug(input.workspaceSlug);
    const parsed = parseTokenOfKind(input.code, "code");
    // A code that names another workspace is refused here rather than looked
    // up, so one tenant never probes another's storage even by absence.
    if (parsed === null || parsed.workspaceSlug !== slug) {
      return { ok: false, error: "invalid_grant", description: "unknown or already used code" };
    }

    const codeHash = await hashSecret(input.code);
    const stored = readOauthCode(this.ctx.storage, codeHash);
    const check = checkCodeExchange({
      stored:
        stored === null
          ? null
          : {
              clientId: stored.clientId,
              redirectUri: stored.redirectUri,
              codeChallenge: stored.codeChallenge,
              resource: stored.resource,
              expiresAt: stored.expiresAt,
              consumedAt: stored.consumedAt,
            },
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      resource: input.resource,
      now: input.now,
    });
    if (!check.ok) return { ok: false, error: check.error, description: check.description };
    if (stored === null) {
      return { ok: false, error: "invalid_grant", description: "unknown or already used code" };
    }
    if (!(await verifyCodeVerifier(input.codeVerifier, stored.codeChallenge))) {
      return { ok: false, error: "invalid_grant", description: "the PKCE verifier does not match" };
    }

    // Consent and redemption are separate moments. Somebody suspended in
    // between does not get a connection out of a code they were still entitled
    // to when they clicked.
    if (!this.memberIsActive(stored.memberId)) {
      return { ok: false, error: "invalid_grant", description: "this person is no longer a member" };
    }

    const accessToken = formatToken("at", slug, randomSecret());
    const refreshToken = formatToken("rt", slug, randomSecret());
    const accessTokenHash = await hashSecret(accessToken);
    const refreshTokenHash = await hashSecret(refreshToken);
    const connectionId = crypto.randomUUID();
    const accessExpiresAt = input.now + ACCESS_TOKEN_TTL_MS;

    const outcome = await this.commitMutation<{ spent: boolean }>({ scope: "oauth.exchange", now: input.now }, () => {
      // One conditional UPDATE decides the race: two clients redeeming the same
      // code cannot both win, because only one of them writes a row.
      if (!consumeOauthCode(this.ctx.storage, codeHash, input.now)) {
        return { result: { spent: false } };
      }
      insertOauthConnection(this.ctx.storage, {
        id: connectionId,
        clientId: stored.clientId,
        clientName: input.clientName,
        memberId: stored.memberId,
        resource: stored.resource,
        scope: stored.scope,
        accessTokenHash,
        refreshTokenHash,
        accessExpiresAt,
        now: input.now,
      });
      return {
        result: { spent: true },
        effects: {
          audit: {
            eventType: "oauth.connected",
            outcome: "allowed" as const,
            requesterKind: "member" as const,
            requesterId: stored.memberId,
            subjectKind: "oauth_connection",
            subjectId: connectionId,
            metadata: { client_id: stored.clientId, scope: stored.scope },
          },
        } satisfies MutationEffects,
      };
    });
    if (!outcome.result.spent) {
      return { ok: false, error: "invalid_grant", description: "unknown or already used code" };
    }

    return {
      ok: true,
      grant: {
        connectionId,
        accessToken,
        refreshToken,
        expiresInSeconds: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        scope: stored.scope,
      },
    };
  }

  async refreshOauthTokens(input: {
    workspaceSlug: string;
    refreshToken: string;
    clientId: string;
    now: number;
  }): Promise<OauthGrantResult> {
    const slug = this.requireWorkspaceSlug(input.workspaceSlug);
    const parsed = parseTokenOfKind(input.refreshToken, "rt");
    if (parsed === null || parsed.workspaceSlug !== slug) {
      return { ok: false, error: "invalid_grant", description: "unknown refresh token" };
    }

    const presentedHash = await hashSecret(input.refreshToken);
    const connection = readConnectionByRefreshHash(this.ctx.storage, presentedHash);
    const decision = decideRefresh({
      connection:
        connection === null
          ? null
          : {
              refreshTokenHash: connection.refreshTokenHash,
              previousRefreshTokenHash: connection.previousRefreshTokenHash,
              clientId: connection.clientId,
              revokedAt: connection.revokedAt,
            },
      presentedHash,
      clientId: input.clientId,
    });

    if (decision.kind === "replay" && connection !== null) {
      // The rotated token came back. A lost response and a stolen token look
      // the same from here, so the connection dies and the person reconnects.
      await this.commitMutation({ scope: "oauth.replay", now: input.now }, () => {
        revokeOauthConnectionRow(this.ctx.storage, connection.id, "refresh_token_replayed", input.now);
        return {
          result: undefined,
          effects: {
            audit: {
              eventType: "oauth.revoked",
              outcome: "denied" as const,
              requesterKind: "system" as const,
              requesterId: null,
              subjectKind: "oauth_connection",
              subjectId: connection.id,
              metadata: { reason: "refresh_token_replayed", client_id: connection.clientId },
            },
          } satisfies MutationEffects,
        };
      });
      return { ok: false, error: "invalid_grant", description: decision.description };
    }
    if (decision.kind !== "rotate" || connection === null) {
      const refusal = decision.kind === "refuse" ? decision : null;
      return {
        ok: false,
        error: refusal?.error ?? "invalid_grant",
        description: refusal?.description ?? "unknown refresh token",
      };
    }

    if (!this.memberIsActive(connection.memberId)) {
      return { ok: false, error: "invalid_grant", description: "this person is no longer a member" };
    }

    const accessToken = formatToken("at", slug, randomSecret());
    const refreshToken = formatToken("rt", slug, randomSecret());
    const rotated = rotateOauthConnection(this.ctx.storage, {
      connectionId: connection.id,
      accessTokenHash: await hashSecret(accessToken),
      refreshTokenHash: await hashSecret(refreshToken),
      previousRefreshTokenHash: presentedHash,
      accessExpiresAt: input.now + ACCESS_TOKEN_TTL_MS,
      now: input.now,
    });
    if (!rotated) {
      return { ok: false, error: "invalid_grant", description: "unknown refresh token" };
    }

    return {
      ok: true,
      grant: {
        connectionId: connection.id,
        accessToken,
        refreshToken,
        expiresInSeconds: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        scope: connection.scope,
      },
    };
  }

  /**
   * The resource server's whole authority decision.
   *
   * Membership is re-checked live on every call, so removing somebody from the
   * workspace cuts their connection off at its next request. There is nothing
   * to revoke and no cache to wait out.
   */
  async authenticateOauthToken(input: {
    accessToken: string;
    audience: string;
    now: number;
    requiredScope?: SupportedScope;
  }): Promise<OauthPrincipalResult> {
    const slug = this.workspaceSlug();
    const parsed = parseTokenOfKind(input.accessToken, "at");
    if (slug === null || parsed === null || parsed.workspaceSlug !== slug) {
      return { ok: false, error: "invalid_token", description: "unknown token" };
    }

    const connection = readConnectionByAccessHash(this.ctx.storage, await hashSecret(input.accessToken));
    const verdict = checkPresentedToken({
      token:
        connection === null
          ? null
          : {
              connectionId: connection.id,
              resource: connection.resource,
              accessExpiresAt: connection.accessExpiresAt,
              revokedAt: connection.revokedAt,
              scope: connection.scope,
            },
      audience: input.audience,
      now: input.now,
      requiredScope: input.requiredScope,
    });
    if (!verdict.ok) return { ok: false, error: verdict.error, description: verdict.description };
    if (connection === null) {
      return { ok: false, error: "invalid_token", description: "unknown token" };
    }

    const member = this.ctx.storage.sql
      .exec<{ id: string; handle: string; display_name: string; role: MemberProjection["role"]; status: string; authorization_epoch: number }>(
        "SELECT id, handle, display_name, role, status, authorization_epoch FROM members WHERE id = ?",
        connection.memberId,
      )
      .toArray()[0];
    if (member === undefined || member.status !== "active") {
      return {
        ok: false,
        error: "invalid_token",
        description: "this person is no longer a member of the workspace",
      };
    }

    touchOauthConnection(this.ctx.storage, connection.id, input.now);
    return {
      ok: true,
      principal: {
        connectionId: connection.id,
        memberId: member.id,
        handle: member.handle,
        displayName: member.display_name,
        role: member.role,
        authorizationEpoch: member.authorization_epoch,
        scope: connection.scope,
        clientId: connection.clientId,
        clientName: connection.clientName,
      },
    };
  }

  /**
   * RFC 7009. Presenting either half of a connection's pair revokes the
   * connection, and the answer is the same whether anything was revoked or not:
   * the endpoint is unauthenticated, so it must not report whether a token
   * existed.
   */
  async revokeOauthToken(input: { token: string; now: number }): Promise<{ revoked: boolean }> {
    const slug = this.workspaceSlug();
    const parsed = parseToken(input.token);
    if (slug === null || parsed === null || parsed.workspaceSlug !== slug || parsed.kind === "code") {
      return { revoked: false };
    }
    const hash = await hashSecret(input.token);
    const connection =
      parsed.kind === "rt"
        ? readConnectionByRefreshHash(this.ctx.storage, hash)
        : readConnectionByAccessHash(this.ctx.storage, hash);
    if (connection === null || connection.revokedAt !== null) return { revoked: false };

    await this.commitMutation({ scope: "oauth.revoke", now: input.now }, () => {
      revokeOauthConnectionRow(this.ctx.storage, connection.id, "token_revoked", input.now);
      return {
        result: undefined,
        effects: {
          audit: {
            eventType: "oauth.revoked",
            outcome: "allowed" as const,
            requesterKind: "member" as const,
            requesterId: connection.memberId,
            subjectKind: "oauth_connection",
            subjectId: connection.id,
            metadata: { reason: "token_revoked", client_id: connection.clientId },
          },
        } satisfies MutationEffects,
      };
    });
    return { revoked: true };
  }

  listOauthConnections(input: { actor: Actor }): { connections: readonly OauthConnectionSummary[] } {
    const actor = this.authorizeActor(input.actor);
    // A connection acts as one person, so it is theirs to see and theirs to
    // end. Nobody else's is listed here, not even an admin's view.
    return {
      connections: listOauthConnectionsForMember(this.ctx.storage, actor.id).map((row) => ({
        id: row.id,
        clientId: row.clientId,
        clientName: row.clientName,
        scope: row.scope,
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
        rotationCount: row.rotationCount,
      })),
    };
  }

  async revokeOauthConnection(input: {
    actor: Actor;
    connectionId: string;
    now: number;
  }): Promise<{ revoked: boolean }> {
    const actor = this.authorizeActor(input.actor);
    const connection = readOauthConnection(this.ctx.storage, input.connectionId);
    // Somebody else's connection is reported as missing, the same answer a
    // connection that never existed gets.
    if (connection === null || connection.memberId !== actor.id) {
      throw new Error("connection not found");
    }
    if (connection.revokedAt !== null) return { revoked: false };

    await this.commitMutation({ scope: "oauth.revoke", now: input.now }, () => {
      revokeOauthConnectionRow(this.ctx.storage, connection.id, "disconnected_by_owner", input.now);
      return {
        result: undefined,
        effects: {
          audit: {
            eventType: "oauth.revoked",
            outcome: "allowed" as const,
            requesterKind: "member" as const,
            requesterId: actor.id,
            subjectKind: "oauth_connection",
            subjectId: connection.id,
            metadata: { reason: "disconnected_by_owner", client_id: connection.clientId },
          },
        } satisfies MutationEffects,
      };
    });
    return { revoked: true };
  }

  private workspaceSlug(): string | null {
    return (
      this.ctx.storage.sql
        .exec<{ workspace_slug: string | null }>(
          "SELECT workspace_slug FROM workspace_config WHERE singleton = 1",
        )
        .toArray()[0]?.workspace_slug ?? null
    );
  }

  /**
   * Learn the workspace's slug once, then hold the caller to it.
   *
   * A workspace provisioned before this column existed has none yet, so the
   * first OAuth request teaches it. After that the slug is what routes every
   * token, and a caller naming a different one is refused rather than believed.
   */
  private requireWorkspaceSlug(claimed: string): string {
    const known = this.workspaceSlug();
    if (known === null) {
      this.ctx.storage.sql.exec(
        "UPDATE workspace_config SET workspace_slug = ? WHERE singleton = 1 AND workspace_slug IS NULL",
        claimed,
      );
      return claimed;
    }
    if (known !== claimed) throw new Error("workspace slug does not match this workspace");
    return known;
  }

  private memberIsActive(memberId: string): boolean {
    return (
      this.ctx.storage.sql
        .exec<{ status: string }>("SELECT status FROM members WHERE id = ?", memberId)
        .toArray()[0]?.status === "active"
    );
  }

  /* -- authorization helpers ------------------------------------------- */

  private authorizeActor(actor: Actor): ActiveMember {
    const schema = readWorkspaceSchema(this.ctx.storage);
    if (schema.status !== "ready") throw new Error("workspace is quarantined");
    if (!this.authorizeMember(actor.memberId, actor.authorizationEpoch)) {
      throw new Error("member is not authorized for this workspace");
    }
    const row = this.ctx.storage.sql
      .exec<{ id: string; handle: string; display_name: string; role: MemberProjection["role"] }>(
        "SELECT id, handle, display_name, role FROM members WHERE id = ?",
        actor.memberId,
      )
      .one();
    return { id: row.id, handle: row.handle, displayName: row.display_name, role: row.role };
  }

  /**
   * On a Solo workspace the designated host is the authority for content; the
   * relay must never hold a message body. Callers route through the encrypted
   * relay instead.
   */
  private requireCloudContentAuthority(): void {
    const config = this.ctx.storage.sql
      .exec<{ storage_mode: WorkspaceStorageMode }>(
        "SELECT storage_mode FROM workspace_config WHERE singleton = 1",
      )
      .toArray()[0];
    if (!config) throw new Error("workspace is not initialized");
    if (config.storage_mode !== "cloud") throw new Error("content_is_host_owned");
  }

  /**
   * A room the caller may not see is reported as missing rather than forbidden:
   * the two answers together would tell them a private room exists.
   */
  private requireVisibleChannel(channelId: string, memberId: string): ChannelRow {
    const channel = readChannel(this.ctx.storage, channelId);
    if (channel === null) throw new Error("channel not found");
    if (!canSeeChannel(this.channelVisibility(channel, memberId))) throw new Error("channel not found");
    return channel;
  }

  private requireChannelParticipant(channelId: string, memberId: string): ChannelRow {
    const channel = this.requireVisibleChannel(channelId, memberId);
    if (!isChannelMember(this.ctx.storage, channel.id, memberId)) {
      throw new Error("join this room before posting in it");
    }
    return channel;
  }

  private resolveActiveMemberIds(memberIds: readonly string[]): string[] {
    const unique = [...new Set(memberIds)];
    return unique.filter(
      (id) =>
        this.ctx.storage.sql
          .exec<{ present: number }>(
            "SELECT 1 AS present FROM members WHERE id = ? AND status = 'active'",
            id,
          )
          .toArray()[0]?.present === 1,
    );
  }

  private channelEffects(
    eventType: string,
    channelId: string,
    actor: ActiveMember,
    metadata: Record<string, string | number | boolean | null>,
  ): MutationEffects {
    return {
      audit: {
        eventType,
        outcome: "allowed",
        requesterKind: "member",
        requesterId: actor.id,
        subjectKind: "channel",
        subjectId: channelId,
        metadata,
      },
      replay: [{ kind: eventType, audience: [channelId], payload: { channelId, actorId: actor.id } }],
    };
  }

  /* ------------------------------------------------------------------ */
  /* Alarm scheduler, transactional outbox and audit baseline (F06)      */
  /* ------------------------------------------------------------------ */

  /**
   * The single durable transaction envelope every workspace mutation uses.
   * The caller's rows, the audit entry, the outbox records, the realtime replay
   * entries, the follow-up deadlines and the idempotency receipt all commit
   * together or not at all. Delivery happens afterwards, on the alarm.
   */
  async commitMutation<T>(
    input: {
      scope: string;
      idempotencyKey?: string | null;
      requestHash?: string;
      now: number;
      idempotencyTtlMs?: number;
    },
    apply: () => { result: T; effects?: MutationEffects },
  ): Promise<MutationOutcome<T>> {
    const schema = readWorkspaceSchema(this.ctx.storage);
    if (schema.status !== "ready") throw new Error("workspace is quarantined");

    const key = input.idempotencyKey ? parseIdempotencyKey(input.idempotencyKey) : null;
    if (input.idempotencyKey && key === null) throw new Error("invalid idempotency key");
    const requestHash = input.requestHash ?? "";

    const committed = this.ctx.storage.transactionSync(() => {
      if (key !== null) {
        const stored = this.ctx.storage.sql
          .exec<{ request_hash: string; response_json: string }>(
            "SELECT request_hash, response_json FROM idempotency_keys WHERE scope = ? AND key = ?",
            input.scope,
            key,
          )
          .toArray()[0];
        if (stored) {
          if (stored.request_hash !== requestHash) {
            throw new Error("idempotency key reuse with a different request");
          }
          return {
            replayed: true,
            result: (JSON.parse(stored.response_json) as { value: T }).value,
            audit: null,
            outboxQueued: 0,
          };
        }
      }

      const { result, effects } = apply();
      const audit = effects?.audit
        ? appendAuditEntry(this.ctx.storage, this.workspaceKey(), effects.audit, input.now)
        : null;
      const outboxQueued = enqueueOutbox(this.ctx.storage, effects?.outbox ?? [], input.now);
      appendReplayEvents(this.ctx.storage, effects?.replay ?? [], input.now);

      const due: DueWorkInput[] = [...(effects?.dueWork ?? [])];
      if (outboxQueued > 0) {
        due.push({ id: OUTBOX_FLUSH_WORK_ID, kind: "outbox_flush", dueAt: input.now });
      }
      scheduleDueWork(this.ctx.storage, due, input.now);

      if (key !== null) {
        this.ctx.storage.sql.exec(
          `INSERT INTO idempotency_keys(scope, key, request_hash, response_json, status_code, created_at, expires_at)
           VALUES (?, ?, ?, ?, 200, ?, ?)`,
          input.scope,
          key,
          requestHash,
          JSON.stringify({ value: result }),
          input.now,
          input.now + (input.idempotencyTtlMs ?? RETENTION_MS.idempotencyResult),
        );
      }

      return { replayed: false, result, audit, outboxQueued };
    });

    return { ...committed, alarmAt: await this.armAlarm() };
  }

  /** Add or advance multiplexed deadlines and re-point the object's one alarm. */
  async scheduleWork(items: readonly DueWorkInput[], now: number): Promise<{ alarmAt: number | null }> {
    this.ctx.storage.transactionSync(() => scheduleDueWork(this.ctx.storage, items, now));
    return { alarmAt: await this.armAlarm() };
  }

  async schedulerState(): Promise<SchedulerState> {
    const counts = this.ctx.storage.sql
      .exec<{ status: string; count: number }>(
        "SELECT status, COUNT(*) AS count FROM pending_events GROUP BY status",
      )
      .toArray();
    const auditSequence =
      this.ctx.storage.sql
        .exec<{ sequence: number | null }>("SELECT MAX(sequence) AS sequence FROM audit_events")
        .one().sequence ?? 0;
    return {
      alarmAt: await this.ctx.storage.getAlarm(),
      dueWork: listDueWork(this.ctx.storage),
      pendingOutbox: counts.find((row) => row.status === "pending")?.count ?? 0,
      deadOutbox: counts.find((row) => row.status === "dead")?.count ?? 0,
      auditSequence,
    };
  }

  async alarm(): Promise<void> {
    await this.runDueWork(Date.now());
  }

  /**
   * Drain everything due at `now`. A handler that throws backs its own item off
   * without stalling the other deadlines sharing this alarm.
   */
  async runDueWork(now: number, dispatcher?: OutboxDispatcher): Promise<DueWorkReport> {
    const claimed = claimDueWork(this.ctx.storage, now, DUE_WORK_BATCH_SIZE);
    const processed: string[] = [];
    const failed: { id: string; kind: string; error: string; retried: boolean }[] = [];
    let outbox = { attempted: 0, delivered: 0, retried: 0, dead: 0 };
    let retention: RetentionSweepReport | null = null;
    let anchor: AuditAnchor | null = null;
    let scheduledSends = { sent: 0, failed: 0 };

    for (const item of claimed) {
      try {
        switch (item.kind) {
          case "outbox_flush": {
            const report = await this.drainOutbox(now, dispatcher);
            outbox = {
              attempted: outbox.attempted + report.attempted,
              delivered: outbox.delivered + report.delivered,
              retried: outbox.retried + report.retried,
              dead: outbox.dead + report.dead,
            };
            break;
          }
          case "retention_sweep": {
            const swept = this.ctx.storage.transactionSync(() => sweepRetention(this.ctx.storage, now));
            // Several sweep deadlines can come due together; report their sum
            // rather than letting the last one hide the others.
            retention =
              retention === null
                ? swept
                : (Object.fromEntries(
                    Object.entries(swept).map(([key, value]) => [
                      key,
                      value + retention![key as keyof RetentionSweepReport],
                    ]),
                  ) as RetentionSweepReport);
            break;
          }
          case "scheduled_send": {
            const report = await this.deliverDueScheduledMessages(now);
            scheduledSends = {
              sent: scheduledSends.sent + report.sent,
              failed: scheduledSends.failed + report.failed,
            };
            break;
          }
          case "audit_anchor":
            anchor = this.ctx.storage.transactionSync(() =>
              writeAuditAnchor(this.ctx.storage, this.workspaceKey(), now),
            );
            break;
          default:
            throw new Error(`no handler for due work kind ${item.kind}`);
        }
        this.ctx.storage.transactionSync(() => completeDueWork(this.ctx.storage, item, now));
        processed.push(item.id);
      } catch (error) {
        const deferred = this.ctx.storage.transactionSync(() =>
          deferDueWork(this.ctx.storage, item, now, error),
        );
        failed.push({
          id: item.id,
          kind: item.kind,
          error: redactedError(error),
          retried: deferred.retried,
        });
      }
    }

    const stillPending = nextPendingOutboxAt(this.ctx.storage);
    if (stillPending !== null) {
      this.ctx.storage.transactionSync(() =>
        scheduleDueWork(
          this.ctx.storage,
          [{ id: OUTBOX_FLUSH_WORK_ID, kind: "outbox_flush", dueAt: stillPending }],
          now,
        ),
      );
    }

    return {
      now,
      processed,
      failed,
      outbox,
      retention,
      anchor,
      scheduledSends,
      alarmAt: await this.armAlarm(),
    };
  }

  /**
   * Attempt delivery for every outbox entry whose backoff has elapsed. Delivery
   * is at-least-once: `dedupeKey` travels with the payload so a consumer can
   * discard a duplicate produced by a lost acknowledgement.
   */
  async drainOutbox(
    now: number,
    dispatcher: OutboxDispatcher = (entry) => this.dispatchToQueue(entry),
    limit = OUTBOX_BATCH_SIZE,
  ): Promise<{ attempted: number; delivered: number; retried: number; dead: number }> {
    const batch = claimOutboxBatch(this.ctx.storage, now, limit);
    let delivered = 0;
    let retried = 0;
    let dead = 0;

    for (const entry of batch) {
      let outcome: OutboxOutcome;
      try {
        outcome = await dispatcher(entry);
      } catch (error) {
        outcome = { status: "retry", error: redactedError(error) };
      }
      const settled = this.ctx.storage.transactionSync(() =>
        settleOutbox(this.ctx.storage, entry, outcome, now),
      );
      if (settled === "delivered") delivered += 1;
      else if (settled === "dead") dead += 1;
      else retried += 1;
    }

    return { attempted: batch.length, delivered, retried, dead };
  }

  recordAuditEvent(entry: AuditEntryInput, now: number): AppendedAudit {
    const schema = readWorkspaceSchema(this.ctx.storage);
    if (schema.status !== "ready") throw new Error("workspace is quarantined");
    return this.ctx.storage.transactionSync(() =>
      appendAuditEntry(this.ctx.storage, this.workspaceKey(), entry, now),
    );
  }

  auditTrail(fromSequence = 0, limit = 200): StoredAuditEntry[] {
    return readAuditEntries(this.ctx.storage, this.workspaceKey(), fromSequence, limit);
  }

  verifyAuditTrail(): AuditChainVerification {
    return verifyStoredAuditChain(this.ctx.storage, this.workspaceKey());
  }

  /** Stable per-tenant binding for the audit chain: the object's own id. */
  private workspaceKey(): string {
    return this.ctx.id.toString();
  }

  /** Point the object's one alarm at the earliest deadline it owns. */
  private async armAlarm(): Promise<number | null> {
    const due = nextDueAt(this.ctx.storage);
    const current = await this.ctx.storage.getAlarm();
    if (due === null) {
      if (current !== null) await this.ctx.storage.deleteAlarm();
      return null;
    }
    // A deadline recovered from storage can be in the past; the runtime still
    // refuses a non-positive alarm time.
    const target = Math.max(due, 1);
    if (current !== target) await this.ctx.storage.setAlarm(target);
    return target;
  }

  private async dispatchToQueue(entry: OutboxEntry): Promise<OutboxOutcome> {
    const queue = this.env.EVENTS;
    if (!queue) return { status: "retry", error: "events queue binding is unavailable" };
    try {
      await queue.send({
        workspace: this.workspaceKey(),
        id: entry.id,
        kind: entry.kind,
        dedupeKey: entry.dedupeKey,
        attempt: entry.attempts + 1,
        payload: entry.payload,
      });
      return { status: "delivered" };
    } catch (error) {
      return { status: "retry", error: redactedError(error) };
    }
  }

  private readStagedSnapshot(importId: string): SoloContentSnapshot {
    const header = this.ctx.storage.sql
      .exec<{ workspace_id: string; host_epoch: number; snapshot_checksum: string }>(
        "SELECT workspace_id, host_epoch, snapshot_checksum FROM solo_upgrade_imports WHERE import_id = ?",
        importId,
      )
      .one();
    const records = <T>(table: string): T[] =>
      this.ctx.storage.sql
        .exec<{ record_json: string }>(`SELECT record_json FROM ${table} WHERE import_id = ? ORDER BY record_id`, importId)
        .toArray()
        .map(({ record_json }) => JSON.parse(record_json) as T);
    return {
      version: 1,
      workspaceId: header.workspace_id,
      hostEpoch: header.host_epoch,
      channels: records("solo_upgrade_channels"),
      messages: records("solo_upgrade_messages"),
      attachments: records("solo_upgrade_attachments"),
      checksum: header.snapshot_checksum,
    };
  }

  private workspaceConfig(): {
    storage_mode: WorkspaceStorageMode;
    designated_host_device_id: string | null;
    host_epoch: number;
    host_lease_expires_at: number | null;
    relay_sequence_to_host: number;
    relay_sequence_from_host: number;
    routing_epoch: number;
  } {
    return this.ctx.storage.sql
      .exec<{
        storage_mode: WorkspaceStorageMode;
        designated_host_device_id: string | null;
        host_epoch: number;
        host_lease_expires_at: number | null;
        relay_sequence_to_host: number;
        relay_sequence_from_host: number;
        routing_epoch: number;
      }>(
        `SELECT storage_mode, designated_host_device_id, host_epoch,
                host_lease_expires_at, relay_sequence_to_host, relay_sequence_from_host, routing_epoch
         FROM workspace_config WHERE singleton = 1`,
      )
      .one();
  }
}
