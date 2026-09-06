/**
 * Custom emoji names.
 *
 * A team's emoji are how its culture is encoded, so the naming rules have to be
 * boring and stable: one lowercase name, one meaning, forever. A name that
 * could be confused with another is a name that changes what old messages meant.
 */

export const MAX_EMOJI_NAME_LENGTH = 32;

const EMOJI_NAME = /^[a-z0-9][a-z0-9_+-]{0,31}$/;

/**
 * Normalise and validate a custom emoji name, with or without its colons.
 * Returns the bare name, or null when it is not a usable one.
 */
export function parseCustomEmojiName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const bare = value.trim().replace(/^:+|:+$/g, "").toLowerCase();
  if (bare.length === 0 || bare.length > MAX_EMOJI_NAME_LENGTH) return null;
  return EMOJI_NAME.test(bare) ? bare : null;
}

/** The `:name:` form a message or a reaction carries. */
export function toEmojiToken(name: string): string {
  return `:${name}:`;
}

/** True when a reaction value is the named form rather than a literal emoji. */
export function isEmojiToken(value: string): boolean {
  return value.startsWith(":") && value.endsWith(":") && value.length > 2;
}

const TOKEN = /:([a-z0-9][a-z0-9_+-]{0,31}):/g;

/**
 * Every custom emoji name a body refers to, deduplicated and in source order.
 * Used to resolve names for rendering; an unresolved name stays literal text.
 */
export function parseEmojiTokens(body: string): string[] {
  const seen = new Set<string>();
  for (const match of body.matchAll(TOKEN)) {
    const name = parseCustomEmojiName(match[1]);
    if (name !== null) seen.add(name);
  }
  return [...seen];
}
