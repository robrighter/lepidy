import { DurableObject } from "cloudflare:workers";

import {
  migrateWorkspaceSchema,
  readWorkspaceSchema,
  type WorkspaceSchemaState,
} from "./workspace-migrations";
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

export class Workspace extends DurableObject<CloudflareEnv> {
  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);

    ctx.blockConcurrencyWhile(async () => {
      migrateWorkspaceSchema(ctx.storage);
    });
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
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [memberId]);
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

  applyMembership(member: MemberProjection): { applied: boolean; version: number } {
    const schema = readWorkspaceSchema(this.ctx.storage);
    if (schema.status !== "ready") throw new Error("workspace is quarantined");

    const result = this.ctx.storage.transactionSync(() => {
      const replay = this.ctx.storage.sql
        .exec<{ version: number }>(
          "SELECT version FROM applied_control_operations WHERE operation_id = ?",
          member.operationId,
        )
        .toArray()[0];
      if (replay) return { applied: false, version: replay.version };

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
      return { applied: true, version: member.version };
    });
    if (result.applied && (member.authorizationEpoch > 1 || member.status !== "active")) {
      this.closeMemberSockets(member.memberId);
    }
    return result;
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
