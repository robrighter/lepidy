export type WorkspaceMigration = Readonly<{
  version: number;
  name: string;
  statements: readonly string[];
}>;

export type WorkspaceSchemaState = {
  version: number;
  status: "ready" | "quarantined";
  error: string | null;
};

const bootstrapSql = `
  CREATE TABLE IF NOT EXISTS _schema (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL CHECK (version >= 0),
    status TEXT NOT NULL CHECK (status IN ('ready', 'quarantined')),
    error TEXT,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS _migration_failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_version INTEGER NOT NULL,
    target_version INTEGER NOT NULL,
    migration_name TEXT NOT NULL,
    error TEXT NOT NULL,
    failed_at INTEGER NOT NULL
  ) STRICT;
  INSERT OR IGNORE INTO _schema(singleton, version, status, error, updated_at)
  VALUES (1, 0, 'ready', NULL, CAST(unixepoch('subsec') * 1000 AS INTEGER));
`;

export const WORKSPACE_MIGRATIONS: readonly WorkspaceMigration[] = [
  {
    version: 1,
    name: "workspace principals and chat",
    statements: [
      `CREATE TABLE members (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL UNIQUE,
        handle TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        avatar_url TEXT,
        role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'guest')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending', 'active', 'suspended', 'removed')),
        authorization_epoch INTEGER NOT NULL DEFAULT 1 CHECK (authorization_epoch > 0),
        control_version INTEGER NOT NULL CHECK (control_version > 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT`,
      `CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        handle TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (handle LIKE 'a.%'),
        display_name TEXT NOT NULL,
        avatar_url TEXT,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
        created_by_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT`,
      `CREATE TABLE agent_owners (
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        added_by_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (agent_id, member_id)
      ) STRICT`,
      `CREATE INDEX agent_owners_member_idx ON agent_owners(member_id)`,
      `CREATE TABLE groups (
        id TEXT PRIMARY KEY,
        handle TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (handle LIKE 'g.%'),
        display_name TEXT NOT NULL,
        created_by_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT`,
      `CREATE TABLE group_members (
        group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (group_id, member_id)
      ) STRICT`,
      `CREATE TABLE channels (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('public', 'private', 'dm', 'group_dm')),
        slug TEXT UNIQUE COLLATE NOCASE,
        name TEXT,
        created_by_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
        archived_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT`,
      `CREATE TABLE channel_members (
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (channel_id, member_id)
      ) STRICT`,
      `CREATE INDEX channel_members_member_idx ON channel_members(member_id, channel_id)`,
      `CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        thread_root_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
        author_kind TEXT NOT NULL CHECK (author_kind IN ('member', 'agent', 'imported')),
        author_id TEXT NOT NULL,
        author_display_snapshot TEXT NOT NULL,
        body_markdown TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        edited_at INTEGER,
        deleted_at INTEGER
      ) STRICT`,
      `CREATE INDEX messages_channel_time_idx ON messages(channel_id, created_at, id)`,
      `CREATE INDEX messages_thread_time_idx ON messages(thread_root_id, created_at, id) WHERE thread_root_id IS NOT NULL`,
    ],
  },
  {
    version: 2,
    name: "durable operation infrastructure",
    statements: [
      `CREATE TABLE idempotency_keys (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response_json TEXT NOT NULL CHECK (json_valid(response_json)),
        status_code INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (scope, key)
      ) STRICT`,
      `CREATE INDEX idempotency_expiry_idx ON idempotency_keys(expires_at)`,
      `CREATE TABLE replay_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        audience_json TEXT NOT NULL CHECK (json_valid(audience_json)),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        created_at INTEGER NOT NULL
      ) STRICT`,
      `CREATE TABLE pending_events (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        last_error TEXT
      ) STRICT`,
      `CREATE INDEX pending_events_due_idx ON pending_events(completed_at, next_attempt_at)`,
      `CREATE TABLE applied_control_operations (
        operation_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        applied_at INTEGER NOT NULL,
        UNIQUE (kind, aggregate_id, version)
      ) STRICT`,
    ],
  },
  {
    version: 3,
    name: "workspace membership safeguards",
    statements: [
      `CREATE TRIGGER members_reserve_principal_handles_insert
       BEFORE INSERT ON members
       WHEN lower(NEW.handle) LIKE 'a.%' OR lower(NEW.handle) LIKE 'g.%'
       BEGIN SELECT RAISE(ABORT, 'human handle uses a reserved namespace'); END`,
      `CREATE TRIGGER members_reserve_principal_handles_update
       BEFORE UPDATE OF handle ON members
       WHEN lower(NEW.handle) LIKE 'a.%' OR lower(NEW.handle) LIKE 'g.%'
       BEGIN SELECT RAISE(ABORT, 'human handle uses a reserved namespace'); END`,
      `CREATE TRIGGER members_keep_last_owner_update
       BEFORE UPDATE OF role, status ON members
       WHEN OLD.role = 'owner' AND OLD.status = 'active'
         AND (NEW.role <> 'owner' OR NEW.status <> 'active')
         AND NOT EXISTS (
           SELECT 1 FROM members other
           WHERE other.id <> OLD.id AND other.role = 'owner' AND other.status = 'active'
         )
       BEGIN SELECT RAISE(ABORT, 'workspace requires an active owner'); END`,
      `CREATE TRIGGER members_keep_last_owner_delete
       BEFORE DELETE ON members
       WHEN OLD.role = 'owner' AND OLD.status = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM members other
           WHERE other.id <> OLD.id AND other.role = 'owner' AND other.status = 'active'
         )
       BEGIN SELECT RAISE(ABORT, 'workspace requires an active owner'); END`,
    ],
  },
  {
    version: 4,
    name: "plan-specific workspace authority",
    statements: [
      `CREATE TABLE workspace_config (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        storage_mode TEXT NOT NULL CHECK (storage_mode IN ('local_host', 'cloud')),
        host_epoch INTEGER NOT NULL DEFAULT 0 CHECK (host_epoch >= 0),
        routing_epoch INTEGER NOT NULL DEFAULT 1 CHECK (routing_epoch > 0),
        initialized_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT`,
    ],
  },
  {
    version: 5,
    name: "solo host lease and relay metadata",
    statements: [
      `ALTER TABLE workspace_config ADD COLUMN designated_host_device_id TEXT`,
      `ALTER TABLE workspace_config ADD COLUMN host_lease_expires_at INTEGER`,
      `ALTER TABLE workspace_config ADD COLUMN relay_sequence_to_host INTEGER NOT NULL DEFAULT 0 CHECK (relay_sequence_to_host >= 0)`,
      `ALTER TABLE workspace_config ADD COLUMN relay_sequence_from_host INTEGER NOT NULL DEFAULT 0 CHECK (relay_sequence_from_host >= 0)`,
    ],
  },
  {
    version: 6,
    name: "resumable solo content upgrade",
    statements: [
      `CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL,
        media_type TEXT NOT NULL,
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        object_key TEXT NOT NULL,
        sha256 TEXT NOT NULL
      ) STRICT`,
      `CREATE TABLE solo_upgrade_imports (
        import_id TEXT PRIMARY KEY,
        snapshot_checksum TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        host_epoch INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('staged', 'complete')),
        started_at INTEGER NOT NULL,
        completed_at INTEGER
      ) STRICT`,
      `CREATE TABLE solo_upgrade_channels (
        import_id TEXT NOT NULL REFERENCES solo_upgrade_imports(import_id) ON DELETE CASCADE,
        record_json TEXT NOT NULL CHECK (json_valid(record_json)),
        record_id TEXT NOT NULL,
        PRIMARY KEY (import_id, record_id)
      ) STRICT`,
      `CREATE TABLE solo_upgrade_messages (
        import_id TEXT NOT NULL REFERENCES solo_upgrade_imports(import_id) ON DELETE CASCADE,
        record_json TEXT NOT NULL CHECK (json_valid(record_json)),
        record_id TEXT NOT NULL,
        PRIMARY KEY (import_id, record_id)
      ) STRICT`,
      `CREATE TABLE solo_upgrade_attachments (
        import_id TEXT NOT NULL REFERENCES solo_upgrade_imports(import_id) ON DELETE CASCADE,
        record_json TEXT NOT NULL CHECK (json_valid(record_json)),
        record_id TEXT NOT NULL,
        PRIMARY KEY (import_id, record_id)
      ) STRICT`,
    ],
  },
  {
    version: 7,
    name: "alarm scheduler, outbox and audit baseline",
    statements: [
      `CREATE TABLE due_work (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        due_at INTEGER NOT NULL,
        interval_ms INTEGER CHECK (interval_ms IS NULL OR interval_ms > 0),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT`,
      `CREATE INDEX due_work_due_idx ON due_work(due_at, id)`,
      `CREATE TABLE due_work_failures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        error TEXT NOT NULL,
        failed_at INTEGER NOT NULL
      ) STRICT`,
      `CREATE INDEX due_work_failures_time_idx ON due_work_failures(failed_at)`,
      `ALTER TABLE pending_events ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'
         CHECK (status IN ('pending', 'delivered', 'dead'))`,
      `ALTER TABLE pending_events ADD COLUMN dedupe_key TEXT`,
      `ALTER TABLE pending_events ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0)`,
      `UPDATE pending_events SET status = 'delivered' WHERE completed_at IS NOT NULL`,
      `CREATE UNIQUE INDEX pending_events_dedupe_idx ON pending_events(dedupe_key) WHERE dedupe_key IS NOT NULL`,
      `CREATE INDEX pending_events_pending_idx ON pending_events(status, next_attempt_at)`,
      `CREATE INDEX pending_events_retention_idx ON pending_events(status, completed_at)`,
      `CREATE INDEX replay_events_time_idx ON replay_events(created_at)`,
      `CREATE TABLE audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('allowed', 'denied', 'failed')),
        requester_kind TEXT NOT NULL CHECK (requester_kind IN ('member', 'agent', 'runner', 'system')),
        requester_id TEXT,
        operating_owner_id TEXT,
        approver_id TEXT,
        subject_kind TEXT,
        subject_id TEXT,
        metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
        recorded_at INTEGER NOT NULL,
        previous_hash TEXT NOT NULL,
        entry_hash TEXT NOT NULL UNIQUE
      ) STRICT`,
      `CREATE INDEX audit_events_time_idx ON audit_events(recorded_at, sequence)`,
      `CREATE TABLE audit_anchors (
        day TEXT PRIMARY KEY,
        first_sequence INTEGER NOT NULL,
        last_sequence INTEGER NOT NULL,
        entry_count INTEGER NOT NULL CHECK (entry_count >= 0),
        chain_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT`,
      `CREATE TABLE audit_retention (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        purged_through_sequence INTEGER NOT NULL DEFAULT 0 CHECK (purged_through_sequence >= 0),
        purged_through_hash TEXT NOT NULL DEFAULT '',
        release_through_sequence INTEGER NOT NULL DEFAULT 0 CHECK (release_through_sequence >= 0),
        updated_at INTEGER NOT NULL
      ) STRICT`,
      `INSERT INTO audit_retention(singleton, updated_at)
       VALUES (1, CAST(unixepoch('subsec') * 1000 AS INTEGER))`,
      `CREATE TRIGGER audit_events_append_only_update
       BEFORE UPDATE ON audit_events
       BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END`,
      `CREATE TRIGGER audit_events_retention_only_delete
       BEFORE DELETE ON audit_events
       WHEN OLD.sequence > (SELECT release_through_sequence FROM audit_retention WHERE singleton = 1)
       BEGIN SELECT RAISE(ABORT, 'audit log deletion requires an expired retention release'); END`,
    ],
  },
  {
    version: 8,
    name: "rooms, direct messages and thread aggregates",
    statements: [
      // One conversation per set of people, however it is opened.
      `ALTER TABLE channels ADD COLUMN dm_key TEXT`,
      `CREATE UNIQUE INDEX channels_dm_key_idx ON channels(dm_key) WHERE dm_key IS NOT NULL`,
      `ALTER TABLE channels ADD COLUMN topic TEXT`,
      // Aggregates only. A Solo relay may hold activity counters but never content.
      `ALTER TABLE channels ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0)`,
      `ALTER TABLE channels ADD COLUMN last_activity_at INTEGER`,
      `ALTER TABLE messages ADD COLUMN reply_count INTEGER NOT NULL DEFAULT 0 CHECK (reply_count >= 0)`,
      `ALTER TABLE messages ADD COLUMN last_reply_at INTEGER`,
      `CREATE INDEX channels_kind_idx ON channels(kind, archived_at)`,
      `CREATE TABLE channel_message_sequence (
        channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
        next_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_sequence > 0)
      ) STRICT`,
      `ALTER TABLE messages ADD COLUMN channel_sequence INTEGER`,
      `CREATE UNIQUE INDEX messages_channel_sequence_idx
         ON messages(channel_id, channel_sequence) WHERE channel_sequence IS NOT NULL`,
    ],
  },
  {
    version: 9,
    name: "read cursors and thread sequences",
    statements: [
      `ALTER TABLE messages ADD COLUMN thread_sequence INTEGER`,
      `CREATE UNIQUE INDEX messages_thread_sequence_idx
         ON messages(thread_root_id, thread_sequence) WHERE thread_sequence IS NOT NULL`,
      // A cursor per member per room, so reading on one device reads on all.
      `CREATE TABLE channel_read_state (
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        last_read_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_read_sequence >= 0),
        last_read_at INTEGER NOT NULL,
        PRIMARY KEY (channel_id, member_id)
      ) STRICT`,
      `CREATE INDEX channel_read_state_member_idx ON channel_read_state(member_id)`,
      `CREATE TABLE thread_read_state (
        thread_root_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        last_read_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_read_sequence >= 0),
        last_read_at INTEGER NOT NULL,
        PRIMARY KEY (thread_root_id, member_id)
      ) STRICT`,
      `CREATE INDEX thread_read_state_member_idx ON thread_read_state(member_id)`,
    ],
  },
  {
    version: 10,
    name: "reactions, mentions and edit history",
    statements: [
      `CREATE TABLE message_reactions (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        emoji TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (message_id, member_id, emoji)
      ) STRICT`,
      `CREATE INDEX message_reactions_message_idx ON message_reactions(message_id, emoji)`,
      // Addressing is recorded per message so a later reader sees what a
      // message meant when it was written, not what the handles mean now.
      `CREATE TABLE message_mentions (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('member', 'agent', 'group', 'channel', 'here')),
        handle TEXT NOT NULL,
        resolved_id TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (message_id, kind, handle)
      ) STRICT`,
      `CREATE INDEX message_mentions_resolved_idx ON message_mentions(kind, resolved_id)`,
      `ALTER TABLE messages ADD COLUMN edit_count INTEGER NOT NULL DEFAULT 0 CHECK (edit_count >= 0)`,
      `ALTER TABLE messages ADD COLUMN deleted_by_member_id TEXT`,
    ],
  },
  {
    version: 11,
    name: "pins, saved items and forwarding",
    statements: [
      // A pin belongs to the room, so it is visible to exactly whoever the room is.
      `CREATE TABLE channel_pins (
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        pinned_by_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        pinned_at INTEGER NOT NULL,
        PRIMARY KEY (channel_id, message_id)
      ) STRICT`,
      `CREATE INDEX channel_pins_channel_idx ON channel_pins(channel_id, pinned_at)`,
      // A saved item belongs to one person and is never visible to anybody else.
      // It is only a pointer: whether it can still be read is decided at read
      // time against the room, not at save time.
      `CREATE TABLE saved_items (
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        saved_at INTEGER NOT NULL,
        PRIMARY KEY (member_id, message_id)
      ) STRICT`,
      `CREATE INDEX saved_items_member_idx ON saved_items(member_id, saved_at)`,
      // A forward is a new message carrying a copy, not a window into another
      // room: the copy was made by somebody who could read the original.
      `ALTER TABLE messages ADD COLUMN forwarded_from_message_id TEXT`,
      `ALTER TABLE messages ADD COLUMN forwarded_from_channel_id TEXT`,
      `ALTER TABLE messages ADD COLUMN forwarded_author_snapshot TEXT`,
      `CREATE INDEX messages_forwarded_from_idx
         ON messages(forwarded_from_message_id) WHERE forwarded_from_message_id IS NOT NULL`,
    ],
  },
] as const;

function errorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.slice(0, 500);
}

export function prepareWorkspaceSchema(storage: DurableObjectStorage): void {
  storage.transactionSync(() => storage.sql.exec(bootstrapSql));
}

export function readWorkspaceSchema(storage: DurableObjectStorage): WorkspaceSchemaState {
  const row = storage.sql
    .exec<{ version: number; status: "ready" | "quarantined"; error: string | null }>(
      "SELECT version, status, error FROM _schema WHERE singleton = 1",
    )
    .one();

  return row;
}

export function migrateWorkspaceSchema(
  storage: DurableObjectStorage,
  migrations: readonly WorkspaceMigration[] = WORKSPACE_MIGRATIONS,
): WorkspaceSchemaState {
  prepareWorkspaceSchema(storage);
  let state = readWorkspaceSchema(storage);
  if (state.status === "quarantined") return state;

  for (const migration of migrations) {
    if (migration.version <= state.version) continue;

    if (migration.version !== state.version + 1) {
      const message = `migration sequence skips from ${state.version} to ${migration.version}`;
      quarantine(storage, state.version, migration, message);
      return readWorkspaceSchema(storage);
    }

    try {
      storage.transactionSync(() => {
        const current = readWorkspaceSchema(storage);
        if (current.version !== state.version || current.status !== "ready") {
          throw new Error(`schema changed while migrating from ${state.version}`);
        }
        for (const statement of migration.statements) storage.sql.exec(statement);
        const updated = storage.sql.exec(
          `UPDATE _schema
           SET version = ?, status = 'ready', error = NULL, updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
           WHERE singleton = 1 AND version = ? AND status = 'ready'`,
          migration.version,
          state.version,
        );
        if (updated.rowsWritten !== 1) throw new Error("schema version compare-and-set failed");
      });
    } catch (error) {
      quarantine(storage, state.version, migration, errorMessage(error));
      return readWorkspaceSchema(storage);
    }

    state = readWorkspaceSchema(storage);
  }

  return state;
}

function quarantine(
  storage: DurableObjectStorage,
  fromVersion: number,
  migration: WorkspaceMigration,
  error: string,
): void {
  storage.transactionSync(() => {
    storage.sql.exec(
      `INSERT INTO _migration_failures(from_version, target_version, migration_name, error, failed_at)
       VALUES (?, ?, ?, ?, CAST(unixepoch('subsec') * 1000 AS INTEGER))`,
      fromVersion,
      migration.version,
      migration.name,
      error,
    );
    storage.sql.exec(
      `UPDATE _schema SET status = 'quarantined', error = ?, updated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
       WHERE singleton = 1`,
      error,
    );
  });
}
