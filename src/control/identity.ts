import argon2NonSimdModule from "argon2id/dist/no-simd.wasm";
import argon2SimdModule from "argon2id/dist/simd.wasm";
import setupArgon2id, { type computeHash } from "argon2id/lib/setup.js";

const encoder = new TextEncoder();
let argon2idPromise: Promise<computeHash> | undefined;

function loadArgon2id(): Promise<computeHash> {
  argon2idPromise ??= setupArgon2id(
    async (imports) => ({
      instance: await WebAssembly.instantiate(argon2SimdModule, imports),
      module: argon2SimdModule,
    }),
    async (imports) => ({
      instance: await WebAssembly.instantiate(argon2NonSimdModule, imports),
      module: argon2NonSimdModule,
    }),
  );
  return argon2idPromise;
}

export type ExternalIdentityAssertion = {
  provider: "google";
  subject: string;
  email: string;
  emailVerified: boolean;
};

export type LinkAuthorization = {
  freshSession: boolean;
  stepUpVerified: boolean;
  confirmed: boolean;
};

export function normalizeEmail(email: string): string {
  return email.trim().normalize("NFKC").toLowerCase();
}

export function assertSafeIdentityLink(
  assertion: ExternalIdentityAssertion,
  authorization: LinkAuthorization,
): void {
  if (!assertion.emailVerified) throw new Error("provider email is not verified");
  if (!authorization.freshSession) throw new Error("fresh session required");
  if (!authorization.stepUpVerified) throw new Error("step-up verification required");
  if (!authorization.confirmed) throw new Error("explicit confirmation required");
}

export async function hashOpaqueToken(token: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(token)));
}

export function randomToken(bytes = 32): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) throw new Error("password must contain at least 12 characters");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const compute = await loadArgon2id();
  const hash = compute({
    password: encoder.encode(password),
    salt,
    parallelism: 1,
    passes: 3,
    memorySize: 19_456,
    tagLength: 32,
  });
  return `$argon2id$v=19$m=19456,t=3,p=1$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/.exec(encodedHash);
  if (!match) return false;
  const [, memorySize, passes, parallelism, saltValue, expectedValue] = match;
  const expected = fromBase64(expectedValue);
  const compute = await loadArgon2id();
  const actual = compute({
    password: encoder.encode(password),
    salt: fromBase64(saltValue),
    parallelism: Number(parallelism),
    passes: Number(passes),
    memorySize: Number(memorySize),
    tagLength: expected.length,
  });
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) difference |= actual[index] ^ expected[index];
  return difference === 0;
}

function toBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/, "");
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function validateHumanHandle(handle: string): string {
  const normalized = handle.trim().normalize("NFKC").toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(normalized)) {
    throw new Error("handle must be 2-32 letters, numbers, dots, underscores or hyphens");
  }
  if (normalized.startsWith("a.") || normalized.startsWith("g.")) {
    throw new Error("human handles cannot use the a. or g. namespace");
  }
  return normalized;
}
