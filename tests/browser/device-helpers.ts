import { expect, type APIRequestContext, type Page } from "@playwright/test";

import type { freshAccount } from "./auth-helpers";
import { encodeVaultBytes } from "../../src/domain/vault-envelope";

/**
 * The device envelope, built the way the Rust CLI builds it.
 *
 * Shared by every browser scenario that speaks the device API, so there is one
 * client-side implementation of the canonical claims rather than one per spec
 * quietly drifting from `src/control/authorization.ts`.
 */

export const BASE = "http://127.0.0.1:3100";
/** The same Worker, addressed by a name WebAuthn will accept as a relying party. */
export const LOCALHOST_BASE = "http://localhost:3100";
export const CANARY = "device-api-plaintext-canary-8813";
export const PROJECT = "cli-project";

export function slugFor(account: ReturnType<typeof freshAccount>): string {
  return account.workspaceName.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-");
}

export type Enrolment = {
  deviceId: string;
  deviceCredential: string;
  deviceKeyEpoch: number;
  workspaceId: string;
  memberId: string;
  authorizationEpoch: number;
  vaultKey: { keyEpoch: number; published: boolean };
};

export type DeviceKeys = {
  signing: CryptoKeyPair;
  vault: CryptoKeyPair;
  vaultPublicKey: Uint8Array;
};

export async function generateKeys(): Promise<DeviceKeys> {
  const signing = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const vault = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits", "deriveKey"]);
  return { signing, vault, vaultPublicKey: new Uint8Array(await crypto.subtle.exportKey("raw", vault.publicKey)) };
}

export async function publicJwk(key: CryptoKey): Promise<JsonWebKey> {
  const { kty, crv, x, y } = (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;
  return { kty, crv, x, y };
}

/** The canonical string from `src/control/authorization.ts`, rebuilt client-side. */
export function canonical(claims: Record<string, string | number | undefined>): string {
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

export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url");
}

export async function signedRequest(
  request: APIRequestContext,
  input: {
    keys: DeviceKeys;
    enrolment: Enrolment;
    path: string;
    body: unknown;
    tamper?: "body" | "signature";
    nonce?: string;
    base?: string;
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
  return request.post(`${input.base ?? BASE}${input.path}`, {
    headers: {
      "content-type": "application/json",
      "x-lepidy-device-credential": input.enrolment.deviceCredential,
      "x-lepidy-device-claims": base64url(new TextEncoder().encode(JSON.stringify(claims))),
      "x-lepidy-device-signature": base64url(signature),
    },
    data: input.tamper === "body" ? `${raw} ` : raw,
  });
}


/** Enrol a client the way `lepidy login` does, and publish its vault key. */
export async function enrolDevice(
  page: Page,
  input: { email: string; password: string; workspaceSlug: string; label: string; base?: string },
): Promise<{ keys: DeviceKeys; enrolment: Enrolment }> {
  const keys = await generateKeys();
  const response = await page.request.post(`${input.base ?? BASE}/api/device/enroll`, {
    data: {
      email: input.email,
      password: input.password,
      workspaceSlug: input.workspaceSlug,
      label: input.label,
      kind: "client",
      signingPublicKey: await publicJwk(keys.signing.publicKey),
      encryptionPublicKey: await publicJwk(keys.vault.publicKey),
      vaultPublicKey: encodeVaultBytes(keys.vaultPublicKey),
    },
  });
  expect(response.status()).toBe(200);
  return { keys, enrolment: (await response.json()) as Enrolment };
}
