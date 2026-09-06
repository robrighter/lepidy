import { contributesToUnread, type ChannelVisibility } from "./visibility";

/**
 * Read state is a server-side cursor per member per room, so reading on the
 * phone marks it read on the laptop. These are the rules that decide what is
 * unread; they are pure because a rule that lives inside the send path is a rule
 * nothing on the merge path checks.
 */

export const PRESENCE_TTL_MS = 45_000;
export const TYPING_TTL_MS = 6_000;

/**
 * A cursor only ever moves forward, and never past what exists. A reordered or
 * replayed acknowledgement from a second device cannot un-read a room.
 */
export function advanceReadCursor(current: number, requested: number, latest: number): number {
  if (!Number.isSafeInteger(requested) || requested < 0) return current;
  return Math.max(current, Math.min(requested, latest));
}

export type ChannelUnreadFacts = ChannelVisibility & {
  channelId: string;
  latestSequence: number;
  lastReadSequence: number;
};

export type ChannelUnread = { channelId: string; unread: number };

export function unreadCount(facts: ChannelUnreadFacts): number {
  if (!contributesToUnread(facts)) return 0;
  return Math.max(0, facts.latestSequence - facts.lastReadSequence);
}

export type UnreadSummary = {
  channels: readonly ChannelUnread[];
  total: number;
};

/** Rooms with nothing unread are omitted, so an idle workspace sends an empty list. */
export function summariseUnread(rooms: readonly ChannelUnreadFacts[]): UnreadSummary {
  const channels: ChannelUnread[] = [];
  let total = 0;
  for (const room of rooms) {
    const unread = unreadCount(room);
    if (unread === 0) continue;
    channels.push({ channelId: room.channelId, unread });
    total += unread;
  }
  return { channels, total };
}

export function isPresenceFresh(lastSeenAt: number, now: number, ttlMs = PRESENCE_TTL_MS): boolean {
  return now - lastSeenAt < ttlMs;
}

export function isTypingFresh(startedAt: number, now: number, ttlMs = TYPING_TTL_MS): boolean {
  return now - startedAt < ttlMs;
}
