import argon2NonSimdModule from "argon2id/dist/no-simd.wasm";
import argon2SimdModule from "argon2id/dist/simd.wasm";
import setupArgon2id, { type computeHash } from "argon2id/lib/setup.js";

import {
  DEVICE_PACKAGE_SUITE,
  RECOVERY_PACKAGE_SUITE,
  type VaultDevicePackage,
  type VaultRecoveryPackage,
} from "../control/vault-recovery";
import { decodeVaultBytes, encodeVaultBytes } from "./vault-envelope";

const RECOVERY_MEMORY_KIB = 65_536;
const RECOVERY_ITERATIONS = 3;
const RECOVERY_LANES = 1;
const encoder = new TextEncoder();
let argon2idPromise: Promise<computeHash> | undefined;

/** Trusted-client module. Never import this from a Worker route or Durable Object. */
export function generateVaultRecoveryCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes]
    .map((byte) => alphabet[byte & 31])
    .join("")
    .match(/.{1,6}/gu)!
    .join("-");
}

export async function sealVaultRecovery(input: {
  accountId: string;
  vaultEpoch: number;
  recoveryCode: string;
  accountVaultPackage: Uint8Array;
}): Promise<VaultRecoveryPackage> {
  assertRecoveryCode(input.recoveryCode);
  if (input.accountVaultPackage.byteLength < 32) throw new Error("account vault package is too short");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await recoveryKey(input.recoveryCode, salt, RECOVERY_MEMORY_KIB, RECOVERY_ITERATIONS, RECOVERY_LANES);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: owned(recoveryAad(input.accountId, input.vaultEpoch)) },
    key,
    owned(input.accountVaultPackage),
  );
  return {
    suite: RECOVERY_PACKAGE_SUITE,
    vaultEpoch: input.vaultEpoch,
    memoryKib: RECOVERY_MEMORY_KIB,
    iterations: RECOVERY_ITERATIONS,
    lanes: RECOVERY_LANES,
    salt: encodeVaultBytes(salt),
    iv: encodeVaultBytes(iv),
    ciphertext: encodeVaultBytes(new Uint8Array(ciphertext)),
  };
}

export async function openVaultRecovery(input: {
  accountId: string;
  recoveryCode: string;
  package: VaultRecoveryPackage;
}): Promise<Uint8Array> {
  assertRecoveryCode(input.recoveryCode);
  if (input.package.suite !== RECOVERY_PACKAGE_SUITE) throw new Error("unsupported recovery package");
  try {
    const salt = decodeVaultBytes(input.package.salt, "recovery salt");
    const key = await recoveryKey(
      input.recoveryCode,
      salt,
      input.package.memoryKib,
      input.package.iterations,
      input.package.lanes,
    );
    const opened = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: owned(decodeVaultBytes(input.package.iv, "recovery iv")),
        additionalData: owned(recoveryAad(input.accountId, input.package.vaultEpoch)),
      },
      key,
      owned(decodeVaultBytes(input.package.ciphertext, "recovery ciphertext")),
    );
    return new Uint8Array(opened);
  } catch {
    throw new Error("recovery code did not open the vault");
  }
}

export async function sealVaultDevicePackage(input: {
  accountId: string;
  vaultEpoch: number;
  targetDeviceId: string;
  targetDeviceKeyEpoch: number;
  targetEncryptionPublicKey: JsonWebKey;
  accountVaultPackage: Uint8Array;
}): Promise<VaultDevicePackage> {
  if (input.accountVaultPackage.byteLength < 32) throw new Error("account vault package is too short");
  const target = await crypto.subtle.importKey(
    "jwk", input.targetEncryptionPublicKey, { name: "ECDH", namedCurve: "P-256" }, false, [],
  );
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const context = deviceAad(input);
  const key = await deviceKey(
    await crypto.subtle.deriveBits({ name: "ECDH", public: target }, ephemeral.privateKey, 256),
    context,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: owned(context) }, key, owned(input.accountVaultPackage),
  );
  return {
    suite: DEVICE_PACKAGE_SUITE,
    vaultEpoch: input.vaultEpoch,
    targetDeviceId: input.targetDeviceId,
    targetDeviceKeyEpoch: input.targetDeviceKeyEpoch,
    ephemeralPublicKey: encodeVaultBytes(new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey))),
    iv: encodeVaultBytes(iv),
    ciphertext: encodeVaultBytes(new Uint8Array(ciphertext)),
  };
}

export async function openVaultDevicePackage(input: {
  accountId: string;
  package: VaultDevicePackage;
  targetEncryptionPrivateKey: CryptoKey;
}): Promise<Uint8Array> {
  const context = deviceAad({ accountId: input.accountId, ...input.package });
  try {
    const ephemeral = await crypto.subtle.importKey(
      "raw",
      owned(decodeVaultBytes(input.package.ephemeralPublicKey, "device package ephemeral public key")),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    const key = await deviceKey(
      await crypto.subtle.deriveBits({ name: "ECDH", public: ephemeral }, input.targetEncryptionPrivateKey, 256),
      context,
      ["decrypt"],
    );
    return new Uint8Array(await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: owned(decodeVaultBytes(input.package.iv, "device package iv")),
        additionalData: owned(context),
      },
      key,
      owned(decodeVaultBytes(input.package.ciphertext, "device package ciphertext")),
    ));
  } catch {
    throw new Error("device package did not open");
  }
}

function loadArgon2id(): Promise<computeHash> {
  argon2idPromise ??= setupArgon2id(
    async (imports) => ({ instance: await WebAssembly.instantiate(argon2SimdModule, imports), module: argon2SimdModule }),
    async (imports) => ({ instance: await WebAssembly.instantiate(argon2NonSimdModule, imports), module: argon2NonSimdModule }),
  );
  return argon2idPromise;
}

async function recoveryKey(code: string, salt: Uint8Array, memoryKib: number, iterations: number, lanes: number): Promise<CryptoKey> {
  if (memoryKib < RECOVERY_MEMORY_KIB || iterations < RECOVERY_ITERATIONS || lanes !== RECOVERY_LANES) {
    throw new Error("recovery package KDF is too weak");
  }
  const derive = await loadArgon2id();
  const bytes = derive({ password: encoder.encode(code), salt, memorySize: memoryKib, passes: iterations, parallelism: lanes, tagLength: 32 });
  return crypto.subtle.importKey("raw", owned(bytes), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function deviceKey(shared: ArrayBuffer, context: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: owned(context) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    usages,
  );
}

function recoveryAad(accountId: string, epoch: number): Uint8Array {
  return encoder.encode(JSON.stringify(["lepidy-account-vault-recovery", 1, accountId, epoch]));
}

function deviceAad(input: { accountId: string; vaultEpoch: number; targetDeviceId: string; targetDeviceKeyEpoch: number }): Uint8Array {
  return encoder.encode(JSON.stringify([
    "lepidy-account-vault-device", 1, input.accountId, input.vaultEpoch,
    input.targetDeviceId, input.targetDeviceKeyEpoch,
  ]));
}

function assertRecoveryCode(value: string): void {
  if (!/^[A-HJ-NP-Z2-9]{6}(?:-[A-HJ-NP-Z2-9]{6}){3}$/u.test(value)) throw new Error("recovery code is invalid");
}

function owned(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(value);
}
