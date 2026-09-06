import { classifyMentionHandle, type MentionKind } from "./mention-handle";

/**
 * Mention parsing over a message body.
 *
 * The prefix rules live in `mention-handle.ts` so the renderer and the write
 * path classify a handle exactly the same way.
 */

export { AGENT_PREFIX, GROUP_PREFIX, type MentionKind } from "./mention-handle";

export type Mention = {
  kind: MentionKind;
  /** Without the sigil, lowercased. Empty for `@channel` and `@here`. */
  handle: string;
  /** Byte offsets into the source, so a renderer can highlight in place. */
  start: number;
  end: number;
};

/**
 * The `@` must start a word. Without the lookbehind, the domain half of
 * `x@example.test` reads as a mention of `@example.test`.
 */
const MENTION = /(?<![A-Za-z0-9._@-])@([a-z0-9][a-z0-9._-]{0,63})/giu;

/**
 * Mentions inside code are text, not addresses. A snippet showing `@a.deploybot`
 * must not wake anything, which is why the code spans are removed before the
 * scan rather than filtered afterwards.
 */
export function maskCodeSpans(body: string): string {
  let masked = body.replaceAll(/```[\s\S]*?```/g, (block) => " ".repeat(block.length));
  masked = masked.replaceAll(/(^|[^`])`[^`\n]*`/g, (span, prefix: string) =>
    prefix + " ".repeat(span.length - prefix.length),
  );
  return masked;
}

/** Every mention in source order, deduplicated by kind and handle. */
export function parseMentions(body: string): Mention[] {
  const masked = maskCodeSpans(body);
  const seen = new Set<string>();
  const mentions: Mention[] = [];

  for (const match of masked.matchAll(MENTION)) {
    const raw = match[1];
    const start = match.index ?? 0;
    // A trailing separator is punctuation, not part of the name.
    const trimmed = raw.replace(/[._-]+$/, "");
    if (trimmed.length === 0) continue;
    const { kind, handle } = classifyMentionHandle(trimmed);
    const key = `${kind}:${handle}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mentions.push({ kind, handle, start, end: start + trimmed.length + 1 });
  }
  return mentions;
}

/** True when the message addresses everyone in the room, which is gated. */
export function isBroadcast(mentions: readonly Mention[]): boolean {
  return mentions.some((mention) => mention.kind === "channel" || mention.kind === "here");
}
