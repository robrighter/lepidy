import { getCloudflareContext } from "@opennextjs/cloudflare";

import { ACCOUNTS_OBJECT_NAME } from "../cloudflare/accounts-address";
import type { Accounts } from "../cloudflare/accounts";
import type { Workspace } from "../cloudflare/workspace";
import { AuthorizationService, type SignedDeviceClaims } from "../control/authorization";
import { decodeVaultBytes } from "../domain/vault-envelope";
import type { ShellEnvironment } from "./resolve-shell-source";

/**
 * The transport the Rust CLI and the headless runner speak.
 *
 * Nothing here is reachable with a browser session or a cookie. Every request
 * after enrolment carries the F05 signed-device envelope: the canonical claims
 * in one header, an ECDSA signature over them in another, and the body hash
 * inside the claims — so the tenant, member, device, key epoch, nonce and the
 * exact path being called are all covered by one signature that the control
 * plane verifies before any workspace code runs.
 */

/**
 * Nothing a device sends is large. The biggest body is a credential envelope,
 * which the vault caps at 256 KiB of ciphertext; this bounds the whole request
 * so an unauthenticated caller cannot make the Worker buffer megabytes before
 * the signature is even looked at.
 */
export const MAX_DEVICE_BODY_BYTES = 1024 * 1024;

export const DEVICE_CREDENTIAL_HEADER = "x-lepidy-device-credential";
export const DEVICE_CLAIMS_HEADER = "x-lepidy-device-claims";
export const DEVICE_SIGNATURE_HEADER = "x-lepidy-device-signature";

export type DeviceEnvironment = {
  db: D1Database;
  workspaces: NonNullable<ShellEnvironment["WORKSPACE"]>;
  accounts: DurableObjectStub<Accounts>;
  authorization: AuthorizationService;
};

export async function deviceEnvironment(): Promise<DeviceEnvironment | null> {
  let env: ShellEnvironment = {};
  try {
    env = (await getCloudflareContext({ async: true })).env as ShellEnvironment;
  } catch {
    return null;
  }
  if (!env.CONTROL_DB || !env.WORKSPACE || !env.ACCOUNTS) return null;
  return {
    db: env.CONTROL_DB,
    workspaces: env.WORKSPACE,
    accounts: env.ACCOUNTS.getByName(ACCOUNTS_OBJECT_NAME),
    authorization: new AuthorizationService(env.CONTROL_DB, env.WORKSPACE),
  };
}

export function deviceJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/**
 * One error shape for every device endpoint, and never more detail than the
 * caller is entitled to: a CLI learns that its request was refused and what to
 * do about it, not whether the workspace, member or credential exists.
 */
export function deviceError(code: string, message: string, status = 400): Response {
  return deviceJson({ error: code, message }, status);
}

export type AuthorizedDeviceRequest = {
  claims: SignedDeviceClaims;
  accountId: string;
  memberId: string;
  workspaceId: string;
  deviceId: string;
  workspace: DurableObjectStub<Workspace>;
  body: unknown;
};

/**
 * Verify one signed device request and resolve the workspace it names.
 *
 * The path and method inside the claims are checked against the request that
 * actually arrived, so a signature captured from one endpoint cannot be
 * replayed against another; the nonce table in the control plane stops it being
 * replayed against the same one.
 */
export async function authorizeDeviceRequest(
  env: DeviceEnvironment,
  request: Request,
): Promise<AuthorizedDeviceRequest | Response> {
  const credential = request.headers.get(DEVICE_CREDENTIAL_HEADER);
  const encodedClaims = request.headers.get(DEVICE_CLAIMS_HEADER);
  const encodedSignature = request.headers.get(DEVICE_SIGNATURE_HEADER);
  if (credential === null || encodedClaims === null || encodedSignature === null) {
    return deviceError("device_unsigned", "this endpoint requires a signed device request", 401);
  }

  let claims: SignedDeviceClaims;
  let signature: Uint8Array;
  try {
    claims = JSON.parse(new TextDecoder().decode(decodeVaultBytes(encodedClaims, "device claims"))) as SignedDeviceClaims;
    signature = decodeVaultBytes(encodedSignature, "device signature");
  } catch {
    return deviceError("device_unsigned", "the signed request envelope is malformed", 401);
  }

  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > MAX_DEVICE_BODY_BYTES) {
    return deviceError("body_too_large", "that request body is larger than this endpoint accepts", 413);
  }
  const url = new URL(request.url);
  if (claims.method?.toUpperCase() !== request.method.toUpperCase() || claims.path !== url.pathname) {
    return deviceError("device_unsigned", "the signature does not cover this request", 401);
  }

  let authorized: { accountId: string; memberId: string; workspaceId: string; deviceId: string };
  try {
    authorized = await env.authorization.authorizeSignedDeviceRequest({ credential, claims, body, signature });
  } catch {
    return deviceError("device_unauthorized", "the device, membership or signature was refused", 401);
  }

  const row = await env.db
    .prepare("SELECT durable_object_id, status FROM workspaces WHERE id = ?")
    .bind(authorized.workspaceId)
    .first<{ durable_object_id: string; status: string }>();
  if (row === null || row.status !== "active") {
    return deviceError("workspace_unavailable", "that workspace is not serving requests", 404);
  }

  let parsed: unknown = {};
  if (body.byteLength > 0) {
    try {
      parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
    } catch {
      return deviceError("invalid_body", "a JSON body is required");
    }
  }

  return {
    claims,
    ...authorized,
    workspace: env.workspaces.get(env.workspaces.idFromString(row.durable_object_id)),
    body: parsed,
  };
}

/**
 * A password check performed inside the request that needs it.
 *
 * The vault's step-up rule asks for *fresh* user verification, and the freshest
 * possible evidence is a verification that happens as part of this operation
 * rather than a token minted earlier and carried around. WebAuthn user
 * verification replaces this once the native client owns the ceremony; until
 * then this is the honest form of the same guarantee, and the signed request
 * that carries it is single-use.
 */
/** The same bound, for the one endpoint that runs before a signature exists. */
export async function readBoundedJson(request: Request): Promise<Record<string, unknown> | Response> {
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > MAX_DEVICE_BODY_BYTES) {
    return deviceError("body_too_large", "that request body is larger than this endpoint accepts", 413);
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return deviceError("invalid_body", "a JSON object body is required");
    }
    return parsed as Record<string, unknown>;
  } catch {
    return deviceError("invalid_body", "a JSON body is required");
  }
}

export async function verifyDevicePassword(
  env: DeviceEnvironment,
  accountId: string,
  password: unknown,
): Promise<boolean> {
  if (typeof password !== "string" || password.length === 0) return false;
  const account = await env.db
    .prepare("SELECT primary_email_normalized FROM accounts WHERE id = ? AND status = 'active'")
    .bind(accountId)
    .first<{ primary_email_normalized: string }>();
  if (account === null) return false;
  return (await env.accounts.authenticatePassword(account.primary_email_normalized, password)) === accountId;
}

/**
 * The device's own view of where it is signing requests to.
 *
 * A CLI needs the control-plane workspace id, its member id and the current
 * epochs before it can sign anything at all, and every one of those can change
 * underneath it. Enrolment returns them and this resolves them again.
 */
export async function resolveDeviceMembership(
  env: DeviceEnvironment,
  input: { accountId: string; workspaceSlug: string },
): Promise<{ workspaceId: string; workspaceSlug: string; memberId: string; authorizationEpoch: number } | null> {
  const row = await env.db
    .prepare(
      `SELECT w.id AS workspace_id, w.slug, m.member_id, m.authorization_epoch
       FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
       WHERE m.account_id = ? AND w.slug = ? AND m.status = 'active' AND w.status = 'active'`,
    )
    .bind(input.accountId, input.workspaceSlug)
    .first<{ workspace_id: string; slug: string; member_id: string; authorization_epoch: number }>();
  if (row === null) return null;
  return {
    workspaceId: row.workspace_id,
    workspaceSlug: row.slug,
    memberId: row.member_id,
    authorizationEpoch: row.authorization_epoch,
  };
}
