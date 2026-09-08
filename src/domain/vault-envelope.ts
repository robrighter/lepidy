export const VAULT_CIPHER_SUITE = "AES-256-GCM" as const;
/**
 * The one wrapping suite: ECDH over P-256 to the custodian's published public
 * key, HKDF-SHA256 to a 256-bit key, AES-256-GCM over the 32-byte DEK. The
 * derivation info and the GCM additional data are both the canonical wrap
 * context below, so a wrap cannot be replayed onto another workspace,
 * credential, version or custodian.
 */
export const VAULT_WRAP_SUITE = "P256-HKDF-SHA256-AES256GCM" as const;
/** Uncompressed SEC1 P-256 point: 0x04 ‖ X ‖ Y. */
export const VAULT_PUBLIC_KEY_BYTES = 65;
export const VAULT_AAD_VERSION = 1 as const;
export const VAULT_IV_BYTES = 12;
export const VAULT_DEK_BYTES = 32;
export const MAX_VAULT_CIPHERTEXT_BYTES = 256 * 1024;

export type VaultCiphertextEnvelope = {
  cipherSuite: typeof VAULT_CIPHER_SUITE;
  aadVersion: typeof VAULT_AAD_VERSION;
  version: number;
  keyEpoch: number;
  iv: string;
  ciphertext: string;
};

export type VaultKeyWrap = {
  custodianMemberId: string;
  recipientKeyEpoch: number;
  wrapSuite: string;
  ephemeralPublicKey: string;
  iv: string;
  wrappedDek: string;
};

/**
 * `workspaceId` is the control-plane workspace id — the same value a device
 * signs in its request claims — so a client binds ciphertext to the tenant it
 * authenticated against rather than to a storage address it cannot verify.
 */
export function canonicalVaultAad(input: {
  workspaceId: string;
  credentialId: string;
  version: number;
}): Uint8Array {
  assertOpaqueId(input.workspaceId, "workspace id");
  assertOpaqueId(input.credentialId, "credential id");
  if (!Number.isSafeInteger(input.version) || input.version < 1) throw new Error("credential version is invalid");
  return new TextEncoder().encode(
    JSON.stringify(["lepidy-credential", VAULT_AAD_VERSION, input.workspaceId, input.credentialId, input.version]),
  );
}

/**
 * The authenticated context of one key wrap. Both the HKDF info and the GCM
 * additional data, so a wrap sealed for one custodian at one credential version
 * fails to open as any other.
 */
export function canonicalVaultWrapAad(input: {
  workspaceId: string;
  credentialId: string;
  version: number;
  custodianMemberId: string;
  recipientKeyEpoch: number;
}): Uint8Array {
  assertOpaqueId(input.workspaceId, "workspace id");
  assertOpaqueId(input.credentialId, "credential id");
  assertOpaqueId(input.custodianMemberId, "custodian member id");
  if (!Number.isSafeInteger(input.version) || input.version < 1) throw new Error("credential version is invalid");
  if (!Number.isSafeInteger(input.recipientKeyEpoch) || input.recipientKeyEpoch < 1) {
    throw new Error("recipient key epoch is invalid");
  }
  return new TextEncoder().encode(
    JSON.stringify([
      "lepidy-credential-wrap",
      VAULT_AAD_VERSION,
      input.workspaceId,
      input.credentialId,
      input.version,
      input.custodianMemberId,
      input.recipientKeyEpoch,
    ]),
  );
}

/** A custodian's published wrapping key, as stored and as sent to a client. */
export function validateVaultPublicKey(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} is not base64url`);
  const bytes = decodeVaultBytes(value, field);
  if (bytes.byteLength !== VAULT_PUBLIC_KEY_BYTES || bytes[0] !== 0x04) {
    throw new Error(`${field} must be an uncompressed P-256 point`);
  }
  return value;
}

export function encodeVaultBytes(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodeVaultBytes(value: unknown, field: string): Uint8Array {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error(`${field} is not base64url`);
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Error(`${field} is not base64url`);
  }
}

export function validateVaultEnvelope(
  value: VaultCiphertextEnvelope,
  expected: { version: number; keyEpoch: number },
): VaultCiphertextEnvelope {
  if (value.cipherSuite !== VAULT_CIPHER_SUITE || value.aadVersion !== VAULT_AAD_VERSION) {
    throw new Error("unsupported vault envelope suite");
  }
  if (value.version !== expected.version || value.keyEpoch !== expected.keyEpoch) {
    throw new Error("vault envelope epoch does not match");
  }
  const iv = decodeVaultBytes(value.iv, "vault iv");
  const ciphertext = decodeVaultBytes(value.ciphertext, "vault ciphertext");
  if (iv.byteLength !== VAULT_IV_BYTES) throw new Error("vault iv must be 96 bits");
  if (ciphertext.byteLength < 16 || ciphertext.byteLength > MAX_VAULT_CIPHERTEXT_BYTES) {
    throw new Error("vault ciphertext length is invalid");
  }
  return { ...value };
}

export function validateVaultKeyWrap(value: VaultKeyWrap): VaultKeyWrap {
  assertOpaqueId(value.custodianMemberId, "custodian member id");
  if (!Number.isSafeInteger(value.recipientKeyEpoch) || value.recipientKeyEpoch < 1) {
    throw new Error("recipient key epoch is invalid");
  }
  if (value.wrapSuite !== VAULT_WRAP_SUITE) throw new Error("unsupported vault wrap suite");
  const publicKey = decodeVaultBytes(value.ephemeralPublicKey, "ephemeral public key");
  const iv = decodeVaultBytes(value.iv, "wrap iv");
  const wrappedDek = decodeVaultBytes(value.wrappedDek, "wrapped DEK");
  if (publicKey.byteLength < 33 || publicKey.byteLength > 256) throw new Error("ephemeral public key length is invalid");
  if (iv.byteLength !== VAULT_IV_BYTES) throw new Error("wrap iv must be 96 bits");
  if (wrappedDek.byteLength < VAULT_DEK_BYTES + 16 || wrappedDek.byteLength > 1024) {
    throw new Error("wrapped DEK length is invalid");
  }
  return { ...value };
}

export function assertOpaqueId(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 200 || !/^[A-Za-z0-9:._-]+$/u.test(value)) {
    throw new Error(`${field} is invalid`);
  }
}
