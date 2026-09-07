export const VAULT_CIPHER_SUITE = "AES-256-GCM" as const;
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
  if (value.wrapSuite.length === 0 || value.wrapSuite.length > 80) throw new Error("wrap suite is invalid");
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
