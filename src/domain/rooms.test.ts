import { describe, expect, it } from "vitest";

import {
  DEFAULT_HISTORY_PAGE,
  MAX_DIRECT_MESSAGE_PARTICIPANTS,
  MAX_HISTORY_PAGE,
  MAX_MESSAGE_LENGTH,
  clampHistoryLimit,
  directMessageIdentity,
  encodeHistoryCursor,
  parseChannelName,
  parseChannelSlug,
  parseChannelTopic,
  parseHistoryCursor,
  parseMessageBody,
  resolveThreadPlacement,
} from "./rooms";

describe("channel naming rules", () => {
  it("ROOM-RULE-001 normalises a slug so one room cannot be spelled two ways", () => {
    expect(parseChannelSlug("Release Notes")).toBe("release-notes");
    expect(parseChannelSlug("  RELEASE   notes  ")).toBe("release-notes");
    expect(parseChannelSlug("release-notes")).toBe("release-notes");
    expect(parseChannelSlug("eng")).toBe("eng");
    expect(parseChannelSlug("a")).toBe("a");
  });

  it("ROOM-RULE-002 refuses a slug that is empty, malformed, oversized or reserved", () => {
    for (const value of ["", "   ", "-eng", "eng-", ".eng", "eng.", "en g!", "#eng", "eng/ops"]) {
      expect(parseChannelSlug(value), value).toBeNull();
    }
    expect(parseChannelSlug("a".repeat(81))).toBeNull();
    expect(parseChannelSlug("a".repeat(80))).toBe("a".repeat(80));
    // The principal namespaces belong to agents and groups everywhere.
    expect(parseChannelSlug("a.releasebot")).toBeNull();
    expect(parseChannelSlug("g.fieldtechs")).toBeNull();
    expect(parseChannelSlug(42)).toBeNull();
  });

  it("ROOM-RULE-003 falls back to the slug for a name and flattens a topic", () => {
    expect(parseChannelName("  Release   Notes ", "release-notes")).toBe("Release Notes");
    expect(parseChannelName("   ", "release-notes")).toBe("release-notes");
    expect(parseChannelName(undefined, "release-notes")).toBe("release-notes");
    expect(parseChannelName("x".repeat(200), "fallback")).toHaveLength(120);
    expect(parseChannelTopic("what\nshipped\r\nthis week")).toBe("what shipped this week");
    expect(parseChannelTopic("   ")).toBeNull();
    expect(parseChannelTopic("x".repeat(400))).toHaveLength(250);
  });
});

describe("direct message identity", () => {
  it("ROOM-RULE-004 resolves one conversation whatever the order", () => {
    const first = directMessageIdentity(["member-b", "member-a"]);
    const second = directMessageIdentity(["member-a", "member-b"]);
    expect(first).not.toBeNull();
    expect(first!.key).toBe(second!.key);
    expect(first!.kind).toBe("dm");
    expect(first!.participantIds).toEqual(["member-a", "member-b"]);
    expect(first!.key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ROOM-RULE-005 separates a pair from a group and from a different group", () => {
    const pair = directMessageIdentity(["a", "b"])!;
    const group = directMessageIdentity(["a", "b", "c"])!;
    const other = directMessageIdentity(["a", "b", "d"])!;
    expect(group.kind).toBe("group_dm");
    expect(new Set([pair.key, group.key, other.key]).size).toBe(3);
  });

  it("ROOM-RULE-006 cannot be forged by splicing ids together", () => {
    // Without length prefixes, ["ab","c"] and ["a","bc"] would hash the same.
    expect(directMessageIdentity(["ab", "c"])!.key).not.toBe(directMessageIdentity(["a", "bc"])!.key);
  });

  it("ROOM-RULE-007 refuses a duplicate, a lone participant and an oversized group", () => {
    expect(directMessageIdentity(["a", "a"])).toBeNull();
    expect(directMessageIdentity(["a"])).toBeNull();
    expect(directMessageIdentity([])).toBeNull();
    expect(directMessageIdentity(["a", ""])).toBeNull();
    const tooMany = Array.from({ length: MAX_DIRECT_MESSAGE_PARTICIPANTS + 1 }, (_, i) => `m${i}`);
    expect(directMessageIdentity(tooMany)).toBeNull();
    expect(directMessageIdentity(tooMany.slice(0, MAX_DIRECT_MESSAGE_PARTICIPANTS))).not.toBeNull();
  });
});

describe("message body rules", () => {
  it("ROOM-RULE-008 keeps the whitespace a code block needs and drops the rest", () => {
    expect(parseMessageBody("  hello  ")).toBe("hello");
    expect(parseMessageBody("```\n\tindented\n```")).toBe("```\n\tindented\n```");
    expect(parseMessageBody("line\r\nbreak")).toBe("line\nbreak");
    // A terminal escape must not survive into a log, a CLI or a transcript.
    expect(parseMessageBody("safe\u001b[31mred\u0007")).toBe("safe[31mred");
    expect(parseMessageBody("null\u0000 byte")).toBe("null byte");
    expect(parseMessageBody("delete\u007f me")).toBe("delete me");
  });

  it("ROOM-RULE-009 refuses an empty or oversized body", () => {
    expect(parseMessageBody("")).toBeNull();
    expect(parseMessageBody("   \n\t ")).toBeNull();
    // A body of nothing but stripped control characters is not a message.
    expect(parseMessageBody("\u0000\u0001\u001f")).toBeNull();
    expect(parseMessageBody(null)).toBeNull();
    expect(parseMessageBody("x".repeat(MAX_MESSAGE_LENGTH))).toHaveLength(MAX_MESSAGE_LENGTH);
    expect(parseMessageBody("x".repeat(MAX_MESSAGE_LENGTH + 1))).toBeNull();
  });
});

describe("thread placement", () => {
  const parent = { id: "message-1", channelId: "channel-1", threadRootId: null, deletedAt: null };

  it("ROOM-RULE-010 keeps threads one level deep", () => {
    expect(resolveThreadPlacement(null, "channel-1")).toEqual({ kind: "channel" });
    expect(resolveThreadPlacement(parent, "channel-1")).toEqual({
      kind: "reply",
      threadRootId: "message-1",
    });
    // Replying to a reply attaches to the same root, never to the reply.
    expect(
      resolveThreadPlacement({ ...parent, id: "message-2", threadRootId: "message-1" }, "channel-1"),
    ).toEqual({ kind: "reply", threadRootId: "message-1" });
  });

  it("ROOM-RULE-011 refuses a parent in another room or a deleted one", () => {
    expect(resolveThreadPlacement(parent, "channel-2")).toEqual({
      kind: "invalid",
      reason: "thread parent belongs to another channel",
    });
    expect(resolveThreadPlacement({ ...parent, deletedAt: 5 }, "channel-1")).toEqual({
      kind: "invalid",
      reason: "thread parent was deleted",
    });
  });
});

describe("history paging", () => {
  it("ROOM-RULE-012 round-trips a cursor and refuses a malformed one", () => {
    const cursor = encodeHistoryCursor({ createdAt: 1_700_000_000_000, id: "message-1" });
    expect(parseHistoryCursor(cursor)).toEqual({ createdAt: 1_700_000_000_000, id: "message-1" });
    // An id containing the separator still round-trips: only the first one splits.
    const dotted = encodeHistoryCursor({ createdAt: 5, id: "a.b.c" });
    expect(parseHistoryCursor(dotted)).toEqual({ createdAt: 5, id: "a.b.c" });
    for (const value of ["", ".", "abc", "5.", "-1.message", "1e5.message", 7, null]) {
      expect(parseHistoryCursor(value), String(value)).toBeNull();
    }
  });

  it("ROOM-RULE-013 clamps a page size a caller asks for", () => {
    expect(clampHistoryLimit(undefined)).toBe(DEFAULT_HISTORY_PAGE);
    expect(clampHistoryLimit(0)).toBe(DEFAULT_HISTORY_PAGE);
    expect(clampHistoryLimit(-5)).toBe(DEFAULT_HISTORY_PAGE);
    expect(clampHistoryLimit(2.5)).toBe(DEFAULT_HISTORY_PAGE);
    expect(clampHistoryLimit(10)).toBe(10);
    expect(clampHistoryLimit(10_000)).toBe(MAX_HISTORY_PAGE);
  });
});
