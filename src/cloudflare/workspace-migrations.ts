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
  {
    version: 12,
    name: "synced drafts and scheduled messages",
    statements: [
      // One draft per member per composing surface. The empty string is the
      // room itself; a thread root id is a thread's own draft.
      `CREATE TABLE message_drafts (
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        thread_root_id TEXT NOT NULL DEFAULT '',
        body_markdown TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (member_id, channel_id, thread_root_id)
      ) STRICT`,
      `CREATE INDEX message_drafts_member_idx ON message_drafts(member_id, updated_at)`,
      `CREATE TABLE scheduled_messages (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        thread_root_id TEXT,
        body_markdown TEXT NOT NULL,
        send_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('scheduled', 'sent', 'cancelled', 'failed')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        sent_message_id TEXT,
        failure_reason TEXT
      ) STRICT`,
      `CREATE INDEX scheduled_messages_due_idx ON scheduled_messages(status, send_at)`,
      `CREATE INDEX scheduled_messages_member_idx ON scheduled_messages(member_id, send_at)`,
    ],
  },
  {
    version: 13,
    name: "snippets and custom emoji",
    statements: [
      // A snippet travels beside its message rather than inside it, so history
      // stays readable without loading every long body with it.
      `CREATE TABLE message_snippets (
        message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        language TEXT,
        body TEXT NOT NULL,
        line_count INTEGER NOT NULL CHECK (line_count > 0)
      ) STRICT`,
      // One name, one meaning, workspace-wide. The name is the primary key so a
      // second definition cannot change what an old message meant.
      `CREATE TABLE custom_emoji (
        name TEXT PRIMARY KEY,
        alias_emoji TEXT NOT NULL,
        created_by_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL
      ) STRICT`,
    ],
  },
  {
    version: 14,
    name: "agent briefs, scope and queue",
    statements: [
      // The standing brief. NULL is the ordinary state: an agent without one
      // still gets the preamble, which is the tier that matters.
      `ALTER TABLE agents ADD COLUMN prompt TEXT`,
      `ALTER TABLE agents ADD COLUMN scope_mode TEXT NOT NULL DEFAULT 'any'
         CHECK (scope_mode IN ('any', 'listed'))`,
      // An empty list allows nothing, so a scoped agent with no rooms is paused
      // rather than unlimited.
      `CREATE TABLE agent_scope_channels (
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (agent_id, channel_id)
      ) STRICT`,
      `CREATE TABLE agent_queue (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL,
        enqueued_at INTEGER NOT NULL,
        read_at INTEGER,
        flags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(flags_json)),
        UNIQUE (agent_id, message_id)
      ) STRICT`,
      // Keyset pagination over (enqueued_at, id): a queue is written to while it
      // is read, and an offset walk silently skips rows.
      `CREATE INDEX agent_queue_unread_idx ON agent_queue(agent_id, read_at, enqueued_at, id)`,
      // An agent nobody owns is an agent nobody is accountable for.
      `CREATE TRIGGER agent_owners_keep_last_delete
       BEFORE DELETE ON agent_owners
       WHEN NOT EXISTS (
         SELECT 1 FROM agent_owners other
         WHERE other.agent_id = OLD.agent_id AND other.member_id <> OLD.member_id
       )
       BEGIN SELECT RAISE(ABORT, 'an agent must keep at least one owner'); END`,
    ],
  },
  {
    version: 15,
    name: "MCP OAuth codes and connections",
    statements: [
      // The object learns its own slug so it can refuse an audience that names
      // somebody else. Without it the tenant would be trusting the caller's
      // word about which workspace a token is for, which is exactly the
      // property the audience check exists to establish.
      `ALTER TABLE workspace_config ADD COLUMN workspace_slug TEXT`,
      // Authorization codes live in the tenant, not the control plane, because
      // a code names a member of this workspace and nothing outside it needs to
      // read one. They are kept after they are spent so a replay is answered
      // from a row that says "already used" rather than from silence.
      `CREATE TABLE oauth_codes (
        code_hash TEXT PRIMARY KEY CHECK (length(code_hash) = 64),
        client_id TEXT NOT NULL,
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        resource TEXT NOT NULL,
        scope TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER,
        CHECK (expires_at > created_at)
      ) STRICT`,
      `CREATE INDEX oauth_codes_expiry_idx ON oauth_codes(expires_at)`,
      // One row per connection, not per token: the token pair is the
      // connection's current state, so rotating it is an update and there is no
      // history of live credentials to leak. The previous refresh hash is kept
      // for exactly one generation, which is what makes a replay detectable.
      `CREATE TABLE oauth_connections (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        client_name TEXT,
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        resource TEXT NOT NULL,
        scope TEXT NOT NULL,
        access_token_hash TEXT NOT NULL UNIQUE CHECK (length(access_token_hash) = 64),
        refresh_token_hash TEXT NOT NULL UNIQUE CHECK (length(refresh_token_hash) = 64),
        previous_refresh_token_hash TEXT,
        access_expires_at INTEGER NOT NULL,
        rotation_count INTEGER NOT NULL DEFAULT 0 CHECK (rotation_count >= 0),
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER,
        revoked_reason TEXT
      ) STRICT`,
      `CREATE INDEX oauth_connections_member_idx ON oauth_connections(member_id, revoked_at, created_at)`,
      `CREATE INDEX oauth_connections_refresh_idx ON oauth_connections(previous_refresh_token_hash)`,
    ],
  },
  {
    version: 16,
    name: "Agent queue execution and MCP attribution",
    statements: [
      // Human display state (`read_at`) stays independent from execution state.
      // A person may clear an inbox without completing work, and a runner may
      // complete work without deciding what its owner has read.
      `ALTER TABLE agent_queue ADD COLUMN execution_state TEXT NOT NULL DEFAULT 'pending'
         CHECK (execution_state IN ('pending', 'claimed', 'completed', 'needs_attention', 'dead_letter', 'cancelled'))`,
      `ALTER TABLE agent_queue ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0)`,
      `ALTER TABLE agent_queue ADD COLUMN not_before INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE agent_queue ADD COLUMN lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0)`,
      `ALTER TABLE agent_queue ADD COLUMN lease_connection_id TEXT REFERENCES oauth_connections(id) ON DELETE SET NULL`,
      `ALTER TABLE agent_queue ADD COLUMN lease_session_id TEXT`,
      `ALTER TABLE agent_queue ADD COLUMN lease_token_hash TEXT`,
      `ALTER TABLE agent_queue ADD COLUMN lease_expires_at INTEGER`,
      `ALTER TABLE agent_queue ADD COLUMN execution_started_at INTEGER`,
      `ALTER TABLE agent_queue ADD COLUMN claim_id TEXT`,
      `ALTER TABLE agent_queue ADD COLUMN completion_id TEXT`,
      `ALTER TABLE agent_queue ADD COLUMN completion_digest TEXT`,
      `ALTER TABLE agent_queue ADD COLUMN completion_result_json TEXT CHECK (completion_result_json IS NULL OR json_valid(completion_result_json))`,
      `ALTER TABLE agent_queue ADD COLUMN completed_at INTEGER`,
      `CREATE INDEX agent_queue_claim_idx
         ON agent_queue(agent_id, execution_state, not_before, enqueued_at, id)`,
      // Durable, server-authored provenance for every message written through
      // MCP. It is separate from the body so a caller cannot forge or erase it.
      `CREATE TABLE mcp_message_attribution (
        message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        connection_id TEXT NOT NULL REFERENCES oauth_connections(id) ON DELETE RESTRICT,
        operating_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
        agent_id TEXT REFERENCES agents(id) ON DELETE RESTRICT,
        client_id TEXT NOT NULL,
        client_name_snapshot TEXT,
        created_at INTEGER NOT NULL
      ) STRICT`,
      // Strongly consistent per-(connection, agent) write brake. The empty
      // agent id is the connection's human chat-write bucket.
      `CREATE TABLE mcp_write_limits (
        connection_id TEXT NOT NULL REFERENCES oauth_connections(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        window_started_at INTEGER NOT NULL,
        write_count INTEGER NOT NULL CHECK (write_count >= 0),
        PRIMARY KEY (connection_id, agent_id)
      ) STRICT`,
    ],
  },
  {
    version: 17,
    name: "Delegations and scoped agent sessions",
    statements: [
      `CREATE TABLE agent_delegations (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        owner_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        owner_authorization_epoch INTEGER NOT NULL,
        channel_ids_json TEXT CHECK (channel_ids_json IS NULL OR json_valid(channel_ids_json)),
        credential_ids_json TEXT NOT NULL CHECK (json_valid(credential_ids_json)),
        delivery_modes_json TEXT NOT NULL CHECK (json_valid(delivery_modes_json)),
        project_ids_json TEXT NOT NULL CHECK (json_valid(project_ids_json)),
        spend_cap_daily_cents INTEGER CHECK (spend_cap_daily_cents IS NULL OR spend_cap_daily_cents >= 0),
        spend_cap_monthly_cents INTEGER CHECK (spend_cap_monthly_cents IS NULL OR spend_cap_monthly_cents >= 0),
        rate_limit_per_hour INTEGER CHECK (rate_limit_per_hour IS NULL OR rate_limit_per_hour > 0),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
        revoked_at INTEGER,
        revoked_reason TEXT
      ) STRICT`,
      `CREATE INDEX agent_delegations_live_idx
         ON agent_delegations(agent_id, owner_member_id, expires_at, revoked_at)`,
      `CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY,
        delegation_id TEXT NOT NULL REFERENCES agent_delegations(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        owner_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL,
        runner_epoch INTEGER NOT NULL CHECK (runner_epoch >= 0),
        preset_revision INTEGER NOT NULL CHECK (preset_revision >= 0),
        capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
        token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
        token_expires_at INTEGER NOT NULL,
        hard_expires_at INTEGER NOT NULL,
        rotation_count INTEGER NOT NULL DEFAULT 0 CHECK (rotation_count >= 0),
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER,
        revoked_reason TEXT,
        CHECK (token_expires_at <= hard_expires_at),
        CHECK (hard_expires_at > created_at)
      ) STRICT`,
      `CREATE UNIQUE INDEX agent_sessions_one_live_agent_idx
         ON agent_sessions(agent_id) WHERE revoked_at IS NULL`,
      `CREATE INDEX agent_sessions_delegation_idx ON agent_sessions(delegation_id, revoked_at)`,
      // A session lease is mutually exclusive with A03's attended OAuth lease.
      // SQLite cannot add the cross-column CHECK to the historical table, so
      // every writer enforces the XOR and integration tests inspect the row.
      `ALTER TABLE agent_queue ADD COLUMN lease_agent_session_id TEXT REFERENCES agent_sessions(id) ON DELETE SET NULL`,
      `CREATE TABLE agent_session_message_attribution (
        message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE RESTRICT,
        delegation_id TEXT NOT NULL REFERENCES agent_delegations(id) ON DELETE RESTRICT,
        operating_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
        device_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT`,
      `CREATE TABLE agent_session_write_limits (
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        window_started_at INTEGER NOT NULL,
        write_count INTEGER NOT NULL CHECK (write_count >= 0),
        PRIMARY KEY (session_id, agent_id)
      ) STRICT`,
    ],
  },
  {
    version: 18,
    name: "Encrypted credential vault",
    statements: [
      `CREATE TABLE vault_settings (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        agent_access_on INTEGER NOT NULL DEFAULT 1 CHECK (agent_access_on IN (0, 1)),
        access_epoch INTEGER NOT NULL DEFAULT 1 CHECK (access_epoch > 0),
        updated_by_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
        updated_at INTEGER NOT NULL
      ) STRICT`,
      `INSERT INTO vault_settings(singleton, agent_access_on, access_epoch, updated_at)
       VALUES (1, 1, 1, CAST(unixepoch('subsec') * 1000 AS INTEGER))`,
      `CREATE TABLE vault_credentials (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        description TEXT NOT NULL,
        env_var TEXT,
        tags_json TEXT NOT NULL CHECK (json_valid(tags_json)),
        commands_json TEXT NOT NULL CHECK (json_valid(commands_json)),
        proxy_hosts_json TEXT NOT NULL CHECK (json_valid(proxy_hosts_json)),
        cipher_suite TEXT NOT NULL CHECK (cipher_suite = 'AES-256-GCM'),
        aad_version INTEGER NOT NULL CHECK (aad_version = 1),
        ciphertext TEXT NOT NULL,
        iv TEXT NOT NULL,
        key_epoch INTEGER NOT NULL CHECK (key_epoch > 0),
        version INTEGER NOT NULL CHECK (version > 0),
        policy_epoch INTEGER NOT NULL CHECK (policy_epoch > 0),
        mode TEXT NOT NULL CHECK (mode IN ('ask', 'auto', 'never')),
        allowed_deliveries_json TEXT NOT NULL CHECK (json_valid(allowed_deliveries_json)),
        project_ids_json TEXT NOT NULL CHECK (json_valid(project_ids_json)),
        grant_ttl_ms INTEGER CHECK (grant_ttl_ms IS NULL OR (grant_ttl_ms > 0 AND grant_ttl_ms <= 28800000)),
        available_until INTEGER,
        max_uses_per_hour INTEGER CHECK (max_uses_per_hour IS NULL OR max_uses_per_hour > 0),
        high_risk INTEGER NOT NULL DEFAULT 0 CHECK (high_risk IN (0, 1)),
        created_by_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_accessed_at INTEGER,
        access_count INTEGER NOT NULL DEFAULT 0 CHECK (access_count >= 0)
      ) STRICT`,
      `CREATE TABLE vault_credential_key_wraps (
        credential_id TEXT NOT NULL REFERENCES vault_credentials(id) ON DELETE CASCADE,
        credential_version INTEGER NOT NULL CHECK (credential_version > 0),
        custodian_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        recipient_key_epoch INTEGER NOT NULL CHECK (recipient_key_epoch > 0),
        wrap_suite TEXT NOT NULL,
        ephemeral_public_key TEXT NOT NULL,
        iv TEXT NOT NULL,
        wrapped_dek TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (credential_id, credential_version, custodian_member_id)
      ) STRICT`,
      `CREATE TABLE vault_credential_acl (
        credential_id TEXT NOT NULL REFERENCES vault_credentials(id) ON DELETE CASCADE,
        subject_type TEXT NOT NULL CHECK (subject_type IN ('member', 'group', 'agent', 'channel')),
        subject_id TEXT NOT NULL,
        verb TEXT NOT NULL CHECK (verb IN ('use', 'reveal', 'manage')),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (credential_id, subject_type, subject_id, verb)
      ) STRICT`,
      `CREATE INDEX vault_credential_acl_subject_idx
         ON vault_credential_acl(subject_type, subject_id, credential_id)`,
      `CREATE TABLE vault_grants (
        id TEXT PRIMARY KEY,
        credential_id TEXT NOT NULL REFERENCES vault_credentials(id) ON DELETE CASCADE,
        credential_version INTEGER NOT NULL CHECK (credential_version > 0),
        policy_epoch INTEGER NOT NULL CHECK (policy_epoch > 0),
        access_epoch INTEGER NOT NULL CHECK (access_epoch > 0),
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
        delegation_id TEXT REFERENCES agent_delegations(id) ON DELETE CASCADE,
        delivery TEXT NOT NULL CHECK (delivery IN ('inject', 'file', 'device_proxy', 'reveal')),
        origin_channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE,
        origin_message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
        expires_at INTEGER,
        remaining_uses INTEGER CHECK (remaining_uses IS NULL OR remaining_uses >= 0),
        approved_by_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER,
        revoked_reason TEXT,
        CHECK ((agent_id IS NULL AND delegation_id IS NULL) OR (agent_id IS NOT NULL AND delegation_id IS NOT NULL))
      ) STRICT`,
      `CREATE INDEX vault_grants_exact_live_idx ON vault_grants(
         credential_id, credential_version, policy_epoch, access_epoch,
         member_id, device_id, project_id, agent_id, delegation_id, delivery,
         origin_channel_id, revoked_at, expires_at
       )`,
      `CREATE TABLE vault_usage_events (
        id TEXT PRIMARY KEY,
        credential_id TEXT NOT NULL REFERENCES vault_credentials(id) ON DELETE CASCADE,
        grant_id TEXT REFERENCES vault_grants(id) ON DELETE SET NULL,
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        delegation_id TEXT REFERENCES agent_delegations(id) ON DELETE SET NULL,
        delivery TEXT NOT NULL CHECK (delivery IN ('inject', 'file', 'device_proxy', 'reveal')),
        used_at INTEGER NOT NULL
      ) STRICT`,
      `CREATE INDEX vault_usage_events_window_idx
         ON vault_usage_events(credential_id, used_at)`,
      `CREATE TABLE vault_credential_deletions (
        credential_id TEXT PRIMARY KEY,
        deletion_epoch INTEGER NOT NULL CHECK (deletion_epoch > 0),
        deleted_by_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
        deleted_at INTEGER NOT NULL
      ) STRICT`,
    ],
  },
  {
    version: 19,
    name: "Vault custodian wrapping keys",
    statements: [
      // The public half of a member's vault wrapping key, published by the
      // native client that generated it. The private half never leaves that
      // client, so this table is what lets one custodian's client seal a DEK
      // for another without either key passing through Lepidy.
      `CREATE TABLE vault_member_keys (
        member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
        key_epoch INTEGER NOT NULL CHECK (key_epoch > 0),
        wrap_suite TEXT NOT NULL,
        public_key TEXT NOT NULL,
        device_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT`,
    ],
  },
  {
    version: 20,
    name: "Conversational approvals and kill-switch scopes",
    statements: [
      // An approval holds the question, never the answer's material: credential
      // ids, versions and policy epochs, the requester tuple, the origin and the
      // reason. No ciphertext, no wrap, no key.
      `CREATE TABLE vault_approvals (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('pending', 'allowed', 'denied', 'expired')),
        requester_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
        delegation_id TEXT REFERENCES agent_delegations(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        origin_channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        origin_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        delivery TEXT NOT NULL CHECK (delivery IN ('inject', 'file', 'device_proxy', 'reveal')),
        reason TEXT NOT NULL,
        access_epoch INTEGER NOT NULL CHECK (access_epoch > 0),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        decided_at INTEGER,
        decided_by_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
        decision_digest TEXT,
        CHECK ((agent_id IS NULL AND delegation_id IS NULL) OR (agent_id IS NOT NULL AND delegation_id IS NOT NULL))
      ) STRICT`,
      `CREATE INDEX vault_approvals_pending_idx ON vault_approvals(status, expires_at)`,
      // Each credential in a batch keeps its own decision: one card, one
      // gesture, but an approver may allow one and deny another.
      `CREATE TABLE vault_approval_items (
        approval_id TEXT NOT NULL REFERENCES vault_approvals(id) ON DELETE CASCADE,
        credential_id TEXT NOT NULL REFERENCES vault_credentials(id) ON DELETE CASCADE,
        credential_version INTEGER NOT NULL CHECK (credential_version > 0),
        policy_epoch INTEGER NOT NULL CHECK (policy_epoch > 0),
        outcome TEXT CHECK (outcome IN ('allowed', 'denied')),
        grant_window TEXT CHECK (grant_window IN ('once', 'fifteen_minutes', 'session')),
        grant_id TEXT REFERENCES vault_grants(id) ON DELETE SET NULL,
        PRIMARY KEY (approval_id, credential_id)
      ) STRICT`,
      // Who may answer, and where their copy of the card was posted, so the
      // answer can be written back into the same conversation.
      `CREATE TABLE vault_approval_approvers (
        approval_id TEXT NOT NULL REFERENCES vault_approvals(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        card_channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
        card_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        PRIMARY KEY (approval_id, member_id)
      ) STRICT`,
      `CREATE INDEX vault_approval_approvers_member_idx ON vault_approval_approvers(member_id, approval_id)`,
      // The per-credential and per-agent kill switches. Separate from policy
      // mode and from agent status on purpose: turning a switch off is a
      // protective action that must never require a step-up, and cutting an
      // agent off from credentials must not require silencing it everywhere.
      `ALTER TABLE vault_credentials ADD COLUMN frozen_at INTEGER`,
      `ALTER TABLE vault_credentials ADD COLUMN frozen_by_member_id TEXT REFERENCES members(id) ON DELETE SET NULL`,
      `ALTER TABLE agents ADD COLUMN vault_access_off_at INTEGER`,
      `ALTER TABLE agents ADD COLUMN vault_access_off_by_member_id TEXT REFERENCES members(id) ON DELETE SET NULL`,
    ],
  },
  {
    version: 21,
    name: "Captured credentials, kinds and rotation dates",
    statements: [
      // A structured credential is one record that expands into several
      // variables. The field *names* live here so a page can say what it
      // expands into; the values are inside the ciphertext and nothing in this
      // schema can reach them.
      `ALTER TABLE vault_credentials ADD COLUMN kind TEXT NOT NULL DEFAULT 'opaque' CHECK (kind IN ('opaque', 'structured'))`,
      `ALTER TABLE vault_credentials ADD COLUMN fields_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(fields_json))`,
      `ALTER TABLE vault_credentials ADD COLUMN rotate_at INTEGER`,
      // Why a credential is switched off, so "a human pulled the switch" and
      // "captured, nobody has confirmed it yet" do not read the same.
      `ALTER TABLE vault_credentials ADD COLUMN frozen_reason TEXT CHECK (frozen_reason IN ('switched_off', 'awaiting_capture_review'))`,
      // What produced a captured value: the program's name, never its
      // arguments. Arguments are where a path or a secret would be, and the
      // authorization contract keeps local commands out of cloud state.
      `ALTER TABLE vault_credentials ADD COLUMN captured_from TEXT`,
    ],
  },
  {
    version: 22,
    name: "Designated runners and pending wakes",
    statements: [
      // Which device serves which agents. A runner is designated per agent, so
      // two machines cannot both decide they are the one that answers.
      `CREATE TABLE runner_devices (
        device_id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        runner_epoch INTEGER NOT NULL CHECK (runner_epoch > 0),
        preset_revision INTEGER NOT NULL CHECK (preset_revision > 0),
        registered_at INTEGER NOT NULL,
        last_seen_at INTEGER
      ) STRICT`,
      `CREATE TABLE runner_agents (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL REFERENCES runner_devices(device_id) ON DELETE CASCADE,
        assigned_at INTEGER NOT NULL
      ) STRICT`,
      `CREATE INDEX runner_agents_device_idx ON runner_agents(device_id)`,
      // A wake is persisted in the same transaction as the work it is about, so
      // a wake can never be lost by a delivery that failed. It carries an agent
      // id and nothing else: no executable, no arguments, no path, no prompt.
      `CREATE TABLE runner_wakes (
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        enqueued_at INTEGER NOT NULL,
        delivered_at INTEGER,
        PRIMARY KEY (agent_id, device_id)
      ) STRICT`,
      `CREATE INDEX runner_wakes_pending_idx ON runner_wakes(device_id, delivered_at)`,
    ],
  },
  {
    version: 23,
    name: "Runner preset identity per agent",
    statements: [
      // Which local preset this device runs for this agent, as an opaque name
      // the device itself registered. The cloud may name a preset the machine
      // already holds; it may never describe one, and a name the machine does
      // not recognise is refused locally. That is the whole of the remote
      // trigger's authority over what runs.
      `ALTER TABLE runner_agents ADD COLUMN preset_id TEXT NOT NULL DEFAULT ''`,
    ],
  },
  {
    version: 24,
    name: "Device-mediated vault proxy requests",
    statements: [
      `CREATE TABLE vault_proxy_requests (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL,
        requester_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        delegation_id TEXT NOT NULL REFERENCES agent_delegations(id) ON DELETE CASCADE,
        release_device_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        origin_channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        origin_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        credential_id TEXT NOT NULL REFERENCES vault_credentials(id) ON DELETE CASCADE,
        credential_version INTEGER NOT NULL,
        policy_epoch INTEGER NOT NULL,
        access_epoch INTEGER NOT NULL,
        relay_suite TEXT NOT NULL,
        relay_ephemeral_public_key TEXT NOT NULL,
        relay_iv TEXT NOT NULL,
        relay_ciphertext TEXT NOT NULL,
        response_key TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'refused', 'uncertain')),
        delivered_at INTEGER,
        completed_at INTEGER,
        result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT`,
      `CREATE INDEX vault_proxy_requests_device_state_idx
       ON vault_proxy_requests(release_device_id, state, created_at)`,
      `CREATE INDEX vault_proxy_requests_expiry_idx
       ON vault_proxy_requests(state, expires_at)`,
    ],
  },
  {
    version: 25,
    name: "Cloud and custom agent runtimes",
    statements: [
      `CREATE TABLE agent_runtime_configs (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('local', 'claude_cloud', 'custom')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disconnected')),
        organization_id TEXT,
        provider_workspace_id TEXT,
        provider_agent_id TEXT,
        provider_environment_id TEXT,
        provider_deployment_id TEXT,
        wif_issuer TEXT,
        wif_audience TEXT,
        wif_subject TEXT,
        service_account_id TEXT,
        federation_rule_id TEXT,
        callback_url TEXT,
        secret_envelope TEXT,
        budget_cents INTEGER CHECK (budget_cents IS NULL OR budget_cents > 0),
        resource_proved_at INTEGER,
        webhook_proved_at INTEGER,
        wif_failures INTEGER NOT NULL DEFAULT 0 CHECK (wif_failures >= 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK ((kind = 'claude_cloud' AND budget_cents IS NOT NULL) OR kind <> 'claude_cloud')
      ) STRICT`,
      `CREATE INDEX agent_runtime_provider_idx ON agent_runtime_configs(organization_id, provider_workspace_id)`,
      `CREATE TABLE runtime_runs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('mention', 'scheduled', 'manual')),
        origin_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        delegation_id TEXT REFERENCES agent_delegations(id) ON DELETE SET NULL,
        provider_session_id TEXT,
        provider_deployment_run_id TEXT,
        resolved_agent_version TEXT,
        budget_cents INTEGER,
        state TEXT NOT NULL CHECK (state IN ('queued', 'starting', 'running', 'idle', 'succeeded', 'failed', 'terminated')),
        failure_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT`,
      `CREATE INDEX runtime_runs_open_idx ON runtime_runs(agent_id, state, updated_at)`,
      `CREATE TABLE anthropic_webhook_receipts (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        organization_id TEXT NOT NULL,
        provider_workspace_id TEXT NOT NULL,
        received_at INTEGER NOT NULL
      ) STRICT`,
      `CREATE TABLE custom_runtime_deliveries (
        delivery_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        queue_depth INTEGER NOT NULL CHECK (queue_depth >= 0),
        state TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'dead')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      ) STRICT`,
    ],
  },
  {
    version: 26,
    name: "Runtime configuration surface",
    statements: [
      // `connected` becomes a stored kind rather than the absence of a row.
      // An agent whose runtime nobody ever chose and an agent somebody
      // deliberately set to "an owner's own MCP client" are different states,
      // and the screen has to be able to tell them apart. SQLite cannot widen
      // a CHECK in place, so the table is rebuilt; the columns are unchanged
      // and still carry no launch configuration.
      `CREATE TABLE agent_runtime_configs_v26 (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('connected', 'local', 'claude_cloud', 'custom')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disconnected')),
        organization_id TEXT,
        provider_workspace_id TEXT,
        provider_agent_id TEXT,
        provider_environment_id TEXT,
        provider_deployment_id TEXT,
        wif_issuer TEXT,
        wif_audience TEXT,
        wif_subject TEXT,
        service_account_id TEXT,
        federation_rule_id TEXT,
        callback_url TEXT,
        secret_envelope TEXT,
        budget_cents INTEGER CHECK (budget_cents IS NULL OR budget_cents > 0),
        resource_proved_at INTEGER,
        webhook_proved_at INTEGER,
        wif_failures INTEGER NOT NULL DEFAULT 0 CHECK (wif_failures >= 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK ((kind = 'claude_cloud' AND budget_cents IS NOT NULL) OR kind <> 'claude_cloud')
      ) STRICT`,
      `INSERT INTO agent_runtime_configs_v26 SELECT * FROM agent_runtime_configs`,
      `DROP TABLE agent_runtime_configs`,
      `ALTER TABLE agent_runtime_configs_v26 RENAME TO agent_runtime_configs`,
      `CREATE INDEX agent_runtime_provider_idx ON agent_runtime_configs(organization_id, provider_workspace_id)`,
      // Who may cause a process to start on somebody's machine, and whether a
      // mention does it at all. Cloud authority, because it decides what the
      // workspace *sends*; nothing here describes what the machine runs, and
      // there is deliberately no column that could.
      `CREATE TABLE agent_local_policies (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
        start_on_mention INTEGER NOT NULL DEFAULT 1 CHECK (start_on_mention IN (0, 1)),
        who_may_start TEXT NOT NULL DEFAULT 'scope' CHECK (who_may_start IN ('scope', 'owners')),
        updated_at INTEGER NOT NULL
      ) STRICT`,
      // An owner asking a machine to look at its own launch configuration.
      //
      // An intent from a closed set and nothing else: no path, no argument, no
      // limit, no note. The request is answered when the machine registers a
      // preset revision higher than the one it had when the ask was made, which
      // is the only evidence a cloud row can have that somebody was actually
      // standing at that computer.
      `CREATE TABLE runner_preset_requests (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL,
        intent TEXT NOT NULL CHECK (intent IN ('approve_agent', 'review_preset', 'revalidate_harness', 'review_limits')),
        requested_by_member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        revision_at_request INTEGER NOT NULL CHECK (revision_at_request > 0),
        state TEXT NOT NULL CHECK (state IN ('pending', 'confirmed', 'withdrawn')),
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        resolved_revision INTEGER
      ) STRICT`,
      `CREATE UNIQUE INDEX runner_preset_requests_live_idx
       ON runner_preset_requests(agent_id, device_id, intent) WHERE state = 'pending'`,
      `CREATE INDEX runner_preset_requests_device_idx ON runner_preset_requests(device_id, state)`,
    ],
  },
  {
    version: 27,
    name: "Scan targets and canary credentials",
    statements: [
      // A digest of the value and its length, so a client can answer "does this
      // text contain a credential" without the value leaving the vault. Both
      // are computed by the trusted client that sealed the value; nothing here
      // can produce one, and a credential may have neither.
      //
      // The digest is a verifier for one exact value in one workspace at one
      // version. That is new exposure the ciphertext does not have — a
      // low-entropy value becomes offline-guessable to anybody holding it — so
      // it is opt-out per credential, never stored below the minimum length,
      // and served only to a member who already holds a verb on the credential.
      `ALTER TABLE vault_credentials ADD COLUMN scan_digest TEXT`,
      `ALTER TABLE vault_credentials ADD COLUMN scan_length INTEGER CHECK (scan_length IS NULL OR scan_length >= 8)`,
      // The public half of a canary value. Not a secret: it exists so the
      // workspace can spot the fake credential in content it already receives,
      // with no key and no window scan.
      `ALTER TABLE vault_credentials ADD COLUMN canary_marker TEXT`,
      `CREATE UNIQUE INDEX vault_credentials_canary_idx ON vault_credentials(canary_marker) WHERE canary_marker IS NOT NULL`,
      // What tripped, where, and who was acting. No body and no excerpt: the
      // point of the row is that something carried a credential out of the
      // injection path, and storing the text that did it would be storing the
      // leak.
      `CREATE TABLE vault_canary_trips (
        id TEXT PRIMARY KEY,
        credential_id TEXT NOT NULL REFERENCES vault_credentials(id) ON DELETE CASCADE,
        surface TEXT NOT NULL CHECK (surface IN ('message', 'mcp_message', 'proxy_request')),
        member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
        agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        channel_id TEXT,
        detected_at INTEGER NOT NULL
      ) STRICT`,
      `CREATE INDEX vault_canary_trips_credential_idx ON vault_canary_trips(credential_id, detected_at)`,
    ],
  },
  {
    version: 28,
    name: "Notifications, Home and Inbox",
    statements: [
      `CREATE TABLE notification_preferences (
        member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
        dnd_start_minute INTEGER CHECK (dnd_start_minute IS NULL OR dnd_start_minute BETWEEN 0 AND 1439),
        dnd_end_minute INTEGER CHECK (dnd_end_minute IS NULL OR dnd_end_minute BETWEEN 0 AND 1439),
        dnd_manual_until INTEGER,
        updated_at INTEGER NOT NULL,
        CHECK ((dnd_start_minute IS NULL) = (dnd_end_minute IS NULL))
      ) STRICT`,
      `CREATE TABLE channel_notification_preferences (
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        notify_level TEXT NOT NULL CHECK (notify_level IN ('everything', 'mentions', 'nothing', 'mute')),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (channel_id, member_id)
      ) STRICT`,
      `CREATE TABLE notification_keywords (
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        keyword TEXT NOT NULL COLLATE NOCASE CHECK (length(keyword) BETWEEN 2 AND 64),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (member_id, keyword)
      ) STRICT`,
      `CREATE TABLE thread_subscriptions (
        thread_root_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        subscribed_at INTEGER NOT NULL,
        PRIMARY KEY (thread_root_id, member_id)
      ) STRICT`,
      `CREATE TABLE notifications (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('mention', 'thread_reply', 'dm', 'keyword', 'channel')),
        author_kind TEXT NOT NULL CHECK (author_kind IN ('member', 'agent')),
        author_id TEXT NOT NULL,
        badge INTEGER NOT NULL CHECK (badge IN (0, 1)),
        push_allowed INTEGER NOT NULL CHECK (push_allowed IN (0, 1)),
        private_item INTEGER NOT NULL DEFAULT 0 CHECK (private_item IN (0, 1)),
        allowed_member_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(allowed_member_ids_json)),
        created_at INTEGER NOT NULL,
        read_at INTEGER,
        UNIQUE (member_id, message_id)
      ) STRICT`,
      `CREATE INDEX notifications_inbox_idx ON notifications(member_id, read_at, created_at DESC)`,
      `CREATE INDEX notifications_message_idx ON notifications(message_id)`,
      `ALTER TABLE channels ADD COLUMN broadcast_policy TEXT NOT NULL DEFAULT 'admins' CHECK (broadcast_policy IN ('admins', 'members'))`,
    ],
  },
  {
    version: 29,
    name: "people profiles and managed groups",
    statements: [
      `ALTER TABLE members ADD COLUMN title TEXT`,
      `ALTER TABLE members ADD COLUMN timezone TEXT`,
      `ALTER TABLE members ADD COLUMN working_start_minute INTEGER CHECK (working_start_minute BETWEEN 0 AND 1439)`,
      `ALTER TABLE members ADD COLUMN working_end_minute INTEGER CHECK (working_end_minute BETWEEN 0 AND 1439)`,
      `ALTER TABLE members ADD COLUMN custom_status TEXT`,
      `ALTER TABLE members ADD COLUMN availability TEXT NOT NULL DEFAULT 'auto' CHECK (availability IN ('auto', 'focus', 'away'))`,
      `ALTER TABLE groups ADD COLUMN description TEXT`,
      `ALTER TABLE groups ADD COLUMN archived_at INTEGER`,
      `ALTER TABLE group_members ADD COLUMN added_by_member_id TEXT REFERENCES members(id) ON DELETE SET NULL`,
      `CREATE INDEX groups_active_handle_idx ON groups(handle, archived_at)`,
      `CREATE INDEX group_members_member_idx ON group_members(member_id, group_id)`,
    ],
  },
  {
    version: 30,
    name: "attachment storage and quota accounting",
    statements: [
      // Replaces the import-only `attachments` table from v6. Nothing read it
      // and the Solo upgrade is its only writer, which now writes here, so the
      // workspace keeps one idea of what a file is rather than two.
      `DROP TABLE attachments`,
      `CREATE TABLE files (
        id TEXT PRIMARY KEY,
        object_key TEXT NOT NULL UNIQUE,
        file_name TEXT NOT NULL,
        media_type TEXT NOT NULL,
        byte_length INTEGER NOT NULL CHECK (byte_length > 0),
        sha256 TEXT,
        uploaded_by_member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        state TEXT NOT NULL CHECK (state IN ('reserved', 'stored', 'deleted')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        confirmed_at INTEGER,
        deleted_at INTEGER
      ) STRICT`,
      `CREATE INDEX files_channel_idx ON files(channel_id, state, created_at)`,
      `CREATE INDEX files_message_idx ON files(message_id)`,
      // Sweeping abandoned reservations and counting live bytes both read this.
      `CREATE INDEX files_state_idx ON files(state, expires_at)`,
      // The allowance is decided in D1 and projected here, the way membership
      // is: no cross-database foreign key, and a stale projection fails closed
      // because a zero quota refuses every upload.
      `ALTER TABLE workspace_config ADD COLUMN storage_quota_bytes INTEGER NOT NULL DEFAULT 0 CHECK (storage_quota_bytes >= 0)`,
      `ALTER TABLE workspace_config ADD COLUMN storage_entitlement_version INTEGER NOT NULL DEFAULT 0 CHECK (storage_entitlement_version >= 0)`,
    ],
  },
  {
    version: 31,
    name: "bounded link unfurl cache",
    statements: [
      `CREATE TABLE link_unfurls (
        url TEXT PRIMARY KEY,
        final_url TEXT,
        title TEXT,
        description TEXT,
        site_name TEXT,
        state TEXT NOT NULL CHECK (state IN ('ready', 'failed')),
        fetched_at INTEGER NOT NULL
      ) STRICT`,
      `CREATE TABLE message_unfurls (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        url TEXT NOT NULL REFERENCES link_unfurls(url) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 2),
        PRIMARY KEY (message_id, url)
      ) STRICT`,
      `CREATE INDEX message_unfurls_message_idx ON message_unfurls(message_id, position)`,
    ],
  },
  {
    version: 32,
    name: "workspace search and saved queries",
    statements: [
      // External-content indexes read display text from their authoritative
      // rows. The credential index cannot even address ciphertext or wraps.
      `CREATE VIRTUAL TABLE workspace_search USING fts5(
        body_markdown,
        content = 'messages',
        content_rowid = 'rowid',
        tokenize = 'unicode61 remove_diacritics 2'
      )`,
      `CREATE VIRTUAL TABLE file_search USING fts5(
        file_name,
        media_type,
        content = 'files',
        content_rowid = 'rowid',
        tokenize = 'unicode61 remove_diacritics 2'
      )`,
      `CREATE VIRTUAL TABLE credential_search USING fts5(
        name,
        description,
        content = 'vault_credentials',
        content_rowid = 'rowid',
        tokenize = 'unicode61 remove_diacritics 2'
      )`,
      `INSERT INTO workspace_search(rowid, body_markdown)
       SELECT rowid, body_markdown FROM messages WHERE deleted_at IS NULL`,
      `INSERT INTO file_search(rowid, file_name, media_type)
       SELECT rowid, file_name, media_type FROM files WHERE state = 'stored'`,
      `INSERT INTO credential_search(rowid, name, description)
       SELECT rowid, name, description FROM vault_credentials`,
      `CREATE TRIGGER workspace_search_message_insert AFTER INSERT ON messages WHEN new.deleted_at IS NULL BEGIN
         INSERT INTO workspace_search(rowid, body_markdown) VALUES (new.rowid, new.body_markdown);
       END`,
      `CREATE TRIGGER workspace_search_message_update AFTER UPDATE OF body_markdown, deleted_at ON messages BEGIN
         INSERT INTO workspace_search(workspace_search, rowid, body_markdown)
           SELECT 'delete', old.rowid, old.body_markdown WHERE old.deleted_at IS NULL;
         INSERT INTO workspace_search(rowid, body_markdown)
           SELECT new.rowid, new.body_markdown WHERE new.deleted_at IS NULL;
       END`,
      `CREATE TRIGGER workspace_search_message_delete AFTER DELETE ON messages BEGIN
         INSERT INTO workspace_search(workspace_search, rowid, body_markdown)
           SELECT 'delete', old.rowid, old.body_markdown WHERE old.deleted_at IS NULL;
       END`,
      `CREATE TRIGGER workspace_search_file_insert AFTER INSERT ON files WHEN new.state = 'stored' BEGIN
         INSERT INTO file_search(rowid, file_name, media_type) VALUES (new.rowid, new.file_name, new.media_type);
       END`,
      `CREATE TRIGGER workspace_search_file_update AFTER UPDATE OF file_name, media_type, state ON files BEGIN
         INSERT INTO file_search(file_search, rowid, file_name, media_type)
           SELECT 'delete', old.rowid, old.file_name, old.media_type WHERE old.state = 'stored';
         INSERT INTO file_search(rowid, file_name, media_type)
           SELECT new.rowid, new.file_name, new.media_type WHERE new.state = 'stored';
       END`,
      `CREATE TRIGGER workspace_search_file_delete AFTER DELETE ON files BEGIN
         INSERT INTO file_search(file_search, rowid, file_name, media_type)
           SELECT 'delete', old.rowid, old.file_name, old.media_type WHERE old.state = 'stored';
       END`,
      `CREATE TRIGGER workspace_search_credential_insert AFTER INSERT ON vault_credentials BEGIN
         INSERT INTO credential_search(rowid, name, description) VALUES (new.rowid, new.name, new.description);
       END`,
      `CREATE TRIGGER workspace_search_credential_update AFTER UPDATE OF name, description ON vault_credentials BEGIN
         INSERT INTO credential_search(credential_search, rowid, name, description)
           VALUES ('delete', old.rowid, old.name, old.description);
         INSERT INTO credential_search(rowid, name, description) VALUES (new.rowid, new.name, new.description);
       END`,
      `CREATE TRIGGER workspace_search_credential_delete AFTER DELETE ON vault_credentials BEGIN
         INSERT INTO credential_search(credential_search, rowid, name, description)
           VALUES ('delete', old.rowid, old.name, old.description);
       END`,
      `CREATE TABLE saved_searches (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        name TEXT NOT NULL COLLATE NOCASE,
        query TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(member_id, name)
      ) STRICT`,
      `CREATE INDEX saved_searches_member_idx ON saved_searches(member_id, updated_at DESC)`,
    ],
  },
  {
    version: 33,
    name: "form rooms and ranked work queues",
    statements: [
      `ALTER TABLE channels ADD COLUMN post_mode TEXT NOT NULL DEFAULT 'open'
         CHECK (post_mode IN ('open', 'form'))`,
      `ALTER TABLE channels ADD COLUMN form_definition_json TEXT CHECK (
         form_definition_json IS NULL OR json_valid(form_definition_json)
       )`,
      `ALTER TABLE channels ADD COLUMN form_version INTEGER NOT NULL DEFAULT 0 CHECK (form_version >= 0)`,
      `ALTER TABLE channels ADD COLUMN sort_mode TEXT NOT NULL DEFAULT 'chronological'
         CHECK (sort_mode IN ('chronological', 'ranked'))`,
      `ALTER TABLE channels ADD COLUMN sort_emoji TEXT`,
      `ALTER TABLE channels ADD COLUMN status_definitions_json TEXT NOT NULL DEFAULT '[]'
         CHECK (json_valid(status_definitions_json))`,
      `ALTER TABLE channels ADD COLUMN main_status_label TEXT NOT NULL DEFAULT 'Main'`,
      `ALTER TABLE messages ADD COLUMN content_json TEXT CHECK (content_json IS NULL OR json_valid(content_json))`,
      `ALTER TABLE messages ADD COLUMN status_id TEXT`,
      `ALTER TABLE messages ADD COLUMN status_set_by_member_id TEXT REFERENCES members(id) ON DELETE SET NULL`,
      `ALTER TABLE messages ADD COLUMN status_set_at INTEGER`,
      `CREATE INDEX messages_queue_idx ON messages(channel_id, status_id, created_at DESC, id DESC)
         WHERE thread_root_id IS NULL AND deleted_at IS NULL`,
      // Structured answers have their own index even though the canonical
      // markdown remains in messages. That preserves a clean seam for future
      // field-aware search without changing what existing message search means.
      `CREATE TABLE form_submission_content (
         message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
         searchable_text TEXT NOT NULL
       ) STRICT`,
      `CREATE VIRTUAL TABLE form_submission_search USING fts5(
         searchable_text,
         content = 'form_submission_content',
         content_rowid = 'rowid',
         tokenize = 'unicode61 remove_diacritics 2'
       )`,
      `CREATE TRIGGER form_submission_search_insert AFTER INSERT ON form_submission_content BEGIN
         INSERT INTO form_submission_search(rowid, searchable_text) VALUES (new.rowid, new.searchable_text);
       END`,
      `CREATE TRIGGER form_submission_search_update AFTER UPDATE OF searchable_text ON form_submission_content BEGIN
         INSERT INTO form_submission_search(form_submission_search, rowid, searchable_text)
           VALUES ('delete', old.rowid, old.searchable_text);
         INSERT INTO form_submission_search(rowid, searchable_text) VALUES (new.rowid, new.searchable_text);
       END`,
      `CREATE TRIGGER form_submission_search_delete AFTER DELETE ON form_submission_content BEGIN
         INSERT INTO form_submission_search(form_submission_search, rowid, searchable_text)
           VALUES ('delete', old.rowid, old.searchable_text);
       END`,
    ],
  },
  {
    version: 34,
    name: "web push subscriptions",
    statements: [
      // One row per browser, not per person: somebody signed in on a laptop and
      // a phone has two, and an approval has to reach whichever one they are
      // holding. The endpoint is unique because that is what the push service
      // considers the subscription's identity, and re-subscribing the same
      // browser must replace rather than accumulate.
      `CREATE TABLE push_subscriptions (
         id TEXT PRIMARY KEY,
         member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
         endpoint TEXT NOT NULL UNIQUE,
         p256dh TEXT NOT NULL,
         auth TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         last_success_at INTEGER,
         last_error TEXT
       ) STRICT`,
      `CREATE INDEX push_subscriptions_member_idx ON push_subscriptions(member_id)`,
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
