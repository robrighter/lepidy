import { describe, expect, it } from "vitest";

import {
  assertMetadataOnly,
  buildPushPayload,
  classifySendStatus,
  decodeBase64Url,
  encodeBase64Url,
  pushTtlSeconds,
  pushUrgency,
  validateSubscription,
  vapidClaims,
} from "../src/domain/web-push";
import { encryptPushPayload, sendPush, signVapidToken, vapidPublicKey } from "../src/cloudflare/web-push";

/** A real P-256 subscription, generated here so the test owns both halves. */
async function subscription() {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    keys: pair,
    subscription: validateSubscription({
      endpoint: "https://push.example.test/f/abc",
      p256dh: encodeBase64Url(raw),
      auth: encodeBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    }),
  };
}

describe("PUSH-RULE — what may be sent, and what a push may say", () => {
  it("PUSH-RULE-001 refuses a subscription that could never work", async () => {
    const { subscription: valid } = await subscription();
    expect(valid.audience).toBe("https://push.example.test");

    for (const endpoint of [
      "http://push.example.test/f/abc",
      "https://user:pass@push.example.test/f/abc",
      "https://push.example.test/f/abc#fragment",
    ]) {
      expect(() => validateSubscription({ ...valid, endpoint })).toThrow();
    }
    // A key of the wrong length is a key the encryption would fail on later,
    // in an outbox retry loop, with nothing to point at.
    expect(() => validateSubscription({ ...valid, p256dh: encodeBase64Url(new Uint8Array(64)) })).toThrow();
    expect(() => validateSubscription({ ...valid, auth: encodeBase64Url(new Uint8Array(8)) })).toThrow();
    expect(() => validateSubscription({ ...valid, auth: "not base64url!!" })).toThrow();
  });

  it("PUSH-RULE-002 carries identifiers and refuses anything that looks like content", () => {
    const payload = buildPushPayload("approval", "req-77", "/inbox?approval=req-77");
    expect(payload).toEqual({ v: 1, kind: "approval", id: "req-77", path: "/inbox?approval=req-77" });
    assertMetadataOnly(payload);

    // The rule stated as a test, because the temptation arrives the first time
    // somebody wants a better lock-screen preview. A field here would put
    // another person's words on a lock screen and would silently undo C06's
    // metadata-only outbox.
    for (const extra of ["title", "body", "credentialName", "reason", "message"]) {
      expect(() => assertMetadataOnly({ ...payload, [extra]: "anything" })).toThrow(/may not carry/);
    }
    // And the destination is a rooted path on this workspace, never a URL.
    for (const path of ["https://evil.test/", "//evil.test/", "evil", ""]) {
      expect(() => buildPushPayload("message", "m1", path)).toThrow();
    }
    expect(() => buildPushPayload("message", "../../etc", "/inbox")).toThrow();
  });

  it("PUSH-RULE-003 stops trying to deliver an approval that has expired", () => {
    const now = 1_000_000;
    // Five minutes at most, and less once the clock has run down: waking
    // somebody to decide something already decided is how a person learns to
    // ignore the notification that mattered.
    expect(pushTtlSeconds("approval", now + 300_000, now)).toBe(300);
    expect(pushTtlSeconds("approval", now + 60_000, now)).toBe(60);
    expect(pushTtlSeconds("approval", now - 1, now)).toBe(0);
    expect(pushTtlSeconds("approval", null, now)).toBe(0);
    // A mention has no deadline.
    expect(pushTtlSeconds("message", null, now)).toBe(86_400);
    expect(pushUrgency("approval")).toBe("high");
    expect(pushUrgency("message")).toBe("normal");
  });

  it("PUSH-RULE-004 deletes a subscription the push service says is gone", () => {
    expect(classifySendStatus(201).status).toBe("delivered");
    // The ones that matter: a reinstalled browser, a cleared profile, a revoked
    // permission. Retrying one forever fills an outbox with work that cannot
    // succeed.
    expect(classifySendStatus(404).status).toBe("expired");
    expect(classifySendStatus(410).status).toBe("expired");
    expect(classifySendStatus(429).status).toBe("retry");
    expect(classifySendStatus(503).status).toBe("retry");
    expect(classifySendStatus(400).status).toBe("permanent");
    expect(classifySendStatus(403).status).toBe("permanent");
  });

  it("PUSH-RULE-005 scopes a VAPID token to the push service's origin", () => {
    const now = 1_700_000_000_000;
    const claims = vapidClaims("https://push.example.test/f/abc", "mailto:ops@lepidy.app", now);
    // The origin, not the endpoint: a token naming the full endpoint would tell
    // any service that logged it which subscription it was for.
    expect(claims.aud).toBe("https://push.example.test");
    expect(claims.exp).toBeGreaterThan(Math.floor(now / 1000));
    expect(claims.exp - Math.floor(now / 1000)).toBeLessThanOrEqual(24 * 60 * 60);
    expect(() => vapidClaims("https://push.example.test", "ops@lepidy.app", now)).toThrow();
  });
});

describe("PUSH-INT — the cryptography, with the runtime's own primitives", () => {
  it("PUSH-INT-001 produces a body only the subscribing browser can open", async () => {
    const { keys, subscription: target } = await subscription();
    const plaintext = new TextEncoder().encode(
      JSON.stringify(buildPushPayload("approval", "req-77", "/inbox?approval=req-77")),
    );
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const body = await encryptPushPayload(plaintext, target, { salt });

    // The header layout is where interop with a real push service breaks, so it
    // is asserted byte by byte: a 16-byte salt, a record size, the length of
    // the sender's key, and that key.
    expect(body.slice(0, 16)).toEqual(salt);
    expect(new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0)).toBe(4096);
    expect(body[20]).toBe(65);
    const senderPublic = body.slice(21, 21 + 65);
    const sealed = body.slice(21 + 65);
    // One record: the plaintext, the `0x02` last-record delimiter, and the tag.
    expect(sealed.length).toBe(plaintext.length + 1 + 16);

    // Now open it the way the browser would, deriving from the *receiver's*
    // private key. A round trip is the check that the key schedule is right;
    // guessing at a vector from memory would not be.
    const shared = new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: "ECDH",
          public: await crypto.subtle.importKey(
            "raw",
            senderPublic as BufferSource,
            { name: "ECDH", namedCurve: "P-256" },
            false,
            [],
          ),
        },
        keys.privateKey,
        256,
      ),
    );
    const receiverPublic = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
    const encoder = new TextEncoder();
    const hkdf = async (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) => {
      const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, [
        "deriveBits",
      ]);
      return new Uint8Array(
        await crypto.subtle.deriveBits(
          { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource },
          key,
          length * 8,
        ),
      );
    };
    const keyInfo = new Uint8Array([
      ...encoder.encode("WebPush: info\0"),
      ...receiverPublic,
      ...senderPublic,
    ]);
    const ikm = await hkdf(decodeBase64Url(target.auth), shared, keyInfo, 32);
    const contentKey = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
    const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
    const opened = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce as BufferSource },
        await crypto.subtle.importKey("raw", contentKey as BufferSource, "AES-GCM", false, [
          "decrypt",
        ]),
        sealed as BufferSource,
      ),
    );
    expect(opened[opened.length - 1]).toBe(0x02);
    expect(JSON.parse(new TextDecoder().decode(opened.slice(0, -1)))).toEqual({
      v: 1,
      kind: "approval",
      id: "req-77",
      path: "/inbox?approval=req-77",
    });
  });

  it("PUSH-INT-002 gives a different body every time, to the same subscription", async () => {
    // The ephemeral key is per message. Reusing one would let anybody who ever
    // recovered it read every push Lepidy had sent to that subscription.
    const { subscription: target } = await subscription();
    const plaintext = new TextEncoder().encode("{}");
    const first = await encryptPushPayload(plaintext, target);
    const second = await encryptPushPayload(plaintext, target);
    expect(encodeBase64Url(first)).not.toBe(encodeBase64Url(second));
    expect(encodeBase64Url(first.slice(21, 86))).not.toBe(encodeBase64Url(second.slice(21, 86)));
  });

  it("PUSH-INT-003 signs a VAPID token a push service can verify", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const claims = vapidClaims("https://push.example.test/f/abc", "mailto:ops@lepidy.app", Date.now());
    const token = await signVapidToken(claims, privateJwk);

    const [header, body, signature] = token.split(".");
    expect(JSON.parse(new TextDecoder().decode(decodeBase64Url(header)))).toEqual({
      typ: "JWT",
      alg: "ES256",
    });
    expect(JSON.parse(new TextDecoder().decode(decodeBase64Url(body)))).toEqual(claims);
    // Raw `r||s`, not DER: a DER signature is the classic way a VAPID token is
    // rejected by every push service with an unhelpful 401.
    expect(decodeBase64Url(signature).length).toBe(64);
    const verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pair.publicKey,
      decodeBase64Url(signature) as BufferSource,
      new TextEncoder().encode(`${header}.${body}`) as BufferSource,
    );
    expect(verified).toBe(true);
    expect(decodeBase64Url(await vapidPublicKey(publicJwk)).length).toBe(65);
  });

  it("PUSH-INT-004 never follows a push endpoint that redirects", async () => {
    const { subscription: target } = await subscription();
    let seen: RequestInit | undefined;
    const outcome = await sendPush(
      {
        subscription: target,
        body: new Uint8Array([1, 2, 3]),
        token: "token",
        publicKey: "key",
        ttlSeconds: 300,
        urgency: "high",
      },
      (async (_url: unknown, init: RequestInit) => {
        seen = init;
        return new Response(null, { status: 201 });
      }) as unknown as typeof fetch,
    );
    expect(outcome.status).toBe("delivered");
    // A push endpoint that redirects is one pointing somewhere the egress guard
    // never resolved.
    expect(seen?.redirect).toBe("manual");
    const headers = seen?.headers as Record<string, string>;
    expect(headers["content-encoding"]).toBe("aes128gcm");
    expect(headers.authorization).toBe("vapid t=token, k=key");
    expect(headers.urgency).toBe("high");
    expect(headers.ttl).toBe("300");
  });
});
