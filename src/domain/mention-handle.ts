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
