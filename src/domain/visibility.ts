import type { ChannelKind } from "./rooms";

/**
 * The one visibility rule.
 *
 * The query path and the socket fan-out both call this. Two implementations of
 * a visibility rule eventually disagree, and the disagreement nobody notices is
 * the one where the socket is looser than the query.
 */

export type ChannelVisibility = {
  kind: ChannelKind;
  archivedAt: number | null;
  isMember: boolean;
};

/** An open room is readable by anyone in the workspace; anything else needs membership. */
export function canSeeChannel(channel: ChannelVisibility): boolean {
  return channel.kind === "public" || channel.isMember;
}

/** Seeing a room is not being in it, and an archived room takes no new writes. */
export function canPostInChannel(channel: ChannelVisibility): boolean {
  return canSeeChannel(channel) && channel.isMember && channel.archivedAt === null;
}

/**
 * A live event reaches exactly the sockets whose member could have read the
 * same thing through the query path.
 */
export function canReceiveChannelEvent(channel: ChannelVisibility): boolean {
  return canSeeChannel(channel);
}

/**
 * Unread is derived from a room's read cursor, and a room the member is not in
 * has no cursor to derive from. The reference app counted mentions in such rooms
 * as permanently unread, clearable only by writing to a membership row that did
 * not exist; this is the rule that keeps that from coming back.
 */
export function contributesToUnread(channel: ChannelVisibility): boolean {
  return channel.isMember && channel.archivedAt === null;
}
