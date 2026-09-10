/**
 * What may be sent to a push service, and what a push may say.
 *
 * Two properties shape everything here.
 *
 * **A push endpoint is client-supplied.** The browser gives it to the page and
 * the page gives it to us, so it is attacker-influenced input that this Worker
 * will later make an outbound request to. It goes through the same public-egress
 * guard the custom runtime callback uses, for the same reason.
 *
 * **A push payload is rendered by the operating system.** It appears on a lock
 * screen, in a notification centre, and in whatever the platform decides to sync
 * it to. The payload is encrypted end to end, so the push service cannot read
 * it — but the *device* shows it to whoever is holding it. So Lepidy sends
 * identifiers, never content: the service worker fetches the words to display
 * with the viewer's own session, which also means visibility is rechecked at
 * the moment of display rather than at the moment of send.
 *
 * That second rule is C06's, not this task's. C06 deliberately wrote only
 * recipient, message and channel identifiers into the outbox and left transport
 * here; sending content now would quietly undo the decision it made.
 */

/** A subscription as the browser produced it. */
export type PushSubscriptionInput = {
  endpoint: string;
  /** The subscription's public key, an uncompressed P-256 point. */
  p256dh: string;
  /** The subscription's authentication secret. */
  auth: string;
};

export type ValidatedSubscription = PushSubscriptionInput & {
  /** The push service's origin, which is the audience of the VAPID token. */
  audience: string;
};

/** An uncompressed P-256 point is `0x04` and two 32-byte coordinates. */
const P256DH_BYTES = 65;
/** RFC 8291 fixes the authentication secret at 16 bytes. */
const AUTH_BYTES = 16;

export function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("push key is not base64url");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Check a subscription's shape before it is ever stored.
 *
 * Shape only: whether the push service will accept it is the push service's
 * answer, and we find that out on the first send. What this refuses is a
 * subscription that could never work, or one whose endpoint is pointing
 * somewhere it should not be — the host itself is resolved and checked at send
 * time by the egress guard, because DNS can change between the two.
 */
export function validateSubscription(input: PushSubscriptionInput): ValidatedSubscription {
  const url = new URL(input.endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("a push endpoint must be uncredentialed HTTPS");
  }
  if (decodeBase64Url(input.p256dh).length !== P256DH_BYTES) {
    throw new Error("a push subscription key must be an uncompressed P-256 point");
  }
  if (decodeBase64Url(input.auth).length !== AUTH_BYTES) {
    throw new Error("a push authentication secret must be 16 bytes");
  }
  return { ...input, audience: url.origin };
}

/* -------------------------------------------------------------------------- */
/* What a push says                                                            */
/* -------------------------------------------------------------------------- */

export type PushKind = "message" | "approval";

/**
 * The whole payload. Identifiers and a destination, and nothing else.
 *
 * There is deliberately no field for a title, a body, a credential name or a
 * message. Adding one would be the moment somebody's lock screen started
 * carrying another person's words, and it would undo C06's metadata-only
 * outbox without any test noticing — so the shape is validated, and a payload
 * carrying an unexpected key is refused rather than trimmed.
 */
export type PushPayload = {
  v: 1;
  kind: PushKind;
  /** The message or approval this is about. The device fetches the rest. */
  id: string;
  /** Where activating it leads, as a rooted path on this workspace. */
  path: string;
};

const ALLOWED_KEYS = new Set(["v", "kind", "id", "path"]);

export function buildPushPayload(kind: PushKind, id: string, path: string): PushPayload {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id)) throw new Error("push subject is not an identifier");
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("://")) {
    throw new Error("a push destination must be a rooted path on this workspace");
  }
  return { v: 1, kind, id, path };
}

/**
 * Refuse a payload that grew a field.
 *
 * Called on the way out, so the rule is enforced against the object actually
 * being encrypted rather than against the function that was supposed to have
 * built it.
 */
export function assertMetadataOnly(payload: object): void {
  for (const key of Object.keys(payload)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`a push payload may not carry ${key}: content is fetched by the device`);
    }
  }
}

/**
 * How long a push service should keep trying to deliver this.
 *
 * An approval that expires in five minutes is noise after that: waking somebody
 * to decide something already decided is how a person learns to ignore the
 * notification that mattered. A mention has no deadline, so it keeps for a day.
 */
export function pushTtlSeconds(kind: PushKind, expiresAt: number | null, now: number): number {
  if (kind === "approval") {
    const remaining = Math.floor(((expiresAt ?? now) - now) / 1000);
    return Math.max(0, Math.min(remaining, 300));
  }
  return 86_400;
}

/** Approvals wake a device; mentions do not. */
export function pushUrgency(kind: PushKind): "high" | "normal" {
  return kind === "approval" ? "high" : "normal";
}

/* -------------------------------------------------------------------------- */
/* VAPID                                                                       */
/* -------------------------------------------------------------------------- */

export type VapidClaims = { aud: string; exp: number; sub: string };

/** The longest a VAPID token may be valid. Push services cap this at 24 hours. */
const MAX_VAPID_LIFETIME_S = 12 * 60 * 60;

/**
 * The claims identifying this Lepidy deployment to a push service.
 *
 * The audience is the push service's **origin**, not the endpoint: a token
 * scoped to a whole endpoint URL would leak which subscription it was for to
 * any service that logged it, and the specification asks for the origin anyway.
 */
export function vapidClaims(audience: string, subject: string, now: number): VapidClaims {
  const origin = new URL(audience).origin;
  if (!subject.startsWith("mailto:") && !subject.startsWith("https://")) {
    throw new Error("a VAPID subject must be a mailto: or https: contact");
  }
  return {
    aud: origin,
    exp: Math.floor(now / 1000) + MAX_VAPID_LIFETIME_S,
    sub: subject,
  };
}

/* -------------------------------------------------------------------------- */
/* What a push service's answer means                                          */
/* -------------------------------------------------------------------------- */

export type SendOutcome =
  | { status: "delivered" }
  | { status: "retry"; error: string }
  | { status: "permanent"; error: string }
  /** The subscription is gone. Delete it rather than retrying forever. */
  | { status: "expired"; error: string };

/**
 * Map a push service's status code.
 *
 * `404` and `410` are the ones that matter: a browser that was reinstalled, a
 * profile that was cleared or a person who revoked permission leaves a
 * subscription that will never work again. Retrying one forever is how an
 * outbox fills with work that cannot succeed, so it is deleted instead.
 */
export function classifySendStatus(status: number): SendOutcome {
  if (status >= 200 && status < 300) return { status: "delivered" };
  if (status === 404 || status === 410) {
    return { status: "expired", error: `push subscription is gone (${status})` };
  }
  if (status === 429 || status === 408 || status >= 500) {
    return { status: "retry", error: `push service returned ${status}` };
  }
  return { status: "permanent", error: `push service returned ${status}` };
}

/* -------------------------------------------------------------------------- */
/* What the device is allowed to display                                       */
/* -------------------------------------------------------------------------- */

/**
 * Make a string safe to be one line of operating-system chrome.
 *
 * The same argument as the desktop shell's notification sanitiser, applied at
 * the other end of the same product: this text is a message preview or an
 * agent-written reason, it is rendered by the platform rather than by us, and
 * three things stop it being text.
 *
 * * **Control characters**, including newlines, become one word break. A
 *   notification is a line or two of chrome, and a body carrying twenty
 *   newlines pushes the part somebody needed to read out of view — which is how
 *   a preview of an approval ends up showing only the reassuring half.
 * * **Bidirectional overrides** are removed rather than escaped. They reorder
 *   the characters *around* them when rendered, so a message body can rewrite
 *   how the title beside it reads.
 * * **Length** is bounded here rather than by the platform, and counted in
 *   characters so a Japanese preview is not cut to a third of a Latin one.
 */
export function notificationText(value: string, limit: number): string {
  const cleaned = [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
      const bidi = (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || code === 0x200e || code === 0x200f;
      return control || bidi ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const characters = [...cleaned];
  if (characters.length <= limit) return cleaned;
  return `${characters.slice(0, Math.max(0, limit - 1)).join("").trimEnd()}\u2026`;
}

/** A notification the device may render, once the viewer's authority allowed it. */
export type RenderedNotification = { title: string; body: string; path: string };

export const NOTIFICATION_TITLE_LIMIT = 80;
export const NOTIFICATION_BODY_LIMIT = 160;

