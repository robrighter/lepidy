/**
 * The cryptography a web push actually needs, and the request that carries it.
 *
 * Two independent pieces, and it is worth keeping them straight because they
 * protect against different people.
 *
 * **VAPID** is how the push service knows the sender is Lepidy. It is a signed
 * JWT, it protects the push service from being used as an open relay, and it
 * says nothing about the payload.
 *
 * **RFC 8291 encryption** is how the *payload* stays unreadable by the push
 * service, which is a third party the user did not choose and Lepidy cannot
 * audit. The key is derived from the subscription's own public key and its
 * authentication secret, so only the browser that created the subscription can
 * open it. This is what makes it acceptable to route a notification about
 * somebody's workspace through Google, Apple or Mozilla at all.
 *
 * Everything below is WebCrypto, so it runs in the Worker runtime and its tests
 * exercise the same primitives production does.
 */

import {
  classifySendStatus,
  decodeBase64Url,
  encodeBase64Url,
  type SendOutcome,
  type ValidatedSubscription,
  type VapidClaims,
} from "../domain/web-push";

const utf8 = new TextEncoder();

/* -------------------------------------------------------------------------- */
/* VAPID                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Sign the VAPID token.
 *
 * ES256 over P-256, and the signature has to be the raw `r||s` pair rather than
 * the DER encoding a general-purpose signer might produce — WebCrypto's
 * `ECDSA` already gives the raw form, which is the one JWS wants.
 */
export async function signVapidToken(claims: VapidClaims, privateJwk: JsonWebKey): Promise<string> {
  const key = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const header = encodeBase64Url(utf8.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = encodeBase64Url(utf8.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    utf8.encode(`${header}.${body}`),
  );
  return `${header}.${body}.${encodeBase64Url(new Uint8Array(signature))}`;
}

/** The uncompressed public point, which the push service matches the token to. */
export async function vapidPublicKey(publicJwk: JsonWebKey): Promise<string> {
  const key = await crypto.subtle.importKey(
    "jwk",
    publicJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    [],
  );
  return encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", key)));
}

/* -------------------------------------------------------------------------- */
/* RFC 8291 payload encryption                                                 */
/* -------------------------------------------------------------------------- */

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Encrypt a payload to one subscription, in the `aes128gcm` content encoding.
 *
 * The shape is fixed by RFC 8188: a header carrying the salt, the record size
 * and the sender's public key, then one AES-GCM record. One record is enough
 * because a Lepidy push payload is a few dozen bytes — it carries identifiers,
 * never content — and a multi-record body would be code with no test that ever
 * exercised it.
 */
export async function encryptPushPayload(
  plaintext: Uint8Array,
  subscription: Pick<ValidatedSubscription, "p256dh" | "auth">,
  entropy: { salt?: Uint8Array } = {},
): Promise<Uint8Array> {
  const clientPublic = decodeBase64Url(subscription.p256dh);
  const authSecret = decodeBase64Url(subscription.auth);
  const salt = entropy.salt ?? crypto.getRandomValues(new Uint8Array(16));

  // An ephemeral key per message: reusing one would let anybody who ever
  // recovered it read every push Lepidy had sent to that subscription.
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const senderPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));

  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "ECDH",
        public: await crypto.subtle.importKey(
          "raw",
          clientPublic as BufferSource,
          { name: "ECDH", namedCurve: "P-256" },
          false,
          [],
        ),
      },
      ephemeral.privateKey,
      256,
    ),
  );

  // The key-derivation info binds both public keys, so a shared secret cannot
  // be replayed against a different subscription.
  const keyInfo = concat(
    utf8.encode("WebPush: info\0"),
    clientPublic,
    senderPublic,
  );
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);
  const contentKey = await hkdf(salt, ikm, utf8.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8.encode("Content-Encoding: nonce\0"), 12);

  const key = await crypto.subtle.importKey("raw", contentKey as BufferSource, "AES-GCM", false, [
    "encrypt",
  ]);
  // The padding delimiter: `0x02` marks the last record, which this always is.
  const record = concat(plaintext, Uint8Array.of(0x02));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource }, key, record as BufferSource),
  );

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);
  return concat(salt, recordSize, Uint8Array.of(senderPublic.length), senderPublic, sealed);
}

/* -------------------------------------------------------------------------- */
/* The request                                                                 */
/* -------------------------------------------------------------------------- */

export type PushRequest = {
  subscription: ValidatedSubscription;
  body: Uint8Array;
  token: string;
  publicKey: string;
  ttlSeconds: number;
  urgency: "high" | "normal";
};

/**
 * Hand one encrypted push to the push service.
 *
 * `redirect: "manual"` because a push endpoint that redirects is a push
 * endpoint pointing somewhere the egress guard never resolved — the same rule
 * the custom runtime callback follows, for the same reason.
 */
export async function sendPush(
  request: PushRequest,
  fetcher: typeof fetch = fetch,
): Promise<SendOutcome> {
  try {
    const response = await fetcher(request.subscription.endpoint, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "content-type": "application/octet-stream",
        "content-encoding": "aes128gcm",
        ttl: String(request.ttlSeconds),
        urgency: request.urgency,
        authorization: `vapid t=${request.token}, k=${request.publicKey}`,
      },
      body: request.body as BodyInit,
    });
    return classifySendStatus(response.status);
  } catch (error) {
    return { status: "retry", error: error instanceof Error ? error.message.slice(0, 200) : "push failed" };
  }
}
