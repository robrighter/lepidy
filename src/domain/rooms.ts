import { createHash } from "node:crypto";

/**
 * Pure room, membership and message rules.
 *
 * These decide what a channel may be called, which conversation a set of people
 * resolves to, and what counts as a postable message. They are separated from
 * storage because both the cloud workspace object and the Solo host must reach
 * the same answer for the same input.
 */

export type ChannelKind = "public" | "private" | "dm" | "group_dm";

export const MAX_CHANNEL_SLUG_LENGTH = 80;
export const MAX_CHANNEL_NAME_LENGTH = 120;
export const MAX_CHANNEL_TOPIC_LENGTH = 250;
export const MAX_MESSAGE_LENGTH = 16_000;
/** A group DM past this size is a channel that nobody named. */
export const MAX_DIRECT_MESSAGE_PARTICIPANTS = 8;

const CHANNEL_SLUG = /^[a-z0-9]$|^[a-z0-9][a-z0-9._-]{0,78}[a-z0-9]$/;

/**
 * Channel slugs are normalised before validation so `#Release Notes` and
 * `#release-notes` cannot become two different rooms that look identical in a
 * sidebar.
 */
export function parseChannelSlug(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalised = value.trim().normalize("NFKC").toLowerCase().replaceAll(/\s+/g, "-");
  if (normalised.length === 0 || normalised.length > MAX_CHANNEL_SLUG_LENGTH) return null;
  if (!CHANNEL_SLUG.test(normalised)) return null;
  // The principal namespaces are reserved everywhere a name is chosen.
  if (normalised.startsWith("a.") || normalised.startsWith("g.")) return null;
  return normalised;
}

export function parseChannelName(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().normalize("NFKC").replaceAll(/\s+/g, " ");
  if (trimmed.length === 0) return fallback;
  return trimmed.slice(0, MAX_CHANNEL_NAME_LENGTH);
}

export function parseChannelTopic(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().normalize("NFKC").replaceAll(/[\r\n]+/g, " ");
  return trimmed.length === 0 ? null : trimmed.slice(0, MAX_CHANNEL_TOPIC_LENGTH);
}

/* -------------------------------------------------------------------------- */
/* Direct messages                                                             */
/* -------------------------------------------------------------------------- */

export type DirectMessageIdentity = {
  kind: "dm" | "group_dm";
  key: string;
  participantIds: readonly string[];
};

/**
 * One conversation per set of people, whoever opens it and in whatever order.
 * The key is a digest of the sorted participant ids so it stays a bounded column
 * value however large the group is, and so the ids themselves are not what a
 * unique index is built from.
 */
export function directMessageIdentity(
  participantIds: readonly string[],
): DirectMessageIdentity | null {
  const unique = [...new Set(participantIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (unique.length !== participantIds.length) return null;
  if (unique.length < 2 || unique.length > MAX_DIRECT_MESSAGE_PARTICIPANTS) return null;
  const sorted = [...unique].sort();
  const key = createHash("sha256")
    .update(`lepidy.dm.v1|${sorted.map((id) => `${id.length}:${id}`).join("|")}`, "utf8")
    .digest("hex");
  return { kind: sorted.length === 2 ? "dm" : "group_dm", key, participantIds: sorted };
}

/* -------------------------------------------------------------------------- */
/* Messages                                                                    */
/* -------------------------------------------------------------------------- */

/** Control characters that carry no meaning in Markdown and can corrupt a log. */
const FORBIDDEN_CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Message bodies are Markdown. Tabs and newlines survive because a code block
 * needs them; the remaining control characters are stripped so a body cannot
 * smuggle terminal escapes into a log, a CLI or an agent's transcript.
 */
export function parseMessageBody(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .normalize("NFC")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll(FORBIDDEN_CONTROL_CHARACTERS, "");
  const trimmed = cleaned.replace(/^\s+|\s+$/g, "");
  if (trimmed.length === 0 || trimmed.length > MAX_MESSAGE_LENGTH) return null;
  return trimmed;
}

export type ThreadPlacement =
  | { kind: "channel" }
  | { kind: "reply"; threadRootId: string }
  | { kind: "invalid"; reason: string };

/**
 * Threads are one level deep. Replying to a reply attaches to the same root, so
 * a conversation can never fork into a tree nobody can read.
 */
export function resolveThreadPlacement(
  parent: { id: string; channelId: string; threadRootId: string | null; deletedAt: number | null } | null,
  channelId: string,
): ThreadPlacement {
  if (parent === null) return { kind: "channel" };
  if (parent.channelId !== channelId) {
    return { kind: "invalid", reason: "thread parent belongs to another channel" };
  }
  if (parent.deletedAt !== null) {
    return { kind: "invalid", reason: "thread parent was deleted" };
  }
  return { kind: "reply", threadRootId: parent.threadRootId ?? parent.id };
}

/* -------------------------------------------------------------------------- */
/* History cursors                                                             */
/* -------------------------------------------------------------------------- */

export type HistoryCursor = { createdAt: number; id: string };

export const MAX_HISTORY_PAGE = 100;
export const DEFAULT_HISTORY_PAGE = 50;

export function encodeHistoryCursor(cursor: HistoryCursor): string {
  return `${cursor.createdAt}.${cursor.id}`;
}

/** A cursor is opaque to callers, so an unparseable one is refused, not guessed. */
export function parseHistoryCursor(value: unknown): HistoryCursor | null {
  if (typeof value !== "string") return null;
  const separator = value.indexOf(".");
  if (separator <= 0) return null;
  const timestamp = value.slice(0, separator);
  const id = value.slice(separator + 1);
  // Plain digits only, so a cursor has exactly one spelling and re-encoding it
  // reproduces the string the caller was given.
  if (!/^\d+$/.test(timestamp) || id.length === 0) return null;
  const createdAt = Number(timestamp);
  if (!Number.isSafeInteger(createdAt)) return null;
  return { createdAt, id };
}

export function clampHistoryLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return DEFAULT_HISTORY_PAGE;
  return Math.min(value, MAX_HISTORY_PAGE);
}

/**
 * A reaction is a short grapheme cluster, not arbitrary text. Named custom
 * emoji arrive with C05 and use the same colon form; this keeps the column from
 * becoming a second, unindexed message body in the meantime.
 */
export function parseReactionEmoji(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 32) return null;
  if (/[\u0000-\u001F\u007F\s]/.test(trimmed)) return null;
  if (/^:[a-z0-9][a-z0-9_+-]{0,30}:$/.test(trimmed)) return trimmed;
  return /\p{Extended_Pictographic}/u.test(trimmed) ? trimmed : null;
}
