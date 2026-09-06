import { describe, expect, it } from "vitest";

import {
  PRESENCE_TTL_MS,
  TYPING_TTL_MS,
  advanceReadCursor,
  isPresenceFresh,
  isTypingFresh,
  summariseUnread,
  unreadCount,
  type ChannelUnreadFacts,
} from "./read-state";
import { canPostInChannel, canSeeChannel, contributesToUnread } from "./visibility";

function room(overrides: Partial<ChannelUnreadFacts> = {}): ChannelUnreadFacts {
  return {
    channelId: "channel-1",
    kind: "public",
    archivedAt: null,
    isMember: true,
    latestSequence: 10,
    lastReadSequence: 4,
    ...overrides,
  };
}

describe("channel visibility", () => {
  it("READ-RULE-001 opens public rooms to everyone and closes the rest to non-members", () => {
    expect(canSeeChannel({ kind: "public", archivedAt: null, isMember: false })).toBe(true);
    expect(canSeeChannel({ kind: "private", archivedAt: null, isMember: false })).toBe(false);
    expect(canSeeChannel({ kind: "private", archivedAt: null, isMember: true })).toBe(true);
    expect(canSeeChannel({ kind: "dm", archivedAt: null, isMember: false })).toBe(false);
    expect(canSeeChannel({ kind: "group_dm", archivedAt: null, isMember: true })).toBe(true);
  });

  it("READ-RULE-002 separates seeing a room from posting in it", () => {
    // Visible without membership, but not postable until you join.
    expect(canPostInChannel({ kind: "public", archivedAt: null, isMember: false })).toBe(false);
    expect(canPostInChannel({ kind: "public", archivedAt: null, isMember: true })).toBe(true);
    // Archived stays readable and stops taking writes.
    expect(canSeeChannel({ kind: "public", archivedAt: 5, isMember: true })).toBe(true);
    expect(canPostInChannel({ kind: "public", archivedAt: 5, isMember: true })).toBe(false);
  });
});

describe("read cursors", () => {
  it("READ-RULE-003 only ever moves a cursor forward", () => {
    expect(advanceReadCursor(4, 7, 10)).toBe(7);
    // A reordered acknowledgement from a second device cannot un-read a room.
    expect(advanceReadCursor(7, 4, 10)).toBe(7);
    expect(advanceReadCursor(7, 7, 10)).toBe(7);
  });

  it("READ-RULE-004 never moves a cursor past what exists", () => {
    expect(advanceReadCursor(0, 999, 10)).toBe(10);
    expect(advanceReadCursor(0, 0, 0)).toBe(0);
  });

  it("READ-RULE-005 ignores a cursor that is not a whole non-negative number", () => {
    for (const requested of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(advanceReadCursor(4, requested, 10), String(requested)).toBe(4);
    }
  });
});

describe("unread derivation", () => {
  it("READ-RULE-006 counts what a member has not read in a room they are in", () => {
    expect(unreadCount(room())).toBe(6);
    expect(unreadCount(room({ lastReadSequence: 10 }))).toBe(0);
    // A cursor ahead of the room cannot produce a negative count.
    expect(unreadCount(room({ lastReadSequence: 14 }))).toBe(0);
  });

  it("READ-RULE-007 counts nothing in a room the member is not in", () => {
    // The reference app counted mentions in non-member rooms as permanently
    // unread, clearable only by writing to a membership row that did not exist.
    expect(contributesToUnread({ kind: "public", archivedAt: null, isMember: false })).toBe(false);
    expect(unreadCount(room({ isMember: false }))).toBe(0);
    expect(unreadCount(room({ isMember: false, lastReadSequence: 0 }))).toBe(0);
  });

  it("READ-RULE-008 counts nothing in an archived room", () => {
    expect(unreadCount(room({ archivedAt: 5 }))).toBe(0);
  });

  it("READ-RULE-009 omits rooms with nothing unread from the summary", () => {
    const summary = summariseUnread([
      room({ channelId: "a" }),
      room({ channelId: "b", lastReadSequence: 10 }),
      room({ channelId: "c", isMember: false, lastReadSequence: 0 }),
      room({ channelId: "d", latestSequence: 3, lastReadSequence: 1 }),
    ]);
    expect(summary.channels).toEqual([
      { channelId: "a", unread: 6 },
      { channelId: "d", unread: 2 },
    ]);
    expect(summary.total).toBe(8);
    expect(summariseUnread([])).toEqual({ channels: [], total: 0 });
  });
});

describe("ephemeral freshness", () => {
  it("READ-RULE-010 expires presence and typing at their own boundaries", () => {
    const now = 1_800_000_000_000;
    expect(isPresenceFresh(now - PRESENCE_TTL_MS + 1, now)).toBe(true);
    expect(isPresenceFresh(now - PRESENCE_TTL_MS, now)).toBe(false);
    expect(isTypingFresh(now - TYPING_TTL_MS + 1, now)).toBe(true);
    expect(isTypingFresh(now - TYPING_TTL_MS, now)).toBe(false);
    // Typing goes stale long before presence does.
    expect(TYPING_TTL_MS).toBeLessThan(PRESENCE_TTL_MS);
  });
});
