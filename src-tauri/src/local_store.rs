use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

const SCHEMA: &str = r#"
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS local_schema (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;
INSERT OR IGNORE INTO local_schema(singleton, version) VALUES (1, 1);
CREATE TABLE IF NOT EXISTS host_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  workspace_id TEXT NOT NULL,
  host_epoch INTEGER NOT NULL CHECK (host_epoch >= 0)
) STRICT;
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('public', 'private', 'dm', 'group_dm')),
  slug TEXT,
  name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  body_markdown TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS messages_channel_time_idx ON messages(channel_id, created_at, id);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  relative_path TEXT NOT NULL,
  sha256 TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS request_log (
  request_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  committed_at INTEGER NOT NULL
) STRICT;
CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(message_id UNINDEXED, body_markdown);
"#;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("local filesystem error: {0}")]
    Io(#[from] std::io::Error),
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("request id was reused with different content")]
    IdempotencyConflict,
    #[error("stale host epoch")]
    StaleHostEpoch,
    #[error("host epoch must advance by one")]
    InvalidHostEpoch,
    #[error("snapshot checksum mismatch")]
    SnapshotChecksum,
    #[error("snapshot belongs to another workspace")]
    SnapshotWorkspace,
}

pub type StoreResult<T> = Result<T, StoreError>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChannelRecord {
    pub id: String,
    pub kind: String,
    pub slug: Option<String>,
    pub name: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MessageRecord {
    pub id: String,
    pub channel_id: String,
    pub author_id: String,
    pub body_markdown: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentRecord {
    pub id: String,
    pub message_id: String,
    pub file_name: String,
    pub media_type: String,
    pub byte_length: i64,
    pub relative_path: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotPayload {
    pub version: u8,
    pub workspace_id: String,
    pub host_epoch: i64,
    pub channels: Vec<ChannelRecord>,
    pub messages: Vec<MessageRecord>,
    pub attachments: Vec<AttachmentRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContentSnapshot {
    #[serde(flatten)]
    pub payload: SnapshotPayload,
    pub checksum: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageWrite {
    pub request_id: String,
    pub message_id: String,
    pub host_epoch: i64,
    pub channel_id: String,
    pub author_id: String,
    pub body_markdown: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MessageAck {
    pub message_id: String,
    pub committed_at: i64,
    pub replayed: bool,
}

pub struct LocalContentStore {
    connection: Connection,
}

impl LocalContentStore {
    #[allow(dead_code)]
    pub fn open(path: &Path, workspace_id: &str, initial_host_epoch: i64) -> StoreResult<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
            }
        }
        let connection = Connection::open(path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
        }
        Self::initialize(connection, workspace_id, initial_host_epoch)
    }

    fn initialize(
        mut connection: Connection,
        workspace_id: &str,
        initial_host_epoch: i64,
    ) -> StoreResult<Self> {
        connection.execute_batch(SCHEMA)?;
        let transaction = connection.transaction()?;
        let state = transaction
            .query_row(
                "SELECT workspace_id, host_epoch FROM host_state WHERE singleton = 1",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()?;
        match state {
            Some((stored_workspace, _)) if stored_workspace != workspace_id => {
                return Err(StoreError::SnapshotWorkspace)
            }
            Some(_) => {}
            None => {
                transaction.execute(
                    "INSERT INTO host_state(singleton, workspace_id, host_epoch) VALUES (1, ?, ?)",
                    params![workspace_id, initial_host_epoch],
                )?;
            }
        }
        transaction.commit()?;
        Ok(Self { connection })
    }

    pub fn put_channel(&mut self, channel: &ChannelRecord) -> StoreResult<()> {
        self.connection.execute(
            "INSERT INTO channels(id, kind, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)\
             ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, slug=excluded.slug, name=excluded.name, updated_at=excluded.updated_at",
            params![channel.id, channel.kind, channel.slug, channel.name, channel.created_at, channel.updated_at],
        )?;
        Ok(())
    }

    pub fn commit_message(&mut self, write: &MessageWrite) -> StoreResult<MessageAck> {
        let request_hash = message_request_hash(write)?;
        let transaction = self.connection.transaction()?;
        if let Some((stored_hash, response_json)) = transaction
            .query_row(
                "SELECT request_hash, response_json FROM request_log WHERE request_id = ?",
                [&write.request_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?
        {
            if stored_hash != request_hash {
                return Err(StoreError::IdempotencyConflict);
            }
            let mut response: MessageAck = serde_json::from_str(&response_json)?;
            response.replayed = true;
            return Ok(response);
        }
        require_epoch(&transaction, write.host_epoch)?;
        transaction.execute(
            "INSERT INTO messages(id, channel_id, author_id, body_markdown, created_at) VALUES (?, ?, ?, ?, ?)",
            params![write.message_id, write.channel_id, write.author_id, write.body_markdown, write.created_at],
        )?;
        transaction.execute(
            "INSERT INTO message_fts(message_id, body_markdown) VALUES (?, ?)",
            params![write.message_id, write.body_markdown],
        )?;
        let response = MessageAck {
            message_id: write.message_id.clone(),
            committed_at: write.created_at,
            replayed: false,
        };
        transaction.execute(
            "INSERT INTO request_log(request_id, request_hash, response_json, committed_at) VALUES (?, ?, ?, ?)",
            params![write.request_id, request_hash, serde_json::to_string(&response)?, write.created_at],
        )?;
        transaction.commit()?;
        Ok(response)
    }

    pub fn set_host_epoch(&mut self, new_epoch: i64) -> StoreResult<()> {
        let transaction = self.connection.transaction()?;
        let current = host_epoch(&transaction)?;
        if new_epoch != current + 1 {
            return Err(StoreError::InvalidHostEpoch);
        }
        transaction.execute(
            "UPDATE host_state SET host_epoch = ? WHERE singleton = 1",
            [new_epoch],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn get_message(&self, message_id: &str) -> StoreResult<Option<MessageRecord>> {
        Ok(self
            .connection
            .query_row(
                "SELECT id, channel_id, author_id, body_markdown, created_at FROM messages WHERE id = ?",
                [message_id],
                |row| {
                    Ok(MessageRecord {
                        id: row.get(0)?,
                        channel_id: row.get(1)?,
                        author_id: row.get(2)?,
                        body_markdown: row.get(3)?,
                        created_at: row.get(4)?,
                    })
                },
            )
            .optional()?)
    }

    pub fn export_snapshot(&self) -> StoreResult<ContentSnapshot> {
        let (workspace_id, epoch) = self.connection.query_row(
            "SELECT workspace_id, host_epoch FROM host_state WHERE singleton = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let payload = SnapshotPayload {
            version: 1,
            workspace_id,
            host_epoch: epoch,
            channels: query_channels(&self.connection)?,
            messages: query_messages(&self.connection)?,
            attachments: query_attachments(&self.connection)?,
        };
        let checksum = snapshot_checksum(&payload)?;
        Ok(ContentSnapshot { payload, checksum })
    }

    pub fn import_snapshot(&mut self, snapshot: &ContentSnapshot) -> StoreResult<()> {
        if snapshot.checksum != snapshot_checksum(&snapshot.payload)? {
            return Err(StoreError::SnapshotChecksum);
        }
        let local_workspace: String = self.connection.query_row(
            "SELECT workspace_id FROM host_state WHERE singleton = 1",
            [],
            |row| row.get(0),
        )?;
        if local_workspace != snapshot.payload.workspace_id {
            return Err(StoreError::SnapshotWorkspace);
        }
        let transaction = self.connection.transaction()?;
        transaction.execute("DELETE FROM attachments", [])?;
        transaction.execute("DELETE FROM message_fts", [])?;
        transaction.execute("DELETE FROM messages", [])?;
        transaction.execute("DELETE FROM channels", [])?;
        for channel in &snapshot.payload.channels {
            transaction.execute(
                "INSERT INTO channels(id, kind, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                params![channel.id, channel.kind, channel.slug, channel.name, channel.created_at, channel.updated_at],
            )?;
        }
        for message in &snapshot.payload.messages {
            transaction.execute(
                "INSERT INTO messages(id, channel_id, author_id, body_markdown, created_at) VALUES (?, ?, ?, ?, ?)",
                params![message.id, message.channel_id, message.author_id, message.body_markdown, message.created_at],
            )?;
            transaction.execute(
                "INSERT INTO message_fts(message_id, body_markdown) VALUES (?, ?)",
                params![message.id, message.body_markdown],
            )?;
        }
        for attachment in &snapshot.payload.attachments {
            transaction.execute(
                "INSERT INTO attachments(id, message_id, file_name, media_type, byte_length, relative_path, sha256) VALUES (?, ?, ?, ?, ?, ?, ?)",
                params![attachment.id, attachment.message_id, attachment.file_name, attachment.media_type, attachment.byte_length, attachment.relative_path, attachment.sha256],
            )?;
        }
        transaction.execute(
            "UPDATE host_state SET host_epoch = ? WHERE singleton = 1",
            [snapshot.payload.host_epoch],
        )?;
        transaction.commit()?;
        Ok(())
    }
}

fn require_epoch(transaction: &Transaction<'_>, requested: i64) -> StoreResult<()> {
    if host_epoch(transaction)? != requested {
        return Err(StoreError::StaleHostEpoch);
    }
    Ok(())
}

fn host_epoch(transaction: &Transaction<'_>) -> StoreResult<i64> {
    Ok(transaction.query_row(
        "SELECT host_epoch FROM host_state WHERE singleton = 1",
        [],
        |row| row.get(0),
    )?)
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn message_request_hash(write: &MessageWrite) -> StoreResult<String> {
    Ok(sha256_hex(&serde_json::to_vec(&(
        &write.message_id,
        write.host_epoch,
        &write.channel_id,
        &write.author_id,
        &write.body_markdown,
        write.created_at,
    ))?))
}

fn snapshot_checksum(payload: &SnapshotPayload) -> StoreResult<String> {
    Ok(sha256_hex(&serde_json::to_vec(payload)?))
}

fn query_channels(connection: &Connection) -> StoreResult<Vec<ChannelRecord>> {
    let mut statement = connection
        .prepare("SELECT id, kind, slug, name, created_at, updated_at FROM channels ORDER BY id")?;
    let rows = statement
        .query_map([], |row| {
            Ok(ChannelRecord {
                id: row.get(0)?,
                kind: row.get(1)?,
                slug: row.get(2)?,
                name: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn query_messages(connection: &Connection) -> StoreResult<Vec<MessageRecord>> {
    let mut statement = connection.prepare(
        "SELECT id, channel_id, author_id, body_markdown, created_at FROM messages ORDER BY id",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok(MessageRecord {
                id: row.get(0)?,
                channel_id: row.get(1)?,
                author_id: row.get(2)?,
                body_markdown: row.get(3)?,
                created_at: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn query_attachments(connection: &Connection) -> StoreResult<Vec<AttachmentRecord>> {
    let mut statement = connection.prepare("SELECT id, message_id, file_name, media_type, byte_length, relative_path, sha256 FROM attachments ORDER BY id")?;
    let rows = statement
        .query_map([], |row| {
            Ok(AttachmentRecord {
                id: row.get(0)?,
                message_id: row.get(1)?,
                file_name: row.get(2)?,
                media_type: row.get(3)?,
                byte_length: row.get(4)?,
                relative_path: row.get(5)?,
                sha256: row.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}
