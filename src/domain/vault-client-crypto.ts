import {
  VAULT_CIPHER_SUITE,
  VAULT_AAD_VERSION,
  VAULT_DEK_BYTES,
  VAULT_IV_BYTES,
  VAULT_WRAP_SUITE,
  canonicalVaultAad,
  canonicalVaultWrapAad,
  decodeVaultBytes,
  encodeVaultBytes,
  type VaultCiphertextEnvelope,
  type VaultKeyWrap,
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

/**
 * Seal a DEK for one custodian: ECDH to their published wrapping key, HKDF to a
 * fresh AES key, then GCM over the DEK under the canonical wrap context.
 *
 * Trusted-client only, like the rest of this module. The ephemeral private key
 * is discarded here and never stored, so the wrap can only be opened by the
 * holder of the custodian's private half.
 */
export async function wrapVaultDek(input: {
  workspaceId: string;
  credentialId: string;
  version: number;
  custodianMemberId: string;
  recipientKeyEpoch: number;
  recipientPublicKey: Uint8Array;
  dek: Uint8Array;
  iv?: Uint8Array;
}): Promise<VaultKeyWrap> {
  if (input.dek.byteLength !== VAULT_DEK_BYTES) throw new Error("vault DEK must be 256 bits");
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const aad = canonicalVaultWrapAad(input);
  const key = await wrapKeyFromShared(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: await importVaultPublicKey(input.recipientPublicKey) },
      ephemeral.privateKey,
      256,
    ),
    aad,
    ["encrypt"],
  );
  const iv = input.iv ? ownedBytes(input.iv) : crypto.getRandomValues(new Uint8Array(VAULT_IV_BYTES));
  const wrappedDek = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: ownedBytes(aad) },
    key,
    ownedBytes(input.dek),
  );
  return {
    custodianMemberId: input.custodianMemberId,
    recipientKeyEpoch: input.recipientKeyEpoch,
    wrapSuite: VAULT_WRAP_SUITE,
    ephemeralPublicKey: encodeVaultBytes(
      new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey)),
    ),
    iv: encodeVaultBytes(iv),
    wrappedDek: encodeVaultBytes(new Uint8Array(wrappedDek)),
  };
}

export async function unwrapVaultDek(input: {
  workspaceId: string;
  credentialId: string;
  version: number;
  wrap: VaultKeyWrap;
  recipientPrivateKey: CryptoKey;
}): Promise<Uint8Array> {
  if (input.wrap.wrapSuite !== VAULT_WRAP_SUITE) throw new Error("unsupported vault wrap suite");
  const aad = canonicalVaultWrapAad({
    workspaceId: input.workspaceId,
    credentialId: input.credentialId,
    version: input.version,
    custodianMemberId: input.wrap.custodianMemberId,
    recipientKeyEpoch: input.wrap.recipientKeyEpoch,
  });
  const key = await wrapKeyFromShared(
    await crypto.subtle.deriveBits(
      {
        name: "ECDH",
        public: await importVaultPublicKey(decodeVaultBytes(input.wrap.ephemeralPublicKey, "ephemeral public key")),
      },
      input.recipientPrivateKey,
      256,
    ),
    aad,
    ["decrypt"],
  );
  const dek = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ownedBytes(decodeVaultBytes(input.wrap.iv, "wrap iv")), additionalData: ownedBytes(aad) },
    key,
    ownedBytes(decodeVaultBytes(input.wrap.wrappedDek, "wrapped DEK")),
  );
  if (dek.byteLength !== VAULT_DEK_BYTES) throw new Error("vault DEK must be 256 bits");
  return new Uint8Array(dek);
}

function importVaultPublicKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", ownedBytes(raw), { name: "ECDH", namedCurve: "P-256" }, false, []);
}

/** HKDF-SHA256 over the raw ECDH secret, with the wrap context as info. */
async function wrapKeyFromShared(
  shared: ArrayBuffer,
  info: Uint8Array,
  usages: readonly KeyUsage[],
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: ownedBytes(info) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    [...usages],
  );
}
