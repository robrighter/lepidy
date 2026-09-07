import {
  VAULT_CIPHER_SUITE,
  VAULT_AAD_VERSION,
  VAULT_DEK_BYTES,
  VAULT_IV_BYTES,
  canonicalVaultAad,
  decodeVaultBytes,
  encodeVaultBytes,
  type VaultCiphertextEnvelope,
} from "./vault-envelope";

/** Trusted-client helper. Cloud code must never import this module or receive `dek`. */
export async function encryptVaultValue(input: {
  workspaceId: string;
  credentialId: string;
  version: number;
  keyEpoch: number;
  plaintext: Uint8Array;
  dek?: Uint8Array;
  iv?: Uint8Array;
}): Promise<{ envelope: VaultCiphertextEnvelope; dek: Uint8Array }> {
  const dek = input.dek ? ownedBytes(input.dek) : crypto.getRandomValues(new Uint8Array(VAULT_DEK_BYTES));
  const iv = input.iv ? ownedBytes(input.iv) : crypto.getRandomValues(new Uint8Array(VAULT_IV_BYTES));
  if (dek.byteLength !== VAULT_DEK_BYTES) throw new Error("vault DEK must be 256 bits");
  if (iv.byteLength !== VAULT_IV_BYTES) throw new Error("vault IV must be 96 bits");
  const key = await crypto.subtle.importKey("raw", dek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: ownedBytes(canonicalVaultAad(input)) },
    key,
    ownedBytes(input.plaintext),
  );
  return {
    envelope: {
      cipherSuite: VAULT_CIPHER_SUITE,
      aadVersion: VAULT_AAD_VERSION,
      version: input.version,
      keyEpoch: input.keyEpoch,
      iv: encodeVaultBytes(iv),
      ciphertext: encodeVaultBytes(new Uint8Array(ciphertext)),
    },
    dek,
  };
}

export async function decryptVaultValue(input: {
  workspaceId: string;
  credentialId: string;
  envelope: VaultCiphertextEnvelope;
  dek: Uint8Array;
}): Promise<Uint8Array> {
  if (input.dek.byteLength !== VAULT_DEK_BYTES) throw new Error("vault DEK must be 256 bits");
  const key = await crypto.subtle.importKey("raw", ownedBytes(input.dek), { name: "AES-GCM" }, false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: ownedBytes(decodeVaultBytes(input.envelope.iv, "vault iv")),
      additionalData: ownedBytes(canonicalVaultAad({
        workspaceId: input.workspaceId,
        credentialId: input.credentialId,
        version: input.envelope.version,
      })),
    },
    key,
    ownedBytes(decodeVaultBytes(input.envelope.ciphertext, "vault ciphertext")),
  );
  return new Uint8Array(plaintext);
}

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value);
}
