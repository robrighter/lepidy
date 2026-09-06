/**
 * Opaque credential helpers with no WebAssembly dependency.
 *
 * These are separated from `identity.ts` deliberately: password hashing pulls
 * the Argon2id wasm modules, and importing that graph from a React server
 * component drags the whole hasher into the page bundle. Session authentication
 * only needs a digest and a random string.
 */

const encoder = new TextEncoder();

export async function hashOpaqueToken(token: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(token)));
}

export function randomToken(bytes = 32): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
