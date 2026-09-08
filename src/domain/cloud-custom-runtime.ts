import Anthropic from "@anthropic-ai/sdk";
import ipaddr from "ipaddr.js";

import { redactedError } from "./due-work";

export const MANAGED_AGENTS_BETA = "managed-agents-2026-04-01";
export const ANTHROPIC_VERSION = "2023-06-01";
export const CUSTOM_CALLBACK_KEYS = [
  "type", "version", "delivery_id", "created_at", "workspace_id", "agent_id", "queue_depth",
] as const;
const MAX_CALLBACK_BYTES = 16_384;
const MAX_PROVIDER_ERROR_BYTES = 500;

function safeProviderError(value: string): string {
  return redactedError(value)
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted:provider-token]")
    .replace(/whsec_[A-Za-z0-9_+/=-]+/g, "[redacted:webhook-secret]")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]");
}

export type WifAuthority = {
  issuer: string;
  audience: string;
  subject: string;
  organizationId: string;
  workspaceId: string;
  serviceAccountId: string;
  federationRuleId: string;
};

export function validateProviderSchedule(cron: string, timezone: string): { cron: string; timezone: string } {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5 || fields.some((field) => !/^[0-9*/?,\-]+$/.test(field))) throw new Error("schedule needs a five-field POSIX cron expression");
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error("schedule needs an IANA timezone");
  }
  return { cron: fields.join(" "), timezone };
}

export function validateBudgetChange(currentCents: number | null, nextCents: number | null, consumedCents: number): number | null {
  if (!Number.isSafeInteger(consumedCents) || consumedCents < 0) throw new Error("invalid consumed cost");
  if (currentCents === null && nextCents !== null) throw new Error("a removed session budget cannot be added again");
  if (nextCents !== null && (!Number.isSafeInteger(nextCents) || nextCents <= consumedCents)) throw new Error("new budget must exceed consumed cost");
  return nextCents;
}

export function validateWifAuthority(value: WifAuthority): WifAuthority {
  const issuer = new URL(value.issuer);
  if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.hash) {
    throw new Error("WIF issuer must be an uncredentialed HTTPS URL");
  }
  for (const [name, field] of Object.entries(value)) {
    if (typeof field !== "string" || field.length < 1 || field.length > 500) throw new Error(`invalid WIF ${name}`);
  }
  if (/[*?]/.test(value.subject)) throw new Error("WIF subject must be exact; wildcards are refused");
  return { ...value, issuer: issuer.toString().replace(/\/$/, "") };
}

export async function mintWifAssertion(input: {
  authority: WifAuthority;
  privateJwk: JsonWebKey;
  keyId: string;
  now: number;
}): Promise<string> {
  const authority = validateWifAuthority(input.authority);
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(input.keyId)) throw new Error("invalid WIF key id");
  const algorithm = input.privateJwk.kty === "EC"
    ? ({ name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const)
    : ({ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const);
  const key = await crypto.subtle.importKey("jwk", input.privateJwk, algorithm, false, ["sign"]);
  const issued = Math.floor(input.now / 1000);
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: input.privateJwk.kty === "EC" ? "ES256" : "RS256", typ: "JWT", kid: input.keyId })));
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({ iss: authority.issuer, sub: authority.subject,
    aud: authority.audience, iat: issued, exp: issued + 300, jti: crypto.randomUUID() })));
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(algorithm, key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

export async function exchangeWifAssertion(input: {
  assertion: string;
  fetcher?: typeof fetch;
  tokenUrl?: string;
}): Promise<{ accessToken: string; expiresIn: number }> {
  if (input.assertion.length < 20 || input.assertion.length > 16_384) throw new Error("invalid WIF assertion");
  const response = await (input.fetcher ?? fetch)(input.tokenUrl ?? "https://api.anthropic.com/v1/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: input.assertion,
    }),
    redirect: "manual",
  });
  if (!response.ok) throw new Error(`provider token exchange failed (${response.status})`);
  const body = await response.json() as { access_token?: unknown; expires_in?: unknown; token_type?: unknown };
  if (typeof body.access_token !== "string" || !body.access_token.startsWith("sk-ant-oat01-") ||
      typeof body.expires_in !== "number" || !Number.isFinite(body.expires_in) || body.expires_in <= 0 ||
      body.token_type !== "Bearer") throw new Error("provider returned an unknown token shape");
  return { accessToken: body.access_token, expiresIn: body.expires_in };
}

export type ProviderRequest = {
  method?: "GET" | "POST" | "PATCH";
  path: string;
  body?: unknown;
};

/** A deliberately small Managed Agents client: WIF bearer only, pinned beta, no redirects. */
export async function callManagedAgents(input: ProviderRequest & {
  accessToken: string;
  fetcher?: typeof fetch;
  baseUrl?: string;
}): Promise<unknown> {
  if (!input.accessToken.startsWith("sk-ant-oat01-")) throw new Error("Managed Agents requires a WIF access token");
  if (!/^\/v1\/[a-z0-9_?=&.%/-]+$/i.test(input.path) || input.path.includes("..")) throw new Error("invalid provider path");
  const response = await (input.fetcher ?? fetch)(new URL(input.path, input.baseUrl ?? "https://api.anthropic.com"), {
    method: input.method ?? (input.body === undefined ? "GET" : "POST"),
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-beta": MANAGED_AGENTS_BETA,
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    redirect: "manual",
  });
  if (response.status >= 300 && response.status < 400) throw new Error("provider redirect refused");
  if (!response.ok) {
    const detail = safeProviderError((await response.text()).slice(0, MAX_PROVIDER_ERROR_BYTES));
    throw new Error(`provider request failed (${response.status}): ${detail}`);
  }
  const text = await response.text();
  if (text.length > 1_048_576) throw new Error("provider response is too large");
  return text === "" ? null : JSON.parse(text) as unknown;
}

/** Follow provider cursors as opaque strings; never derive or increment them. */
export async function listManagedAgentResources(input: {
  accessToken: string;
  path: string;
  fetcher?: typeof fetch;
  baseUrl?: string;
  maxPages?: number;
}): Promise<readonly unknown[]> {
  const resources: unknown[] = [];
  let cursor: string | null = null;
  const maxPages = input.maxPages ?? 100;
  for (let page = 0; page < maxPages; page += 1) {
    const separator = input.path.includes("?") ? "&" : "?";
    const response = await callManagedAgents({ accessToken: input.accessToken,
      path: `${input.path}${cursor === null ? "" : `${separator}after_id=${encodeURIComponent(cursor)}`}`,
      fetcher: input.fetcher, baseUrl: input.baseUrl });
    if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error("unknown provider page shape");
    const body = response as Record<string, unknown>;
    if (!Array.isArray(body.data)) throw new Error("unknown provider page shape");
    resources.push(...body.data);
    if (body.has_more !== true) return resources;
    if (typeof body.last_id !== "string" || body.last_id.length < 1 || body.last_id.length > 500 || body.last_id === cursor) {
      throw new Error("invalid provider cursor");
    }
    cursor = body.last_id;
  }
  throw new Error("provider pagination limit exceeded");
}

export type AnthropicThinEvent = {
  type: "event";
  id: string;
  created_at: string;
  data: { type: string; id: string; organization_id: string; workspace_id: string };
};

export function unwrapAnthropicWebhook(input: {
  rawBody: string;
  headers: Headers | Record<string, string>;
  signingSecret: string;
  organizationId: string;
  workspaceId: string;
}): AnthropicThinEvent {
  if (new TextEncoder().encode(input.rawBody).byteLength > MAX_CALLBACK_BYTES) throw new Error("webhook body is too large");
  const headers = input.headers instanceof Headers ? Object.fromEntries(input.headers.entries()) : input.headers;
  const client = new Anthropic({ apiKey: null, authToken: null, webhookKey: input.signingSecret, dangerouslyAllowBrowser: true });
  const event = client.beta.webhooks.unwrap(input.rawBody, { headers }) as AnthropicThinEvent;
  if (event.type !== "event" || typeof event.id !== "string" || event.id !== headers["webhook-id"] ||
      !event.data || event.data.organization_id !== input.organizationId || event.data.workspace_id !== input.workspaceId) {
    throw new Error("webhook authority does not match this integration");
  }
  return event;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const encoded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(encoded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function encryptTransportSecret(secret: string, key: string, context: string): Promise<string> {
  if (secret.length < 16 || secret.length > 4096 || key.length < 32 || context.length < 1) throw new Error("invalid transport secret envelope");
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const cryptoKey = await crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) }, cryptoKey,
    new TextEncoder().encode(secret),
  );
  return `v1.${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptTransportSecret(envelope: string, key: string, context: string): Promise<string> {
  const [version, ivText, ciphertextText, extra] = envelope.split(".");
  if (version !== "v1" || !ivText || !ciphertextText || extra !== undefined || key.length < 32) throw new Error("invalid transport secret envelope");
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const cryptoKey = await crypto.subtle.importKey("raw", material, "AES-GCM", false, ["decrypt"]);
  try {
    const iv = new Uint8Array(fromBase64Url(ivText));
    const ciphertext = new Uint8Array(fromBase64Url(ciphertextText));
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) },
      cryptoKey, ciphertext,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error("transport secret envelope did not authenticate");
  }
}

export type CustomWake = {
  type: "agent.work_available" | "custom.test";
  version: 1;
  delivery_id: string;
  created_at: string;
  workspace_id: string;
  agent_id: string;
  queue_depth: number;
};

export function customWake(input: Omit<CustomWake, "type" | "version"> & { type?: CustomWake["type"] }): CustomWake {
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(input.delivery_id) || !/^[A-Za-z0-9_-]{1,200}$/.test(input.workspace_id) ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(input.agent_id) || !Number.isSafeInteger(input.queue_depth) || input.queue_depth < 0) {
    throw new Error("invalid custom wake metadata");
  }
  if (!Number.isFinite(Date.parse(input.created_at))) throw new Error("invalid custom wake time");
  return { type: input.type ?? "agent.work_available", version: 1, delivery_id: input.delivery_id,
    created_at: input.created_at, workspace_id: input.workspace_id, agent_id: input.agent_id, queue_depth: input.queue_depth };
}

export async function signCustomWake(body: string, deliveryId: string, timestamp: number, secret: string): Promise<string> {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || secret.length < 32) throw new Error("invalid custom callback signature input");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${deliveryId}.${timestamp}.${body}`));
  return `v1=${base64Url(new Uint8Array(mac))}`;
}

function isPublicIp(address: string): boolean {
  try {
    let parsed = ipaddr.parse(address.replace(/^\[|\]$/g, ""));
    if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
      parsed = (parsed as ipaddr.IPv6).toIPv4Address();
    }
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}

export async function validatePublicCallbackUrl(urlText: string, resolve: (hostname: string) => Promise<readonly string[]>): Promise<URL> {
  const url = new URL(urlText);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")) {
    throw new Error("custom callback must be uncredentialed HTTPS on port 443");
  }
  if (!url.hostname.includes(".") || url.hostname.startsWith("[") || /^[0-9.]+$/.test(url.hostname)) throw new Error("custom callback needs a public DNS hostname");
  const addresses = await resolve(url.hostname);
  if (addresses.length === 0 || addresses.some((address) => !isPublicIp(address))) throw new Error("custom callback DNS is not strictly public");
  return url;
}

export async function deliverCustomWake(input: {
  url: string;
  wake: CustomWake;
  secret: string;
  resolve: (hostname: string) => Promise<readonly string[]>;
  fetcher?: typeof fetch;
  now: number;
}): Promise<{ status: "delivered" } | { status: "retry" | "permanent"; error: string }> {
  try {
    const url = await validatePublicCallbackUrl(input.url, input.resolve);
    const body = JSON.stringify(input.wake);
    const timestamp = Math.floor(input.now / 1000);
    const signature = await signCustomWake(body, input.wake.delivery_id, timestamp, input.secret);
    const response = await (input.fetcher ?? fetch)(url, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json", "lepidy-webhook-id": input.wake.delivery_id,
        "lepidy-webhook-timestamp": String(timestamp), "lepidy-webhook-signature": signature }, body,
    });
    if (response.status >= 200 && response.status < 300) return { status: "delivered" };
    if ([408, 425, 429].includes(response.status) || response.status >= 500) return { status: "retry", error: `callback returned ${response.status}` };
    return { status: "permanent", error: `callback returned ${response.status}` };
  } catch (error) {
    return { status: "retry", error: redactedError(error) };
  }
}
