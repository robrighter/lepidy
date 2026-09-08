import {
  VAULT_IV_BYTES,
  decodeVaultBytes,
  encodeVaultBytes,
  validateVaultPublicKey,
} from "./vault-envelope";

export const VAULT_PROXY_REQUEST_SUITE = "P256-HKDF-SHA256-AES256GCM" as const;
export const VAULT_PROXY_RESPONSE_SUITE = "AES-256-GCM" as const;
export const VAULT_PROXY_REQUEST_TTL_MS = 60_000;
export const MAX_PROXY_REQUEST_BODY_BYTES = 64 * 1024;
export const MAX_PROXY_RESPONSE_BODY_BYTES = 256 * 1024;

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const REQUEST_HEADERS = new Set(["accept", "content-type", "idempotency-key"]);

export type VaultProxyRequest = {
  url: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  headers: Record<string, string>;
  body: string | null;
};

export type VaultProxyResult = {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
};

export type VaultProxyRelayEnvelope = {
  suite: typeof VAULT_PROXY_REQUEST_SUITE;
  ephemeralPublicKey: string;
  iv: string;
  ciphertext: string;
};

export type VaultProxyResponseEnvelope = {
  suite: typeof VAULT_PROXY_RESPONSE_SUITE;
  iv: string;
  ciphertext: string;
};

export function normalizeVaultProxyRequest(value: unknown): VaultProxyRequest {
  if (!isRecord(value)) throw new Error("proxy request must be an object");
  const unexpected = Object.keys(value).filter((key) => !["url", "method", "headers", "body"].includes(key));
  if (unexpected.length > 0) throw new Error(`proxy request has unknown fields: ${unexpected.sort().join(", ")}`);
  if (typeof value.url !== "string" || value.url.length > 4_096) throw new Error("proxy URL is invalid");
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw new Error("proxy URL is invalid");
  }
  if (url.protocol !== "https:" || (url.port !== "" && url.port !== "443")) {
    throw new Error("proxy destinations must use HTTPS on port 443");
  }
  if (url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new Error("proxy destinations cannot contain credentials or fragments");
  }
  if (isIpLiteral(url.hostname)) throw new Error("proxy destinations must use a public DNS hostname");

  const method = typeof value.method === "string" ? value.method.toUpperCase() : "GET";
  if (!METHODS.has(method)) throw new Error("proxy method is not allowed");
  if (!isRecord(value.headers ?? {})) throw new Error("proxy headers must be an object");
  const headers: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(value.headers ?? {})) {
    const name = rawName.toLowerCase();
    if (!REQUEST_HEADERS.has(name) || typeof rawValue !== "string" || rawValue.length > 4_096) {
      throw new Error(`proxy header ${rawName} is not allowed`);
    }
    headers[name] = rawValue;
  }
  const body = value.body === undefined || value.body === null ? null : value.body;
  if (body !== null && (typeof body !== "string" || new TextEncoder().encode(body).byteLength > MAX_PROXY_REQUEST_BODY_BYTES)) {
    throw new Error("proxy body is too large");
  }
  if ((method === "GET" || method === "HEAD" || method === "DELETE") && body !== null) {
    throw new Error(`${method} proxy requests cannot carry a body`);
  }
  return { url: url.toString(), method: method as VaultProxyRequest["method"], headers, body };
}

export function validateVaultProxyResult(value: unknown): VaultProxyResult {
  if (!isRecord(value)) throw new Error("proxy result must be an object");
  const unexpected = Object.keys(value).filter((key) => !["status", "headers", "body", "truncated"].includes(key));
  if (unexpected.length > 0) throw new Error("proxy result contains unexpected fields");
  if (!Number.isInteger(value.status) || Number(value.status) < 100 || Number(value.status) > 599) {
    throw new Error("proxy result status is invalid");
  }
  if (!isRecord(value.headers) || Object.keys(value.headers).length > 32) throw new Error("proxy result headers are invalid");
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value.headers)) {
    if (typeof headerValue !== "string" || name.length > 128 || headerValue.length > 4_096) {
      throw new Error("proxy result headers are invalid");
    }
    const lower = name.toLowerCase();
    if (["authorization", "proxy-authorization", "cookie", "set-cookie"].includes(lower)) continue;
    headers[lower] = headerValue;
  }
  if (typeof value.body !== "string" || new TextEncoder().encode(value.body).byteLength > MAX_PROXY_RESPONSE_BODY_BYTES) {
    throw new Error("proxy result body is too large");
  }
  if (typeof value.truncated !== "boolean") throw new Error("proxy result truncation flag is invalid");
  return { status: Number(value.status), headers, body: value.body, truncated: value.truncated };
}

export async function sealVaultProxyRequest(input: {
  workspaceId: string;
  requestId: string;
  recipientPublicKey: string;
  request: VaultProxyRequest;
  responseKey: Uint8Array;
  iv?: Uint8Array;
}): Promise<VaultProxyRelayEnvelope> {
  if (input.responseKey.byteLength !== 32) throw new Error("proxy response key must be 256 bits");
  validateVaultPublicKey(input.recipientPublicKey, "proxy release public key");
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const aad = proxyRequestAad(input.workspaceId, input.requestId);
  const shared = await crypto.subtle.deriveBits(
    { name: "ECDH", public: await importPublicKey(decodeVaultBytes(input.recipientPublicKey, "proxy release public key")) },
    ephemeral.privateKey,
    256,
  );
  const key = await deriveRelayKey(shared, aad, ["encrypt"]);
  const iv = input.iv ?? crypto.getRandomValues(new Uint8Array(VAULT_IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify({ request: input.request, responseKey: encodeVaultBytes(input.responseKey) }));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: ownedBytes(iv), additionalData: ownedBytes(aad) },
    key,
    ownedBytes(plaintext),
  );
  return {
    suite: VAULT_PROXY_REQUEST_SUITE,
    ephemeralPublicKey: encodeVaultBytes(new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey))),
    iv: encodeVaultBytes(iv),
    ciphertext: encodeVaultBytes(new Uint8Array(ciphertext)),
  };
}

export async function openVaultProxyResponse(input: {
  workspaceId: string;
  requestId: string;
  responseKey: Uint8Array;
  envelope: VaultProxyResponseEnvelope;
}): Promise<VaultProxyResult> {
  if (input.envelope.suite !== VAULT_PROXY_RESPONSE_SUITE) throw new Error("unsupported proxy response suite");
  if (input.responseKey.byteLength !== 32) throw new Error("proxy response key must be 256 bits");
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: ownedBytes(decodeVaultBytes(input.envelope.iv, "proxy response iv")),
      additionalData: ownedBytes(proxyResponseAad(input.workspaceId, input.requestId)),
    },
    await crypto.subtle.importKey("raw", ownedBytes(input.responseKey), { name: "AES-GCM" }, false, ["decrypt"]),
    ownedBytes(decodeVaultBytes(input.envelope.ciphertext, "proxy response ciphertext")),
  );
  return validateVaultProxyResult(JSON.parse(new TextDecoder().decode(plaintext)) as unknown);
}

/** Encrypt the bounded, redacted device result for the workspace request that owns it. */
export async function sealVaultProxyResponse(input: {
  workspaceId: string;
  requestId: string;
  responseKey: Uint8Array;
  result: VaultProxyResult;
  iv?: Uint8Array;
}): Promise<VaultProxyResponseEnvelope> {
  if (input.responseKey.byteLength !== 32) throw new Error("proxy response key must be 256 bits");
  const result = validateVaultProxyResult(input.result);
  const iv = input.iv ?? crypto.getRandomValues(new Uint8Array(VAULT_IV_BYTES));
  const key = await crypto.subtle.importKey(
    "raw", ownedBytes(input.responseKey), { name: "AES-GCM" }, false, ["encrypt"],
  );
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: ownedBytes(iv),
      additionalData: ownedBytes(proxyResponseAad(input.workspaceId, input.requestId)),
    },
    key,
    ownedBytes(new TextEncoder().encode(JSON.stringify(result))),
  );
  return {
    suite: VAULT_PROXY_RESPONSE_SUITE,
    iv: encodeVaultBytes(iv),
    ciphertext: encodeVaultBytes(new Uint8Array(ciphertext)),
  };
}

export function proxyRequestAad(workspaceId: string, requestId: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(["lepidy-proxy-request", 1, workspaceId, requestId]));
}

export function proxyResponseAad(workspaceId: string, requestId: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(["lepidy-proxy-response", 1, workspaceId, requestId]));
}

function importPublicKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", ownedBytes(raw), { name: "ECDH", namedCurve: "P-256" }, false, []);
}

async function deriveRelayKey(shared: ArrayBuffer, info: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: ownedBytes(new Uint8Array(0)), info: ownedBytes(info) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    usages,
  );
}

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIpLiteral(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname) || hostname.includes(":") || /^0x[0-9a-f]+$/iu.test(hostname);
}
