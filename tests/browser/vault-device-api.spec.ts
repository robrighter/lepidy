import { expect, test, type APIRequestContext } from "@playwright/test";

import { freshAccount, signUp } from "./auth-helpers";
import { unwrapVaultDek, wrapVaultDek } from "../../src/domain/vault-client-crypto";
import { decryptVaultValue, encryptVaultValue } from "../../src/domain/vault-client-crypto";
import { encodeVaultBytes, VAULT_WRAP_SUITE } from "../../src/domain/vault-envelope";

/**
 * The device HTTP surface the Rust CLI speaks, driven over real HTTP against
 * the built Worker with a real P-256 device key.
 *
 * The CLI's own suite proves what the binary does; this proves the other half —
 * that the deployed endpoints verify a signature the way the control plane
 * does, that the workspace's policy decides every release, and that no request
 * or response in the whole flow carries a credential in the clear.
 */

const BASE = "http://127.0.0.1:3100";
const CANARY = "device-api-plaintext-canary-8813";
const PROJECT = "cli-project";

function slugFor(account: ReturnType<typeof freshAccount>): string {
  return account.workspaceName.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-");
}

type Enrolment = {
  deviceId: string;
  deviceCredential: string;
  deviceKeyEpoch: number;
  workspaceId: string;
  memberId: string;
  authorizationEpoch: number;
  vaultKey: { keyEpoch: number; published: boolean };
};

type DeviceKeys = {
  signing: CryptoKeyPair;
  vault: CryptoKeyPair;
  vaultPublicKey: Uint8Array;
};

async function generateKeys(): Promise<DeviceKeys> {
  const signing = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const vault = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits", "deriveKey"]);
  return { signing, vault, vaultPublicKey: new Uint8Array(await crypto.subtle.exportKey("raw", vault.publicKey)) };
}

async function publicJwk(key: CryptoKey): Promise<JsonWebKey> {
  const { kty, crv, x, y } = (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;
  return { kty, crv, x, y };
}

/** The canonical string from `src/control/authorization.ts`, rebuilt client-side. */
function canonical(claims: Record<string, string | number | undefined>): string {
  return [
    "lepidy-device-request-v1",
    String(claims.method).toUpperCase(),
    claims.path,
    claims.bodyHash,
    claims.workspaceId,
    claims.memberId,
    String(claims.authorizationEpoch),
    claims.deviceId,
    String(claims.deviceKeyEpoch),
    String(claims.timestamp),
    claims.nonce,
    claims.requestId,
    claims.projectId,
    String(claims.configRevision),
    claims.agentId ?? "",
    claims.delegationId ?? "",
    claims.originId ?? "",
  ].join("\n");
}

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url");
}

async function signedRequest(
  request: APIRequestContext,
  input: {
    keys: DeviceKeys;
    enrolment: Enrolment;
    path: string;
    body: unknown;
    tamper?: "body" | "signature";
    nonce?: string;
  },
) {
  const raw = JSON.stringify(input.body);
  const claims = {
    method: "POST",
    path: input.path,
    bodyHash: base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw))),
    workspaceId: input.enrolment.workspaceId,
    memberId: input.enrolment.memberId,
    authorizationEpoch: input.enrolment.authorizationEpoch,
    deviceId: input.enrolment.deviceId,
    deviceKeyEpoch: input.enrolment.deviceKeyEpoch,
    timestamp: Date.now(),
    nonce: input.nonce ?? base64url(crypto.getRandomValues(new Uint8Array(18))),
    requestId: base64url(crypto.getRandomValues(new Uint8Array(18))),
    projectId: PROJECT,
    configRevision: 1,
  };
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      input.keys.signing.privateKey,
      new TextEncoder().encode(canonical(claims)),
    ),
  );
  if (input.tamper === "signature") signature[0] ^= 0xff;
  return request.post(`${BASE}${input.path}`, {
    headers: {
      "content-type": "application/json",
      "x-lepidy-device-credential": input.enrolment.deviceCredential,
      "x-lepidy-device-claims": base64url(new TextEncoder().encode(JSON.stringify(claims))),
      "x-lepidy-device-signature": base64url(signature),
    },
    data: input.tamper === "body" ? `${raw} ` : raw,
  });
}

test("VAULT-DEVICE-INT-001 enrols a local client, seals a value on it, and releases it back only under policy", async ({
  page,
}) => {
  const account = freshAccount();
  await signUp(page, account);
  const session = (await page.context().cookies()).find((cookie) => cookie.name === "lepidy_session");
  expect(session).toBeDefined();
  const origin = (await (
    await page.request.post(`${BASE}/__fixture/device-origin`, { headers: { authorization: session!.value } })
  ).json()) as { channelId: string; messageId: string; workspaceId: string; memberId: string };

  const keys = await generateKeys();
  const enrolResponse = await page.request.post(`${BASE}/api/device/enroll`, {
    data: {
      email: account.email,
      password: account.password,
      workspaceSlug: slugFor(account),
      label: "browser device suite",
      kind: "client",
      signingPublicKey: await publicJwk(keys.signing.publicKey),
      encryptionPublicKey: await publicJwk(keys.vault.publicKey),
      vaultPublicKey: encodeVaultBytes(keys.vaultPublicKey),
    },
  });
  expect(enrolResponse.status()).toBe(200);
  const enrolment = (await enrolResponse.json()) as Enrolment;
  expect(enrolment.vaultKey).toEqual({ keyEpoch: 1, published: true });
  expect(enrolment.workspaceId).toBe(origin.workspaceId);
  expect(enrolment.memberId).toBe(origin.memberId);
  // Enrolment hands back a credential to sign with, and nothing that could open
  // a vault entry.
  const enrolBody = await enrolResponse.text();
  expect(enrolBody).not.toContain(account.password);
  expect(enrolBody).not.toContain("privateKey");

  // A signature that does not cover the body, and one that is simply wrong, are
  // both refused before any workspace code runs.
  for (const tamper of ["body", "signature"] as const) {
    const refused = await signedRequest(page.request, {
      keys,
      enrolment,
      path: "/api/device/vault/list",
      body: {},
      tamper,
    });
    expect(refused.status()).toBe(401);
  }

  // A fresh device sees an empty vault rather than somebody else's.
  const emptyList = await signedRequest(page.request, { keys, enrolment, path: "/api/device/vault/list", body: {} });
  expect(emptyList.status()).toBe(200);
  expect((await emptyList.json()).credentials).toEqual([]);

  // Create a credential exactly as the CLI does: sealed here, wrapped to the
  // key this device published, and only then sent.
  const credentialId = `cred-device-${Date.now()}`;
  const encrypted = await encryptVaultValue({
    workspaceId: enrolment.workspaceId,
    credentialId,
    version: 1,
    keyEpoch: 1,
    plaintext: new TextEncoder().encode(CANARY),
  });
  const wrap = await wrapVaultDek({
    workspaceId: enrolment.workspaceId,
    credentialId,
    version: 1,
    custodianMemberId: enrolment.memberId,
    recipientKeyEpoch: enrolment.vaultKey.keyEpoch,
    recipientPublicKey: keys.vaultPublicKey,
    dek: encrypted.dek,
  });
  const createBody = {
    credentialId,
    idempotencyKey: `browser:device:add:${credentialId}`,
    password: account.password,
    metadata: {
      name: "DEVICE_TOKEN",
      description: "Created over the device API",
      envVar: "DEVICE_TOKEN",
      tags: [],
      commands: [],
      proxyHosts: [],
    },
    policy: { mode: "auto", allowedDeliveries: ["inject"], projectIds: [PROJECT], highRisk: false },
    envelope: encrypted.envelope,
    wraps: [{ ...wrap, wrapSuite: VAULT_WRAP_SUITE }],
    acl: [
      { subjectType: "member", subjectId: enrolment.memberId, verb: "manage" },
      { subjectType: "member", subjectId: enrolment.memberId, verb: "use" },
    ],
  };
  const created = await signedRequest(page.request, {
    keys,
    enrolment,
    path: "/api/device/vault/credentials",
    body: createBody,
  });
  expect(created.status()).toBe(200);
  expect(await created.text()).not.toContain(CANARY);

  // Creating requires user verification in the request itself: the same body
  // with the wrong password is refused.
  const unverified = await signedRequest(page.request, {
    keys,
    enrolment,
    path: "/api/device/vault/credentials",
    body: { ...createBody, credentialId: `${credentialId}-2`, password: "not the password" },
  });
  expect(unverified.status()).toBe(403);

  // Listing now shows metadata, and only metadata.
  const listed = await signedRequest(page.request, { keys, enrolment, path: "/api/device/vault/list", body: {} });
  const listedBody = await listed.text();
  expect(listedBody).toContain("DEVICE_TOKEN");
  expect(listedBody).not.toContain(CANARY);
  expect(listedBody).not.toContain("ciphertext");
  expect(listedBody).not.toContain("wrappedDek");

  // The release: allowed by policy, and still ciphertext on the wire.
  const releaseBody = {
    credentialId,
    delivery: "inject",
    origin: { channelId: origin.channelId, messageId: origin.messageId },
  };
  const released = await signedRequest(page.request, {
    keys,
    enrolment,
    path: "/api/device/vault/release",
    body: releaseBody,
  });
  expect(released.status()).toBe(200);
  const releasedText = await released.text();
  expect(releasedText).not.toContain(CANARY);
  const payload = (await released.json()) as {
    decision: { kind: string };
    envelope: Parameters<typeof decryptVaultValue>[0]["envelope"];
    wrap: Parameters<typeof unwrapVaultDek>[0]["wrap"];
  };
  expect(payload.decision).toEqual({ kind: "allow", via: "automatic" });

  // Only this client's private key turns that into the value.
  const dek = await unwrapVaultDek({
    workspaceId: enrolment.workspaceId,
    credentialId,
    version: payload.envelope.version,
    wrap: payload.wrap,
    recipientPrivateKey: keys.vault.privateKey,
  });
  const opened = await decryptVaultValue({
    workspaceId: enrolment.workspaceId,
    credentialId,
    envelope: payload.envelope,
    dek,
  });
  expect(new TextDecoder().decode(opened)).toBe(CANARY);

  // An unrelated key opens nothing, which is the property the whole design
  // rests on.
  const stranger = await generateKeys();
  await expect(
    unwrapVaultDek({
      workspaceId: enrolment.workspaceId,
      credentialId,
      version: payload.envelope.version,
      wrap: payload.wrap,
      recipientPrivateKey: stranger.vault.privateKey,
    }),
  ).rejects.toThrow();
});

test("VAULT-DEVICE-INT-002 refuses a replayed request, a wrong origin and an unsigned call", async ({ page }) => {
  const account = freshAccount();
  await signUp(page, account);
  const session = (await page.context().cookies()).find((cookie) => cookie.name === "lepidy_session");
  const origin = (await (
    await page.request.post(`${BASE}/__fixture/device-origin`, { headers: { authorization: session!.value } })
  ).json()) as { channelId: string; messageId: string };

  const keys = await generateKeys();
  const enrolment = (await (
    await page.request.post(`${BASE}/api/device/enroll`, {
      data: {
        email: account.email,
        password: account.password,
        workspaceSlug: slugFor(account),
        label: "replay suite",
        kind: "runner",
        signingPublicKey: await publicJwk(keys.signing.publicKey),
        encryptionPublicKey: await publicJwk(keys.vault.publicKey),
        vaultPublicKey: encodeVaultBytes(keys.vaultPublicKey),
      },
    })
  ).json()) as Enrolment;

  // No envelope at all.
  const unsigned = await page.request.post(`${BASE}/api/device/vault/list`, { data: {} });
  expect(unsigned.status()).toBe(401);

  // The same nonce twice: the first is served, the second is not.
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(18)));
  const first = await signedRequest(page.request, { keys, enrolment, path: "/api/device/vault/list", body: {}, nonce });
  expect(first.status()).toBe(200);
  const replay = await signedRequest(page.request, { keys, enrolment, path: "/api/device/vault/list", body: {}, nonce });
  expect(replay.status()).toBe(401);

  // A release naming an origin that does not exist is refused with a decision,
  // not with ciphertext.
  const refused = await signedRequest(page.request, {
    keys,
    enrolment,
    path: "/api/device/vault/release",
    body: {
      credentialId: "cred-does-not-exist",
      delivery: "inject",
      origin: { channelId: origin.channelId, messageId: "message-that-does-not-exist" },
    },
  });
  expect(refused.status()).toBe(200);
  const body = (await refused.json()) as { decision: { kind: string }; envelope?: unknown };
  expect(body.decision.kind).toBe("deny");
  expect(body.envelope).toBeUndefined();

  // Enrolment credentials are per-device: another device's credential does not
  // authorise this one's claims.
  const otherKeys = await generateKeys();
  const impersonated = await signedRequest(page.request, {
    keys: otherKeys,
    enrolment,
    path: "/api/device/vault/list",
    body: {},
  });
  expect(impersonated.status()).toBe(401);
});
