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
  directMessageIdentity,
  parseChannelName,
  parseChannelSlug,
  parseChannelTopic,
  parseMessageBody,
  resolveThreadPlacement,
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
import {
  addChannelMembers,
  archiveChannel,
  channelMemberIds,
  insertChannel,
  insertMessage,
  isChannelMember,
  listChannelHistory,
  listThreadHistory,
  listVisibleChannels,
  nextChannelSequence,
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
  writeChannelCursor,
  writeThreadCursor,
  type ChannelRow,
  type MessagePage,
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
        `INSERT INTO workspace_config(singleton, storage_mode, host_epoch, routing_epoch, initialized_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           host_epoch = excluded.host_epoch,
           routing_epoch = excluded.routing_epoch,
           updated_at = excluded.updated_at`,
        input.storageMode,
        input.hostEpoch,
        input.routingEpoch,
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

  /** Newest-first channel history, refused outright for a room the caller cannot see. */
  readChannelHistory(input: {
    actor: Actor;
    channelId: string;
    cursor?: string | null;
    limit?: number;
  }): MessagePage {
    const actor = this.authorizeActor(input.actor);
    const channel = this.requireVisibleChannel(input.channelId, actor.id);
    return listChannelHistory(this.ctx.storage, channel.id, input.cursor ?? null, input.limit);
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
    return listThreadHistory(this.ctx.storage, root.id, input.cursor ?? null, input.limit);
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

    return { now, processed, failed, outbox, retention, anchor, alarmAt: await this.armAlarm() };
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
