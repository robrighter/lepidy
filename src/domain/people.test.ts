import { describe, expect, it } from "vitest";
import {
  buildMentionCards,
  formatLocalTime,
  formatWorkingHours,
  mayAdministerMember,
  parseAvailability,
  resolvePresence,
  ownershipTransferConfirmation,
  parseGroupHandle,
  parseProfile,
  planGroupMention,
} from "./people";

describe("people and administration rules", () => {
  it("C07-RULE-001 reserves and normalizes the group namespace", () => {
    expect(parseGroupHandle(" @G.Platform ")).toBe("g.platform");
    expect(() => parseGroupHandle("g.here")).toThrow("reserved");
    expect(() => parseGroupHandle("g..platform")).toThrow("single separators");
  });

  it("C07-RULE-002 validates profiles and paired working hours", () => {
    expect(parseProfile({ displayName: " Maya  Chen ", timezone: "America/New_York" }).displayName).toBe("Maya Chen");
    expect(() => parseProfile({ displayName: "Maya", timezone: "Mars/Olympus" })).toThrow("IANA");
    expect(() => parseProfile({ displayName: "Maya", workingStartMinute: 540 })).toThrow("both");
  });

  it("C07-RULE-003 keeps role administration fail-closed", () => {
    expect(mayAdministerMember({ actorRole: "admin", actorId: "a", targetRole: "member", targetId: "m", nextRole: "guest" })).toBe(true);
    expect(mayAdministerMember({ actorRole: "admin", actorId: "a", targetRole: "owner", targetId: "o", nextRole: "member" })).toBe(false);
    expect(mayAdministerMember({ actorRole: "member", actorId: "m", targetRole: "guest", targetId: "g" })).toBe(false);
  });

  it("C07-RULE-004 bounds deterministic group fan-out", () => {
    expect(planGroupMention({ memberIds: ["b", "a", "b", "sender"], senderId: "sender" })).toEqual(["a", "b"]);
    expect(() => planGroupMention({ memberIds: [], senderId: "sender" })).toThrow("no active members");
    expect(() => planGroupMention({ memberIds: Array.from({ length: 51 }, (_, index) => `m${index}`), senderId: "sender" })).toThrow("limit is 50");
  });

  it("C07-RULE-005 binds ownership transfer to a visible target", () => {
    expect(ownershipTransferConfirmation("lee")).toBe("transfer ownership to @lee");
  });

  it("C07-RULE-006 lets a declared availability outrank an open connection", () => {
    expect(parseAvailability("focus")).toBe("focus");
    expect(parseAvailability("")).toBe("auto");
    expect(parseAvailability(undefined)).toBe("auto");
    expect(() => parseAvailability("invisible")).toThrow("auto, focus or away");
    // Saying "heads-down" has to survive having tabs open, or saying it is worthless.
    expect(resolvePresence("focus", true)).toBe("focus");
    expect(resolvePresence("away", true)).toBe("away");
    expect(resolvePresence("auto", true)).toBe("online");
    expect(resolvePresence("auto", false)).toBe("offline");
  });

  it("C07-RULE-007 states another person's own clock or says it is unset", () => {
    const noon = new Date("2026-03-01T12:00:00.000Z");
    expect(formatLocalTime("Europe/Berlin", noon)).toBe("Europe/Berlin · 13:00");
    expect(formatLocalTime(null, noon)).toBe("Timezone not set");
    // A zone this runtime cannot resolve must not silently fall back to the
    // reader's own clock and be read as the other person's.
    expect(formatLocalTime("Mars/Olympus", noon)).toBe("Timezone not set");
    expect(formatWorkingHours(540, 1050)).toBe("09:00–17:30");
    expect(formatWorkingHours(540, null)).toBe("Working hours not set");
  });

  it("C07-RULE-008 builds hovercards only from a directory the reader already has", () => {
    const now = new Date("2026-03-01T12:00:00.000Z");
    const cards = buildMentionCards({
      people: [
        {
          id: "m1", handle: "maya", displayName: "Maya Chen", role: "admin", status: "active",
          title: "Engineering", customStatus: "Shipping the payments fix", timezone: "Europe/Berlin",
          workingStartMinute: 540, workingEndMinute: 1050, presence: "online", ownedAgentCount: 2,
        },
        {
          id: "m2", handle: "sam", displayName: "Sam Ortiz", role: "member", status: "removed",
          title: null, customStatus: null, timezone: null,
          workingStartMinute: null, workingEndMinute: null, presence: "offline", ownedAgentCount: 0,
        },
      ],
      groups: [
        { handle: "g.platform", displayName: "Platform", description: "Runtime and storage", memberIds: ["m1", "m2", "ghost"] },
        { handle: "g.empty", displayName: "Empty", description: null, memberIds: [] },
      ],
    }, now);

    const maya = cards.get("maya");
    expect(maya).toMatchObject({ kind: "member", title: "Maya Chen", subtitle: "admin · Engineering", status: "Shipping the payments fix" });
    expect(maya?.facts).toEqual(["Active", "Europe/Berlin · 13:00", "09:00–17:30", "2 agents"]);

    // A tombstone says so rather than presenting a former member as merely offline.
    expect(cards.get("sam")?.facts[0]).toBe("No longer in this workspace");

    // A group names who it would actually reach, and an id with no visible
    // member contributes nobody rather than an empty name.
    expect(cards.get("g.platform")).toMatchObject({ kind: "group", subtitle: "2 active members" });
    expect(cards.get("g.platform")?.facts).toEqual(["Maya Chen, Sam Ortiz"]);
    expect(cards.get("g.empty")?.facts).toEqual(["This group has no active members"]);

    // Nothing is invented for a handle the reader was not given.
    expect(cards.get("nobody")).toBeUndefined();
  });

  it("C07-RULE-009 names an agent's owners on its mention card and never hides one", () => {
    const cards = buildMentionCards({
      people: [{
        id: "m1", handle: "maya", displayName: "Maya Chen", role: "admin", status: "active",
        title: null, customStatus: null, timezone: null, workingStartMinute: null, workingEndMinute: null,
        presence: "online", ownedAgentCount: 1,
      }],
      groups: [],
      agents: [
        { handle: "a.triage", displayName: "Triage", description: "Sorts the queue", status: "active", ownerIds: ["m1", "hidden"] },
        { handle: "a.paused", displayName: "Paused", description: null, status: "paused", ownerIds: [] },
      ],
    }, new Date("2026-03-01T12:00:00.000Z"));

    // An owner this reader cannot name is still counted: mentioning an agent
    // hands the message to every owner, so under-reporting the list is the one
    // failure this card exists to prevent.
    expect(cards.get("a.triage")).toMatchObject({ kind: "agent", title: "Triage", subtitle: "agent", status: "Sorts the queue" });
    expect(cards.get("a.triage")?.facts).toEqual(["Owned by Maya Chen, 1 more"]);
    expect(cards.get("a.paused")).toMatchObject({ subtitle: "agent · paused" });
    expect(cards.get("a.paused")?.facts).toEqual(["Nobody owns this agent"]);
  });
});
