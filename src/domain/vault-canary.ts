/**
 * Scan targets and canary credentials (V08, PRD §8.8).
 *
 * Two different tripwires with two different threat models, kept in one file
 * because they are easy to confuse and the difference is the whole point.
 *
 * **A scan target** lets a *client* answer "does this text contain a value the
 * vault holds" without the value leaving the vault. The workspace stores a
 * digest of the value and its length; a client walks its text a window at a
 * time and compares. That is exactly the shape Agent Vault's `scan` used over
 * its local socket, and adapting it to a hosted vault changes what may be
 * claimed:
 *
 * - It detects an **exact, whole, unencoded** value. A base64'd, JSON-escaped,
 *   per-character-split or partially quoted secret goes straight through. The
 *   one-hash-per-value design cannot detect a substring, and nothing in the
 *   product may say otherwise.
 * - The digest is a **verifier for that exact value**. Anyone holding it can
 *   confirm a guess offline, so a low-entropy credential is guessable if the
 *   database or a client's cache leaks — which the ciphertext alone is not.
 *   That is why a digest is opt-out, why nothing below the minimum length gets
 *   one at all, and why it is served only over the signed device transport to a
 *   member who already holds a verb on the credential.
 * - The digest is bound to workspace, credential and version, so it cannot be
 *   tested against a value in another workspace or against an earlier version.
 *
 * **A canary** is the opposite trade. Its value is generated to be recognisable
 * — a public marker plus a random tag — so the *workspace* can spot it in the
 * content it already receives without holding any secret at all. It is a fake
 * credential that exists to be stolen: nothing legitimate ever sends one, so
 * its appearance in a message, a tool argument or a proxied request body means
 * something carried it out of the injection path.
 */

/**
 * The public half of a canary value.
 *
 * A marker is not a secret. It is stored in cleartext metadata precisely so the
 * workspace can look for it in a string without a key, and a member who can see
 * the credential can see it. Somebody could therefore trip a canary on purpose;
 * that costs nothing, because a canary is never a working credential and a trip
 * refuses one write and tells its custodians.
 */
export const CANARY_PREFIX = "lpdy-canary-";
export const CANARY_TAG_LENGTH = 12;
export const CANARY_RANDOM_LENGTH = 32;
/** Lowercase alphanumerics only, so a canary survives a shell, a URL and JSON unchanged. */
const CANARY_ALPHABET = /^[0-9a-z]+$/u;

export function canaryMarkerFor(tag: string): string {
  if (tag.length !== CANARY_TAG_LENGTH || !CANARY_ALPHABET.test(tag)) {
    throw new Error("a canary tag is twelve lowercase alphanumerics");
  }
  return `${CANARY_PREFIX}${tag}`;
}

export function normalizeCanaryMarker(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith(CANARY_PREFIX)) {
    throw new Error("a canary marker is invalid");
  }
  return canaryMarkerFor(value.slice(CANARY_PREFIX.length));
}

/** The whole fake credential: marker, a separator, and enough random to look real. */
export function canaryValue(tag: string, random: string): string {
  if (random.length !== CANARY_RANDOM_LENGTH || !CANARY_ALPHABET.test(random)) {
    throw new Error("a canary value needs thirty-two lowercase alphanumerics");
  }
  return `${canaryMarkerFor(tag)}-${random}`;
}

/**
 * Which canaries appear in this text.
 *
 * A plain substring search, deliberately. Matching the marker rather than the
 * whole value keeps this synchronous — it runs inside the same call that is
 * about to write a message — and costs nothing in confidence: a twelve-character
 * random tag behind a fixed prefix does not occur by accident, and a leak that
 * carried the marker carried the value it is part of.
 *
 * Order follows `markers` so a caller's message lists names the way it listed
 * them, and each marker is reported once however often it appears.
 */
export function findCanaryMarkers<T extends { marker: string }>(
  text: string,
  markers: readonly T[],
): readonly T[] {
  if (text.length === 0 || markers.length === 0) return [];
  return markers.filter((candidate) => text.includes(candidate.marker));
}

/** What an agent is told when a canary stopped its write. */
export function canaryRefusalHint(names: readonly string[]): string {
  const listed = names.join(", ");
  return (
    `This write contains ${listed}, which is a canary credential: a deliberately fake value that exists ` +
    "to detect a credential leaving the injection path. It was refused and the credential's custodians have been told. " +
    "Do not try to send it another way, and do not look for the real credential in files, shell configuration or chat — " +
    "run the command through `lepidy run --with <NAME> -- <command>` instead."
  );
}

/**
 * A scan target: the digest of one credential value and its length.
 *
 * Below this length a digest is not stored at all. Short values are both the
 * ones a verifier makes cheapest to guess and the ones a window scan matches by
 * accident, so the two reasons agree.
 */
export const SCAN_MIN_VALUE_LENGTH = 8;
/** The whole text a scan may walk, so a `pre-commit` hook on a large file stays bounded. */
export const SCAN_MAX_TEXT_BYTES = 4 * 1024 * 1024;

export const SCAN_DIGEST_CONTEXT = "lepidy-scan-v1";

/**
 * What is hashed to produce a scan digest.
 *
 * The context line binds the digest to one credential version in one workspace.
 * Both the Rust client that computes it at seal time and any test that checks
 * one build this same string, so a digest lifted from elsewhere never matches.
 */
export function scanDigestPreimage(input: {
  workspaceId: string;
  credentialId: string;
  version: number;
  value: string;
}): string {
  if (!Number.isSafeInteger(input.version) || input.version < 1) throw new Error("a scan digest needs a credential version");
  return `${SCAN_DIGEST_CONTEXT}\n${input.workspaceId}\n${input.credentialId}\n${input.version}\n${input.value}`;
}

const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/u;

export function validateScanDigest(value: unknown): string {
  if (typeof value !== "string" || !BASE64URL_32.test(value)) throw new Error("a scan digest is invalid");
  return value;
}

export function validateScanLength(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < SCAN_MIN_VALUE_LENGTH || (value as number) > 8192) {
    throw new Error("a scan length is invalid");
  }
  return value as number;
}

export type ScanTarget = { digest: string; length: number };

/** A seal-time scan target, or nothing at all. Both halves or neither. */
export function normalizeScanTarget(value: ScanTarget | undefined): ScanTarget | null {
  if (value === undefined) return null;
  return { digest: validateScanDigest(value.digest), length: validateScanLength(value.length) };
}
