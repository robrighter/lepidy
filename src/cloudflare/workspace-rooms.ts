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

export type MessageReaction = { emoji: string; memberIds: readonly string[] };

export type MessageMention = { kind: string; handle: string; resolvedId: string | null };

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
  editCount: number;
  reactions: readonly MessageReaction[];
  mentions: readonly MessageMention[];
  /** Set on a forwarded copy. Resolved for display only where the reader may see the source. */
  forwardedFrom: MessageForwardSource | null;
  /** Per reader, filled in by the object which knows who is asking. */
  isSaved?: boolean;
  isPinned?: boolean;
};

export type MessageForwardSource = {
  messageId: string;
  channelId: string;
  authorDisplaySnapshot: string;
  /** False when the reader cannot see the room the copy came from. */
  sourceVisible: boolean;
  sourceChannelLabel: string | null;
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
                         deleted_at, channel_sequence, reply_count, last_reply_at, edit_count,
                         forwarded_from_message_id, forwarded_from_channel_id, forwarded_author_snapshot`;

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
  edit_count: number;
  forwarded_from_message_id: string | null;
  forwarded_from_channel_id: string | null;
  forwarded_author_snapshot: string | null;
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
    editCount: row.edit_count,
    reactions: [],
    mentions: [],
    forwardedFrom:
      row.forwarded_from_message_id === null
        ? null
        : {
            messageId: row.forwarded_from_message_id,
            channelId: row.forwarded_from_channel_id ?? "",
            authorDisplaySnapshot: row.forwarded_author_snapshot ?? "",
            // Resolved by the object, which knows who is reading.
            sourceVisible: false,
            sourceChannelLabel: null,
          },
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
    forwardedFrom?: { messageId: string; channelId: string; authorDisplaySnapshot: string } | null;
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
       body_markdown, created_at, channel_sequence, thread_sequence,
       forwarded_from_message_id, forwarded_from_channel_id, forwarded_author_snapshot
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    message.forwardedFrom?.messageId ?? null,
    message.forwardedFrom?.channelId ?? null,
    message.forwardedFrom?.authorDisplaySnapshot ?? null,
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


/* -------------------------------------------------------------------------- */
/* Reactions, mentions and edits                                               */
/* -------------------------------------------------------------------------- */

export function readReactions(
  storage: DurableObjectStorage,
  messageIds: readonly string[],
): Map<string, MessageReaction[]> {
  const byMessage = new Map<string, MessageReaction[]>();
  if (messageIds.length === 0) return byMessage;
  const placeholders = messageIds.map(() => "?").join(", ");
  const rows = storage.sql
    .exec<{ message_id: string; emoji: string; member_id: string }>(
      `SELECT message_id, emoji, member_id FROM message_reactions
       WHERE message_id IN (${placeholders}) ORDER BY emoji, created_at, member_id`,
      ...messageIds,
    )
    .toArray();
  for (const row of rows) {
    const list = byMessage.get(row.message_id) ?? [];
    const existing = list.find((entry) => entry.emoji === row.emoji);
    if (existing) {
      (existing.memberIds as string[]).push(row.member_id);
    } else {
      list.push({ emoji: row.emoji, memberIds: [row.member_id] });
    }
    byMessage.set(row.message_id, list);
  }
  return byMessage;
}

export function readMentions(
  storage: DurableObjectStorage,
  messageIds: readonly string[],
): Map<string, MessageMention[]> {
  const byMessage = new Map<string, MessageMention[]>();
  if (messageIds.length === 0) return byMessage;
  const placeholders = messageIds.map(() => "?").join(", ");
  const rows = storage.sql
    .exec<{ message_id: string; kind: string; handle: string; resolved_id: string | null }>(
      `SELECT message_id, kind, handle, resolved_id FROM message_mentions
       WHERE message_id IN (${placeholders}) ORDER BY kind, handle`,
      ...messageIds,
    )
    .toArray();
  for (const row of rows) {
    const list = byMessage.get(row.message_id) ?? [];
    list.push({ kind: row.kind, handle: row.handle, resolvedId: row.resolved_id });
    byMessage.set(row.message_id, list);
  }
  return byMessage;
}

/** Attach reactions and mentions to a page in one pass per table. */
export function annotateMessages(
  storage: DurableObjectStorage,
  page: MessagePage,
): MessagePage {
  const ids = page.messages.map((message) => message.id);
  const reactions = readReactions(storage, ids);
  const mentions = readMentions(storage, ids);
  return {
    nextCursor: page.nextCursor,
    messages: page.messages.map((message) => ({
      ...message,
      reactions: reactions.get(message.id) ?? [],
      mentions: mentions.get(message.id) ?? [],
    })),
  };
}

export function replaceMentions(
  storage: DurableObjectStorage,
  messageId: string,
  mentions: readonly { kind: string; handle: string; resolvedId: string | null }[],
  now: number,
): void {
  storage.sql.exec("DELETE FROM message_mentions WHERE message_id = ?", messageId);
  for (const mention of mentions) {
    storage.sql.exec(
      `INSERT INTO message_mentions(message_id, kind, handle, resolved_id, created_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(message_id, kind, handle) DO NOTHING`,
      messageId,
      mention.kind,
      mention.handle,
      mention.resolvedId,
      now,
    );
  }
}

export function resolveMentionTargets(
  storage: DurableObjectStorage,
  mentions: readonly { kind: string; handle: string }[],
): { kind: string; handle: string; resolvedId: string | null }[] {
  return mentions.map((mention) => {
    if (mention.kind === "member") {
      const row = storage.sql
        .exec<{ id: string }>("SELECT id FROM members WHERE handle = ? AND status = 'active'", mention.handle)
        .toArray()[0];
      return { ...mention, resolvedId: row?.id ?? null };
    }
    if (mention.kind === "agent") {
      const row = storage.sql
        .exec<{ id: string }>("SELECT id FROM agents WHERE handle = ? AND status <> 'archived'", mention.handle)
        .toArray()[0];
      return { ...mention, resolvedId: row?.id ?? null };
    }
    if (mention.kind === "group") {
      const row = storage.sql
        .exec<{ id: string }>("SELECT id FROM groups WHERE handle = ?", mention.handle)
        .toArray()[0];
      return { ...mention, resolvedId: row?.id ?? null };
    }
    return { ...mention, resolvedId: null };
  });
}

export function applyMessageEdit(
  storage: DurableObjectStorage,
  messageId: string,
  bodyMarkdown: string,
  now: number,
): void {
  storage.sql.exec(
    `UPDATE messages SET body_markdown = ?, edited_at = ?, edit_count = edit_count + 1
     WHERE id = ? AND deleted_at IS NULL`,
    bodyMarkdown,
    now,
    messageId,
  );
}

/**
 * A delete removes the content, not the row. The tombstone keeps the thread
 * readable and the sequence intact; the body, its mentions and its reactions
 * are gone from reads and from any later search index.
 */
export function applyMessageDelete(
  storage: DurableObjectStorage,
  messageId: string,
  deletedByMemberId: string,
  now: number,
): void {
  storage.sql.exec(
    `UPDATE messages SET body_markdown = '', deleted_at = ?, deleted_by_member_id = ?
     WHERE id = ? AND deleted_at IS NULL`,
    now,
    deletedByMemberId,
    messageId,
  );
  storage.sql.exec("DELETE FROM message_mentions WHERE message_id = ?", messageId);
  storage.sql.exec("DELETE FROM message_reactions WHERE message_id = ?", messageId);
}

export function addReaction(
  storage: DurableObjectStorage,
  messageId: string,
  memberId: string,
  emoji: string,
  now: number,
): boolean {
  return (
    storage.sql.exec(
      `INSERT INTO message_reactions(message_id, member_id, emoji, created_at)
       VALUES (?, ?, ?, ?) ON CONFLICT(message_id, member_id, emoji) DO NOTHING`,
      messageId,
      memberId,
      emoji,
      now,
    ).rowsWritten > 0
  );
}

export function removeReaction(
  storage: DurableObjectStorage,
  messageId: string,
  memberId: string,
  emoji: string,
): boolean {
  return (
    storage.sql.exec(
      "DELETE FROM message_reactions WHERE message_id = ? AND member_id = ? AND emoji = ?",
      messageId,
      memberId,
      emoji,
    ).rowsWritten > 0
  );
}

/* -------------------------------------------------------------------------- */
/* Pins and saved items                                                        */
/* -------------------------------------------------------------------------- */

export function pinMessage(
  storage: DurableObjectStorage,
  channelId: string,
  messageId: string,
  memberId: string,
  now: number,
): boolean {
  return (
    storage.sql.exec(
      `INSERT INTO channel_pins(channel_id, message_id, pinned_by_member_id, pinned_at)
       VALUES (?, ?, ?, ?) ON CONFLICT(channel_id, message_id) DO NOTHING`,
      channelId,
      messageId,
      memberId,
      now,
    ).rowsWritten > 0
  );
}

export function unpinMessage(
  storage: DurableObjectStorage,
  channelId: string,
  messageId: string,
): boolean {
  return (
    storage.sql.exec(
      "DELETE FROM channel_pins WHERE channel_id = ? AND message_id = ?",
      channelId,
      messageId,
    ).rowsWritten > 0
  );
}

/** Pinned messages of one room, newest pin first. Deleted messages never appear. */
export function listPinnedMessages(
  storage: DurableObjectStorage,
  channelId: string,
  limit: number,
): MessageRow[] {
  return storage.sql
    .exec<RawMessage>(
      `SELECT ${MESSAGE_COLUMNS.split(",").map((column) => `m.${column.trim()}`).join(", ")}
       FROM channel_pins p JOIN messages m ON m.id = p.message_id
       WHERE p.channel_id = ? AND m.deleted_at IS NULL
       ORDER BY p.pinned_at DESC, m.id DESC LIMIT ?`,
      channelId,
      limit,
    )
    .toArray()
    .map(toMessage);
}

export function pinnedMessageIds(storage: DurableObjectStorage, channelId: string): Set<string> {
  return new Set(
    storage.sql
      .exec<{ message_id: string }>(
        "SELECT message_id FROM channel_pins WHERE channel_id = ?",
        channelId,
      )
      .toArray()
      .map((row) => row.message_id),
  );
}

export function saveMessageForMember(
  storage: DurableObjectStorage,
  memberId: string,
  messageId: string,
  now: number,
): boolean {
  return (
    storage.sql.exec(
      `INSERT INTO saved_items(member_id, message_id, saved_at) VALUES (?, ?, ?)
       ON CONFLICT(member_id, message_id) DO NOTHING`,
      memberId,
      messageId,
      now,
    ).rowsWritten > 0
  );
}

export function unsaveMessageForMember(
  storage: DurableObjectStorage,
  memberId: string,
  messageId: string,
): boolean {
  return (
    storage.sql.exec(
      "DELETE FROM saved_items WHERE member_id = ? AND message_id = ?",
      memberId,
      messageId,
    ).rowsWritten > 0
  );
}

/**
 * The raw saved pointers, newest first.
 *
 * These are pointers, not permissions. The caller must still decide, against the
 * room as it is now, whether each one may be read — a message saved from a room
 * the member has since left must not come back.
 */
export function listSavedPointers(
  storage: DurableObjectStorage,
  memberId: string,
  limit: number,
): { message: MessageRow; savedAt: number }[] {
  return storage.sql
    .exec<RawMessage & { saved_at: number }>(
      `SELECT ${MESSAGE_COLUMNS.split(",").map((column) => `m.${column.trim()}`).join(", ")}, s.saved_at
       FROM saved_items s JOIN messages m ON m.id = s.message_id
       WHERE s.member_id = ?
       ORDER BY s.saved_at DESC, m.id DESC LIMIT ?`,
      memberId,
      limit,
    )
    .toArray()
    .map((row) => ({ message: toMessage(row), savedAt: row.saved_at }));
}

export function savedMessageIds(storage: DurableObjectStorage, memberId: string): Set<string> {
  return new Set(
    storage.sql
      .exec<{ message_id: string }>("SELECT message_id FROM saved_items WHERE member_id = ?", memberId)
      .toArray()
      .map((row) => row.message_id),
  );
}
