import {
  clampHistoryLimit,
  encodeHistoryCursor,
  parseHistoryCursor,
  type ChannelKind,
} from "../domain/rooms";

/**
 * Storage-level reads and writes for rooms and messages.
 *
 * Authorization lives on the Durable Object, which knows who is asking; these
 * helpers only shape the SQL, so the object's methods stay readable next to the
 * transaction envelope they commit through.
 */

export type ChannelRow = {
  id: string;
  kind: ChannelKind;
  slug: string | null;
  name: string | null;
  topic: string | null;
  dmKey: string | null;
  archivedAt: number | null;
  createdByMemberId: string | null;
  createdAt: number;
  messageCount: number;
  lastActivityAt: number | null;
};

export type MessageRow = {
  id: string;
  channelId: string;
  threadRootId: string | null;
  authorKind: "member" | "agent" | "imported";
  authorId: string;
  authorDisplaySnapshot: string;
  bodyMarkdown: string;
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
  channelSequence: number | null;
  replyCount: number;
  lastReplyAt: number | null;
};

export type MessagePage = {
  messages: readonly MessageRow[];
  /** Present when an older page exists. Opaque to the caller. */
  nextCursor: string | null;
};

const CHANNEL_COLUMNS = `id, kind, slug, name, topic, dm_key, archived_at, created_by_member_id,
                         created_at, message_count, last_activity_at`;

type RawChannel = {
  id: string;
  kind: ChannelKind;
  slug: string | null;
  name: string | null;
  topic: string | null;
  dm_key: string | null;
  archived_at: number | null;
  created_by_member_id: string | null;
  created_at: number;
  message_count: number;
  last_activity_at: number | null;
};

function toChannel(row: RawChannel): ChannelRow {
  return {
    id: row.id,
    kind: row.kind,
    slug: row.slug,
    name: row.name,
    topic: row.topic,
    dmKey: row.dm_key,
    archivedAt: row.archived_at,
    createdByMemberId: row.created_by_member_id,
    createdAt: row.created_at,
    messageCount: row.message_count,
    lastActivityAt: row.last_activity_at,
  };
}

const MESSAGE_COLUMNS = `id, channel_id, thread_root_id, author_kind, author_id,
                         author_display_snapshot, body_markdown, created_at, edited_at,
                         deleted_at, channel_sequence, reply_count, last_reply_at`;

type RawMessage = {
  id: string;
  channel_id: string;
  thread_root_id: string | null;
  author_kind: MessageRow["authorKind"];
  author_id: string;
  author_display_snapshot: string;
  body_markdown: string;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  channel_sequence: number | null;
  reply_count: number;
  last_reply_at: number | null;
};

function toMessage(row: RawMessage): MessageRow {
  return {
    id: row.id,
    channelId: row.channel_id,
    threadRootId: row.thread_root_id,
    authorKind: row.author_kind,
    authorId: row.author_id,
    authorDisplaySnapshot: row.author_display_snapshot,
    bodyMarkdown: row.body_markdown,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
    channelSequence: row.channel_sequence,
    replyCount: row.reply_count,
    lastReplyAt: row.last_reply_at,
  };
}

/* -------------------------------------------------------------------------- */
/* Channels                                                                    */
/* -------------------------------------------------------------------------- */

export function readChannel(storage: DurableObjectStorage, channelId: string): ChannelRow | null {
  const row = storage.sql
    .exec<RawChannel>(`SELECT ${CHANNEL_COLUMNS} FROM channels WHERE id = ?`, channelId)
    .toArray()[0];
  return row ? toChannel(row) : null;
}

export function readChannelBySlug(storage: DurableObjectStorage, slug: string): ChannelRow | null {
  const row = storage.sql
    .exec<RawChannel>(`SELECT ${CHANNEL_COLUMNS} FROM channels WHERE slug = ?`, slug)
    .toArray()[0];
  return row ? toChannel(row) : null;
}

export function readChannelByDirectMessageKey(
  storage: DurableObjectStorage,
  dmKey: string,
): ChannelRow | null {
  const row = storage.sql
    .exec<RawChannel>(`SELECT ${CHANNEL_COLUMNS} FROM channels WHERE dm_key = ?`, dmKey)
    .toArray()[0];
  return row ? toChannel(row) : null;
}

export function isChannelMember(
  storage: DurableObjectStorage,
  channelId: string,
  memberId: string,
): boolean {
  return (
    storage.sql
      .exec<{ present: number }>(
        "SELECT 1 AS present FROM channel_members WHERE channel_id = ? AND member_id = ?",
        channelId,
        memberId,
      )
      .toArray()[0]?.present === 1
  );
}

export function channelMemberIds(storage: DurableObjectStorage, channelId: string): string[] {
  return storage.sql
    .exec<{ member_id: string }>(
      "SELECT member_id FROM channel_members WHERE channel_id = ? ORDER BY member_id",
      channelId,
    )
    .toArray()
    .map((row) => row.member_id);
}

export function insertChannel(
  storage: DurableObjectStorage,
  channel: {
    id: string;
    kind: ChannelKind;
    slug: string | null;
    name: string | null;
    topic: string | null;
    dmKey: string | null;
    createdByMemberId: string;
    now: number;
  },
): void {
  storage.sql.exec(
    `INSERT INTO channels(id, kind, slug, name, topic, dm_key, created_by_member_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    channel.id,
    channel.kind,
    channel.slug,
    channel.name,
    channel.topic,
    channel.dmKey,
    channel.createdByMemberId,
    channel.now,
    channel.now,
  );
  storage.sql.exec(
    "INSERT INTO channel_message_sequence(channel_id, next_sequence) VALUES (?, 1)",
    channel.id,
  );
}

/** Returns the ids actually added, so a caller can report a no-op honestly. */
export function addChannelMembers(
  storage: DurableObjectStorage,
  channelId: string,
  memberIds: readonly string[],
  now: number,
): string[] {
  const added: string[] = [];
  for (const memberId of memberIds) {
    const result = storage.sql.exec(
      `INSERT INTO channel_members(channel_id, member_id, joined_at) VALUES (?, ?, ?)
       ON CONFLICT(channel_id, member_id) DO NOTHING`,
      channelId,
      memberId,
      now,
    );
    if (result.rowsWritten > 0) added.push(memberId);
  }
  return added;
}

export function removeChannelMember(
  storage: DurableObjectStorage,
  channelId: string,
  memberId: string,
): boolean {
  return (
    storage.sql.exec(
      "DELETE FROM channel_members WHERE channel_id = ? AND member_id = ?",
      channelId,
      memberId,
    ).rowsWritten > 0
  );
}

export function archiveChannel(
  storage: DurableObjectStorage,
  channelId: string,
  now: number,
): void {
  storage.sql.exec(
    "UPDATE channels SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL",
    now,
    now,
    channelId,
  );
}

/**
 * Everything this member may see: every public room, plus the private rooms and
 * conversations they belong to. A private room they are not in is not returned
 * and is not counted.
 */
export function listVisibleChannels(
  storage: DurableObjectStorage,
  memberId: string,
  includeArchived: boolean,
): ChannelRow[] {
  return storage.sql
    .exec<RawChannel>(
      `SELECT ${CHANNEL_COLUMNS.split(",").map((column) => `c.${column.trim()}`).join(", ")}
       FROM channels c
       LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.member_id = ?
       WHERE (c.kind = 'public' OR cm.member_id IS NOT NULL)
         AND (? = 1 OR c.archived_at IS NULL)
       ORDER BY c.kind, COALESCE(c.slug, c.name, c.id)`,
      memberId,
      includeArchived ? 1 : 0,
    )
    .toArray()
    .map(toChannel);
}

/* -------------------------------------------------------------------------- */
/* Messages                                                                    */
/* -------------------------------------------------------------------------- */

export function readMessage(storage: DurableObjectStorage, messageId: string): MessageRow | null {
  const row = storage.sql
    .exec<RawMessage>(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`, messageId)
    .toArray()[0];
  return row ? toMessage(row) : null;
}

/** Per-channel monotonic ordering, allocated inside the send transaction. */
export function nextChannelSequence(storage: DurableObjectStorage, channelId: string): number {
  const row = storage.sql
    .exec<{ next_sequence: number }>(
      "SELECT next_sequence FROM channel_message_sequence WHERE channel_id = ?",
      channelId,
    )
    .toArray()[0];
  const sequence = row?.next_sequence ?? 1;
  storage.sql.exec(
    `INSERT INTO channel_message_sequence(channel_id, next_sequence) VALUES (?, ?)
     ON CONFLICT(channel_id) DO UPDATE SET next_sequence = excluded.next_sequence`,
    channelId,
    sequence + 1,
  );
  return sequence;
}

export function insertMessage(
  storage: DurableObjectStorage,
  message: {
    id: string;
    channelId: string;
    threadRootId: string | null;
    authorKind: MessageRow["authorKind"];
    authorId: string;
    authorDisplaySnapshot: string;
    bodyMarkdown: string;
    channelSequence: number;
    now: number;
  },
): { threadSequence: number | null } {
  const threadSequence =
    message.threadRootId === null
      ? null
      : (storage.sql
          .exec<{ reply_count: number }>(
            "SELECT reply_count FROM messages WHERE id = ?",
            message.threadRootId,
          )
          .one().reply_count ?? 0) + 1;

  storage.sql.exec(
    `INSERT INTO messages(
       id, channel_id, thread_root_id, author_kind, author_id, author_display_snapshot,
       body_markdown, created_at, channel_sequence, thread_sequence
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    message.id,
    message.channelId,
    message.threadRootId,
    message.authorKind,
    message.authorId,
    message.authorDisplaySnapshot,
    message.bodyMarkdown,
    message.now,
    message.channelSequence,
    threadSequence,
  );
  storage.sql.exec(
    `UPDATE channels SET message_count = message_count + 1, last_activity_at = ?, updated_at = ?
     WHERE id = ?`,
    message.now,
    message.now,
    message.channelId,
  );
  if (message.threadRootId !== null) {
    storage.sql.exec(
      "UPDATE messages SET reply_count = reply_count + 1, last_reply_at = ? WHERE id = ?",
      message.now,
      message.threadRootId,
    );
  }
  return { threadSequence };
}

/**
 * Newest first, keyed on `(created_at, id)` so two messages written in the same
 * millisecond still page deterministically.
 */
export function listChannelHistory(
  storage: DurableObjectStorage,
  channelId: string,
  cursor: string | null,
  limit: unknown,
): MessagePage {
  const size = clampHistoryLimit(limit);
  const decoded = cursor === null ? null : parseHistoryCursor(cursor);
  if (cursor !== null && decoded === null) throw new Error("invalid history cursor");

  const rows = decoded
    ? storage.sql
        .exec<RawMessage>(
          `SELECT ${MESSAGE_COLUMNS} FROM messages
           WHERE channel_id = ? AND thread_root_id IS NULL
             AND (created_at < ? OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC LIMIT ?`,
          channelId,
          decoded.createdAt,
          decoded.createdAt,
          decoded.id,
          size + 1,
        )
        .toArray()
    : storage.sql
        .exec<RawMessage>(
          `SELECT ${MESSAGE_COLUMNS} FROM messages
           WHERE channel_id = ? AND thread_root_id IS NULL
           ORDER BY created_at DESC, id DESC LIMIT ?`,
          channelId,
          size + 1,
        )
        .toArray();

  return page(rows, size);
}

/** Oldest first: a thread is read forwards from the message that started it. */
export function listThreadHistory(
  storage: DurableObjectStorage,
  threadRootId: string,
  cursor: string | null,
  limit: unknown,
): MessagePage {
  const size = clampHistoryLimit(limit);
  const decoded = cursor === null ? null : parseHistoryCursor(cursor);
  if (cursor !== null && decoded === null) throw new Error("invalid history cursor");

  const rows = decoded
    ? storage.sql
        .exec<RawMessage>(
          `SELECT ${MESSAGE_COLUMNS} FROM messages
           WHERE thread_root_id = ?
             AND (created_at > ? OR (created_at = ? AND id > ?))
           ORDER BY created_at ASC, id ASC LIMIT ?`,
          threadRootId,
          decoded.createdAt,
          decoded.createdAt,
          decoded.id,
          size + 1,
        )
        .toArray()
    : storage.sql
        .exec<RawMessage>(
          `SELECT ${MESSAGE_COLUMNS} FROM messages
           WHERE thread_root_id = ?
           ORDER BY created_at ASC, id ASC LIMIT ?`,
          threadRootId,
          size + 1,
        )
        .toArray();

  return page(rows, size);
}

function page(rows: readonly RawMessage[], size: number): MessagePage {
  const hasMore = rows.length > size;
  const visible = (hasMore ? rows.slice(0, size) : rows).map(toMessage);
  const last = visible.at(-1);
  return {
    messages: visible,
    nextCursor:
      hasMore && last ? encodeHistoryCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}


/* -------------------------------------------------------------------------- */
/* Read cursors                                                                */
/* -------------------------------------------------------------------------- */

export function readChannelCursor(
  storage: DurableObjectStorage,
  channelId: string,
  memberId: string,
): number {
  return (
    storage.sql
      .exec<{ last_read_sequence: number }>(
        "SELECT last_read_sequence FROM channel_read_state WHERE channel_id = ? AND member_id = ?",
        channelId,
        memberId,
      )
      .toArray()[0]?.last_read_sequence ?? 0
  );
}

export function writeChannelCursor(
  storage: DurableObjectStorage,
  channelId: string,
  memberId: string,
  sequence: number,
  now: number,
): void {
  storage.sql.exec(
    `INSERT INTO channel_read_state(channel_id, member_id, last_read_sequence, last_read_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(channel_id, member_id) DO UPDATE SET
       last_read_sequence = excluded.last_read_sequence,
       last_read_at = excluded.last_read_at`,
    channelId,
    memberId,
    sequence,
    now,
  );
}

export function readThreadCursor(
  storage: DurableObjectStorage,
  threadRootId: string,
  memberId: string,
): number {
  return (
    storage.sql
      .exec<{ last_read_sequence: number }>(
        "SELECT last_read_sequence FROM thread_read_state WHERE thread_root_id = ? AND member_id = ?",
        threadRootId,
        memberId,
      )
      .toArray()[0]?.last_read_sequence ?? 0
  );
}

export function writeThreadCursor(
  storage: DurableObjectStorage,
  threadRootId: string,
  memberId: string,
  sequence: number,
  now: number,
): void {
  storage.sql.exec(
    `INSERT INTO thread_read_state(thread_root_id, member_id, last_read_sequence, last_read_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(thread_root_id, member_id) DO UPDATE SET
       last_read_sequence = excluded.last_read_sequence,
       last_read_at = excluded.last_read_at`,
    threadRootId,
    memberId,
    sequence,
    now,
  );
}

/** Every visible room with its latest sequence and this member's cursor. */
export function readUnreadFacts(
  storage: DurableObjectStorage,
  memberId: string,
): {
  channelId: string;
  kind: ChannelRow["kind"];
  archivedAt: number | null;
  isMember: boolean;
  latestSequence: number;
  lastReadSequence: number;
}[] {
  return storage.sql
    .exec<{
      channel_id: string;
      kind: ChannelRow["kind"];
      archived_at: number | null;
      is_member: number;
      latest_sequence: number;
      last_read_sequence: number;
    }>(
      `SELECT c.id AS channel_id, c.kind, c.archived_at,
              CASE WHEN cm.member_id IS NULL THEN 0 ELSE 1 END AS is_member,
              COALESCE((SELECT MAX(channel_sequence) FROM messages m
                        WHERE m.channel_id = c.id AND m.thread_root_id IS NULL), 0) AS latest_sequence,
              COALESCE(rs.last_read_sequence, 0) AS last_read_sequence
       FROM channels c
       LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.member_id = ?
       LEFT JOIN channel_read_state rs ON rs.channel_id = c.id AND rs.member_id = ?
       WHERE c.kind = 'public' OR cm.member_id IS NOT NULL
       ORDER BY c.id`,
      memberId,
      memberId,
    )
    .toArray()
    .map((row) => ({
      channelId: row.channel_id,
      kind: row.kind,
      archivedAt: row.archived_at,
      isMember: row.is_member === 1,
      latestSequence: row.latest_sequence,
      lastReadSequence: row.last_read_sequence,
    }));
}

export function latestChannelSequence(storage: DurableObjectStorage, channelId: string): number {
  return (
    storage.sql
      .exec<{ latest: number | null }>(
        "SELECT MAX(channel_sequence) AS latest FROM messages WHERE channel_id = ? AND thread_root_id IS NULL",
        channelId,
      )
      .one().latest ?? 0
  );
}

export function latestThreadSequence(storage: DurableObjectStorage, threadRootId: string): number {
  return (
    storage.sql
      .exec<{ latest: number | null }>(
        "SELECT MAX(thread_sequence) AS latest FROM messages WHERE thread_root_id = ?",
        threadRootId,
      )
      .one().latest ?? 0
  );
}
