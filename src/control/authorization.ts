import { hashOpaqueToken, randomToken } from "./identity";
import type { Workspace } from "../cloudflare/workspace";

const encoder = new TextEncoder();
const REQUEST_WINDOW_MS = 5 * 60_000;

export type BrowserSession = {
  token: string;
  csrfToken: string;
  expiresAt: number;
};

export type SignedDeviceClaims = {
  method: string;
  path: string;
  bodyHash: string;
  workspaceId: string;
  memberId: string;
  authorizationEpoch: number;
  deviceId: string;
  deviceKeyEpoch: number;
  timestamp: number;
  nonce: string;
  requestId: string;
  projectId: string;
  configRevision: number;
  agentId?: string;
  delegationId?: string;
  originId?: string;
};

export class AuthorizationService {
  constructor(
    private readonly db: D1Database,
    private readonly workspaces: DurableObjectNamespace<Workspace>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async issueBrowserSession(input: {
    accountId: string;
    deviceLabel?: string;
    platform?: string;
    ttlMs?: number;
  }): Promise<BrowserSession> {
    const account = await this.db
      .prepare("SELECT security_epoch FROM accounts WHERE id = ? AND status = 'active'")
      .bind(input.accountId)
      .first<{ security_epoch: number }>();
    if (!account) throw new Error("account not found");
    const token = randomToken();
    const csrfToken = randomToken();
    const createdAt = this.now();
    const expiresAt = createdAt + Math.min(input.ttlMs ?? 30 * 24 * 60 * 60_000, 30 * 24 * 60 * 60_000);
    await this.db
      .prepare(
        `INSERT INTO sessions(
           token_hash, account_id, security_epoch, csrf_secret_hash, device_label, platform,
           created_at, last_seen_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        await hashOpaqueToken(token),
        input.accountId,
        account.security_epoch,
        await hashOpaqueToken(csrfToken),
        input.deviceLabel ?? null,
        input.platform ?? null,
        createdAt,
        createdAt,
        expiresAt,
      )
      .run();
    return { token, csrfToken, expiresAt };
  }

  async authenticateBrowserSession(token: string, csrfToken?: string): Promise<{ accountId: string }> {
    const tokenHash = await hashOpaqueToken(token);
    const row = await this.db
      .prepare(
        `SELECT s.account_id, s.csrf_secret_hash
         FROM sessions s JOIN accounts a ON a.id = s.account_id
         WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
           AND a.status = 'active' AND a.security_epoch = s.security_epoch`,
      )
      .bind(tokenHash, this.now())
      .first<{ account_id: string; csrf_secret_hash: ArrayBuffer }>();
    if (!row) throw new Error("session is invalid");
    if (csrfToken !== undefined && !equalBytes(new Uint8Array(row.csrf_secret_hash), await hashOpaqueToken(csrfToken))) {
      throw new Error("csrf token is invalid");
    }
    return { accountId: row.account_id };
  }

  async revokeBrowserSession(token: string): Promise<void> {
    await this.db
      .prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
      .bind(this.now(), await hashOpaqueToken(token))
      .run();
  }

  async revokeAllBrowserSessions(accountId: string): Promise<void> {
    const now = this.now();
    await this.db.batch([
      this.db.prepare("UPDATE accounts SET security_epoch = security_epoch + 1, updated_at = ? WHERE id = ?").bind(now, accountId),
      this.db.prepare("UPDATE sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL").bind(now, accountId),
    ]);
  }

  async registerDevice(input: {
    accountId: string;
    kind: "client" | "runner";
    label: string;
    signingPublicKey: JsonWebKey;
    encryptionPublicKey: JsonWebKey;
  }): Promise<{ deviceId: string; credential: string; keyEpoch: number }> {
    assertPublicP256Key(input.signingPublicKey);
    assertPublicP256Key(input.encryptionPublicKey);
    const account = await this.db
      .prepare("SELECT security_epoch FROM accounts WHERE id = ? AND status = 'active'")
      .bind(input.accountId)
      .first<{ security_epoch: number }>();
    if (!account) throw new Error("account not found");
    const deviceId = crypto.randomUUID();
    const credential = randomToken();
    const now = this.now();
    await this.db
      .prepare(
        `INSERT INTO devices(
           id, account_id, kind, credential_hash, public_key, label, status, created_at, last_seen_at,
           security_epoch, key_epoch, signing_public_key_jwk, encryption_public_key_jwk
         ) VALUES (?, ?, ?, ?, NULL, ?, 'active', ?, ?, ?, 1, ?, ?)`,
      )
      .bind(
        deviceId,
        input.accountId,
        input.kind,
        await hashOpaqueToken(credential),
        input.label.trim(),
        now,
        now,
        account.security_epoch,
        JSON.stringify(input.signingPublicKey),
        JSON.stringify(input.encryptionPublicKey),
      )
      .run();
    return { deviceId, credential, keyEpoch: 1 };
  }

  async revokeDevice(accountId: string, deviceId: string): Promise<void> {
    const result = await this.db
      .prepare(
        `UPDATE devices SET status = 'revoked', revoked_at = ?, key_epoch = key_epoch + 1
         WHERE id = ? AND account_id = ? AND status = 'active'`,
      )
      .bind(this.now(), deviceId, accountId)
      .run();
    if (result.meta.changes !== 1) throw new Error("active device not found");
  }

  async authorizeSignedDeviceRequest(input: {
    credential: string;
    claims: SignedDeviceClaims;
    body: Uint8Array;
    signature: Uint8Array;
  }): Promise<{ accountId: string; memberId: string; workspaceId: string; deviceId: string }> {
    const claims = input.claims;
    validateSignedClaims(claims);
    if (Math.abs(this.now() - claims.timestamp) > REQUEST_WINDOW_MS) throw new Error("request timestamp is stale");
    const actualBodyHash = toBase64Url(
      new Uint8Array(await crypto.subtle.digest("SHA-256", ownedBytes(input.body))),
    );
    if (actualBodyHash !== claims.bodyHash) throw new Error("request body hash does not match");

    const device = await this.db
      .prepare(
        `SELECT d.account_id, d.security_epoch, d.key_epoch, d.signing_public_key_jwk,
                a.security_epoch AS account_security_epoch, a.status AS account_status
         FROM devices d JOIN accounts a ON a.id = d.account_id
         WHERE d.id = ? AND d.credential_hash = ? AND d.status = 'active'`,
      )
      .bind(claims.deviceId, await hashOpaqueToken(input.credential))
      .first<{
        account_id: string;
        security_epoch: number;
        key_epoch: number;
        signing_public_key_jwk: string;
        account_security_epoch: number;
        account_status: string;
      }>();
    if (
      !device ||
      device.account_status !== "active" ||
      device.security_epoch !== device.account_security_epoch ||
      device.key_epoch !== claims.deviceKeyEpoch
    ) {
      throw new Error("device is invalid");
    }

    const key = await crypto.subtle.importKey(
      "jwk",
      JSON.parse(device.signing_public_key_jwk) as JsonWebKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      ownedBytes(input.signature),
      encoder.encode(canonicalSignedDeviceRequest(claims)),
    );
    if (!verified) throw new Error("request signature is invalid");

    const membership = await this.db
      .prepare(
        `SELECT m.account_id, m.authorization_epoch, w.durable_object_id
         FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
         WHERE m.workspace_id = ? AND m.member_id = ? AND m.status = 'active' AND w.status = 'active'`,
      )
      .bind(claims.workspaceId, claims.memberId)
      .first<{ account_id: string; authorization_epoch: number; durable_object_id: string }>();
    if (
      !membership ||
      membership.account_id !== device.account_id ||
      membership.authorization_epoch !== claims.authorizationEpoch
    ) {
      throw new Error("membership is invalid");
    }
    const local = await this.workspaces
      .get(this.workspaces.idFromString(membership.durable_object_id))
      .authorizeMember(claims.memberId, claims.authorizationEpoch);
    if (!local) throw new Error("workspace membership is invalid");

    try {
      await this.db
        .prepare(
          `INSERT INTO device_request_nonces(device_id, nonce, request_id, seen_at, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(claims.deviceId, claims.nonce, claims.requestId, this.now(), this.now() + REQUEST_WINDOW_MS)
        .run();
    } catch {
      throw new Error("request was already used");
    }
    await this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").bind(this.now(), claims.deviceId).run();
    return {
      accountId: device.account_id,
      memberId: claims.memberId,
      workspaceId: claims.workspaceId,
      deviceId: claims.deviceId,
    };
  }
}

export function canonicalSignedDeviceRequest(claims: SignedDeviceClaims): string {
  return [
    "lepidy-device-request-v1",
    claims.method.toUpperCase(),
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

function assertPublicP256Key(key: JsonWebKey): void {
  if (key.kty !== "EC" || key.crv !== "P-256" || !key.x || !key.y || key.d) {
    throw new Error("device key must be a public P-256 key");
  }
}

function isBoundedToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{8,128}$/.test(value);
}

function validateSignedClaims(claims: SignedDeviceClaims): void {
  if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(claims.method.toUpperCase())) {
    throw new Error("invalid request method");
  }
  if (!/^\/[\x21-\x7e]{0,511}$/.test(claims.path)) throw new Error("invalid request path");
  if (!/^[A-Za-z0-9_-]{43}$/.test(claims.bodyHash)) throw new Error("invalid request body hash");
  for (const value of [
    claims.workspaceId,
    claims.memberId,
    claims.deviceId,
    claims.projectId,
    claims.agentId,
    claims.delegationId,
    claims.originId,
  ]) {
    if (value !== undefined && !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) {
      throw new Error("invalid signed identifier");
    }
  }
  if (!isBoundedToken(claims.nonce) || !isBoundedToken(claims.requestId)) {
    throw new Error("invalid request nonce");
  }
  if (
    !Number.isSafeInteger(claims.timestamp) ||
    !Number.isSafeInteger(claims.configRevision) ||
    !Number.isSafeInteger(claims.authorizationEpoch) ||
    !Number.isSafeInteger(claims.deviceKeyEpoch) ||
    claims.configRevision < 1 ||
    claims.authorizationEpoch < 1 ||
    claims.deviceKeyEpoch < 1
  ) {
    throw new Error("invalid request epoch");
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function toBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
  copy.set(value);
  return copy;
}
