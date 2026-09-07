import { describe, expect, it } from "vitest";

import {
  DELEGATION_DEFAULT_TTL_MS,
  SESSION_HARD_TTL_MS,
  SESSION_TOKEN_TTL_MS,
  delegationAllowsChannel,
  normalizeBoundedIds,
  normalizeSessionCapabilities,
  sessionAllowsTool,
  sessionTokenExpiresAt,
  validDelegationExpiry,
} from "./agent-session";

describe("A04 delegation and session rules", () => {
  it("AGENT-SESSION-RULE-001 accepts only explicit non-widening tool capabilities", () => {
    expect(normalizeSessionCapabilities(["agent_post", "read_thread", "agent_post"])).toEqual([
      "agent_post",
      "read_thread",
    ]);
    expect(sessionAllowsTool(["read_thread"], "read_thread")).toBe(true);
    expect(sessionAllowsTool(["read_thread"], "read_channel")).toBe(false);
    expect(() => normalizeSessionCapabilities(["post_message"])).toThrow("not allowed");
    expect(() => normalizeSessionCapabilities(["agent_set_prompt"])).toThrow("not allowed");
  });

  it("AGENT-SESSION-RULE-002 keeps delegation bounds finite and fail-closed", () => {
    expect(normalizeBoundedIds([" room-b ", "room-a", "room-a"], { nullable: true })).toEqual([
      "room-a",
      "room-b",
    ]);
    expect(normalizeBoundedIds(null, { nullable: true })).toBeNull();
    expect(delegationAllowsChannel(null, "room-any")).toBe(true);
    expect(delegationAllowsChannel(["room-a"], "room-b")).toBe(false);
    expect(() => normalizeBoundedIds([""], { nullable: false })).toThrow("non-empty");
  });

  it("AGENT-SESSION-RULE-003 applies rotation and absolute expiry boundaries", () => {
    const now = 1_800_000_000_000;
    expect(sessionTokenExpiresAt({ now, sessionHardExpiresAt: now + SESSION_HARD_TTL_MS, delegationExpiresAt: now + DELEGATION_DEFAULT_TTL_MS })).toBe(now + SESSION_TOKEN_TTL_MS);
    expect(sessionTokenExpiresAt({ now, sessionHardExpiresAt: now + 1_000, delegationExpiresAt: now + 2_000 })).toBe(now + 1_000);
    expect(validDelegationExpiry(now, now + DELEGATION_DEFAULT_TTL_MS)).toBe(true);
    expect(validDelegationExpiry(now, now + DELEGATION_DEFAULT_TTL_MS + 1)).toBe(false);
    expect(validDelegationExpiry(now, now)).toBe(false);
  });
});
