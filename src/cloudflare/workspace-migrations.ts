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
