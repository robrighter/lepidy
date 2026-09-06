/**
 * How one `@` sigil addresses three kinds of principal.
 *
 * The prefix decides, not a lookup, so creating an agent or a group tomorrow
 * cannot retroactively change what a message sent today addressed.
 */

export type MentionKind = "member" | "agent" | "group" | "channel" | "here";

export const AGENT_PREFIX = "a.";
export const GROUP_PREFIX = "g.";

/** Recognised here; whether they are permitted is gated elsewhere. */
const BROADCAST = new Set(["channel", "here", "everyone"]);

export function classifyMentionHandle(handle: string): { kind: MentionKind; handle: string } {
  const lowered = handle.toLowerCase();
  if (BROADCAST.has(lowered)) {
    return { kind: lowered === "here" ? "here" : "channel", handle: "" };
  }
  if (lowered.startsWith(AGENT_PREFIX)) return { kind: "agent", handle: lowered };
  if (lowered.startsWith(GROUP_PREFIX)) return { kind: "group", handle: lowered };
  return { kind: "member", handle: lowered };
}

const AGENT_HANDLE = /^a\.[a-z0-9][a-z0-9._-]{0,30}$/;

/**
 * An agent handle always begins `a.`, and a person's handle never may.
 *
 * The prefix is what lets one `@` sigil address three kinds of principal with
 * no cross-table uniqueness check and no resolution tiebreak, and it is what
 * stops creating an agent from retroactively changing what an old message
 * addressed.
 */
export function parseAgentHandle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const bare = value.trim().toLowerCase().replace(/^@/, "");
  // A name already in another namespace is refused, not prefixed: turning
  // `g.fieldtechs` into `a.g.fieldtechs` would manufacture exactly the
  // confusable name the prefix rule exists to prevent.
  if (bare.startsWith(GROUP_PREFIX)) return null;
  const handle = bare.startsWith(AGENT_PREFIX) ? bare : `${AGENT_PREFIX}${bare}`;
  return AGENT_HANDLE.test(handle) ? handle : null;
}
