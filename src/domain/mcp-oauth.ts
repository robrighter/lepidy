/**
 * The rules of Lepidy's OAuth 2.1 authorization server and resource server.
 *
 * Everything here is a pure function over values. Hand-rolling an authorization
 * server means taking on the parts of the protocol that are load-bearing for
 * security, so those parts are decided in one place that the unit suite can
 * check exhaustively, rather than inside a route handler that only an
 * integration test ever reaches.
 *
 * Two ideas run through all of it:
 *
 * **A token names its workspace.** Every issued secret carries the workspace
 * slug in its prefix, so a request can be routed to one tenant before anything
 * is looked up, and there is no shared token table for a missing `WHERE` to
 * leak across. The prefix is a routing hint and never an authorisation: the
 * workspace object still has to recognise the hash.
 *
 * **A token names its audience.** RFC 8707 resource indicators are mandatory
 * here, not optional, and the resource server checks the audience it was
 * actually reached at. That is what stops a token minted for one workspace from
 * doing anything at another, even when a client is confused or malicious about
 * which endpoint it is calling.
 */

/**
 * Mint an opaque secret. 32 bytes of randomness is the whole security of a
 * bearer value, so there is one place that produces them.
 */
export function randomSecret(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Every value we mint is greppable and says what it is. */
export const TOKEN_PREFIX = "lpd";

export type TokenKind = "code" | "at" | "rt" | "st";

/** Access tokens are short; the connection, not the token, is the long-lived thing. */
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * An authorization code lives only long enough to be redeemed by a client that
 * is already waiting for it. A minute is generous for that and short enough
 * that a code left in a browser history or a proxy log is inert.
 */
export const AUTHORIZATION_CODE_TTL_MS = 60 * 1000;

/** v1 is coarse: read the workspace, or act in it as the connecting person. */
export const SUPPORTED_SCOPES = ["chat:read", "chat:write", "agent", "vault"] as const;
export type SupportedScope = (typeof SUPPORTED_SCOPES)[number];
export const DEFAULT_SCOPE = "chat:read chat:write";

/* -------------------------------------------------------------------------- */
/* Token shape and workspace routing                                           */
/* -------------------------------------------------------------------------- */

export type ParsedToken = { kind: TokenKind; workspaceSlug: string; secret: string };

const WORKSPACE_SLUG = /^[a-z0-9][a-z0-9-]{1,47}[a-z0-9]$/;
const TOKEN_SECRET = /^[A-Za-z0-9_-]{16,}$/;

/**
 * `lpd_<kind>_<workspace>_<secret>`.
 *
 * The secret is base64url and so may contain `_`, while a workspace slug may
 * not. Splitting at the first three separators and keeping the remainder whole
 * is therefore unambiguous, which matters: a token that parsed two ways would
 * be a token that could be routed two ways.
 */
export function formatToken(kind: TokenKind, workspaceSlug: string, secret: string): string {
  return `${TOKEN_PREFIX}_${kind}_${workspaceSlug}_${secret}`;
}

export function parseToken(value: unknown): ParsedToken | null {
  if (typeof value !== "string") return null;
  const first = value.indexOf("_");
  if (first < 0 || value.slice(0, first) !== TOKEN_PREFIX) return null;
  const second = value.indexOf("_", first + 1);
  if (second < 0) return null;
  const third = value.indexOf("_", second + 1);
  if (third < 0) return null;

  const kind = value.slice(first + 1, second);
  if (kind !== "code" && kind !== "at" && kind !== "rt" && kind !== "st") return null;

  const workspaceSlug = value.slice(second + 1, third);
  if (!WORKSPACE_SLUG.test(workspaceSlug)) return null;

  const secret = value.slice(third + 1);
  if (!TOKEN_SECRET.test(secret)) return null;

  return { kind, workspaceSlug, secret };
}

/**
 * Parse a token and insist it is the kind the caller is handling.
 *
 * The kinds are separated because they are presented at different endpoints for
 * different reasons: a refresh token offered as a bearer credential, or an
 * access token offered at the token endpoint, is a confused client at best.
 */
export function parseTokenOfKind(value: unknown, kind: TokenKind): ParsedToken | null {
  const parsed = parseToken(value);
  return parsed !== null && parsed.kind === kind ? parsed : null;
}

/* -------------------------------------------------------------------------- */
/* Issuer, resource identity and metadata locations                            */
/* -------------------------------------------------------------------------- */

/** No trailing slash, so every URI built from it concatenates predictably. */
export function normaliseIssuer(origin: string): string {
  return origin.replace(/\/+$/, "");
}

/**
 * The origin every issued URI is built from.
 *
 * Taken from the `Host` header the client actually addressed, not from
 * configuration and not from `request.url` — the runtime in front of us may
 * have rewritten that, and it does locally, turning `127.0.0.1` into
 * `localhost`. An issuer or an audience that does not match what the client
 * typed would make every RFC 8707 comparison fail for a legitimate client, so
 * the one thing the client is certain about is what we use.
 */
export function originFromHeaders(host: string | null, forwardedProto: string | null, fallback: string): string {
  if (host === null || host.length === 0) return fallback;
  const proto = (forwardedProto ?? "").split(",")[0].trim();
  if (proto === "http" || proto === "https") return `${proto}://${host}`;
  const loopback = host.startsWith("localhost") || host.startsWith("127.0.0.1") || host.startsWith("[::1]");
  return `${loopback ? "http" : "https"}://${host}`;
}

/**
 * The canonical resource URI a workspace's tokens are bound to, and the address
 * of its MCP endpoint. One string, so the audience a token carries and the
 * endpoint it may be used at cannot drift apart.
 */
export function workspaceResourceUri(origin: string, workspaceSlug: string): string {
  return `${normaliseIssuer(origin)}/w/${workspaceSlug}/mcp`;
}

/**
 * RFC 9728 locates a resource's metadata by inserting the well-known segment
 * before the resource's own path, rather than at the root, so one host can
 * describe many protected resources. That is exactly our case: one deployment,
 * one protected resource per workspace.
 */
export function protectedResourceMetadataUrl(origin: string, workspaceSlug: string): string {
  return `${normaliseIssuer(origin)}/.well-known/oauth-protected-resource/w/${workspaceSlug}/mcp`;
}

/** Recover the workspace a `/w/<slug>/mcp` style path speaks for. */
export function workspaceSlugFromResource(resource: string): string | null {
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    return null;
  }
  const match = /^\/w\/([^/]+)\/mcp$/.exec(url.pathname);
  if (match === null) return null;
  return WORKSPACE_SLUG.test(match[1]) ? match[1] : null;
}

/* -------------------------------------------------------------------------- */
/* Resource indicators (RFC 8707)                                              */
/* -------------------------------------------------------------------------- */

export type ResourceCheck =
  | { ok: true; resource: string }
  | { ok: false; error: "invalid_target"; description: string };

/**
 * A resource indicator must be an absolute URI without a fragment, and must
 * name the workspace whose authorization this is. Anything else is refused
 * rather than defaulted: a token minted for an audience nobody asked for is
 * the bug this parameter exists to prevent.
 */
export function checkResourceIndicator(value: unknown, expected: string): ResourceCheck {
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, error: "invalid_target", description: "a resource indicator is required" };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: "invalid_target", description: "resource must be an absolute URI" };
  }
  if (url.hash !== "") {
    return { ok: false, error: "invalid_target", description: "resource must not carry a fragment" };
  }
  // Compared as written, not case-folded or path-normalised. The audience is a
  // shared constant both sides derive the same way; tolerating near-misses here
  // would mean tolerating a near-miss at the resource server too.
  if (value !== expected) {
    return {
      ok: false,
      error: "invalid_target",
      description: "resource does not name this workspace",
    };
  }
  return { ok: true, resource: value };
}

/* -------------------------------------------------------------------------- */
/* PKCE (RFC 7636)                                                             */
/* -------------------------------------------------------------------------- */

const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

/**
 * Only S256. OAuth 2.1 removes `plain`, and accepting it would mean an
 * intercepted authorization request carries its own proof of possession.
 */
export function parseCodeChallenge(
  challenge: unknown,
  method: unknown,
): { challenge: string } | null {
  if (method !== undefined && method !== null && method !== "S256") return null;
  if (typeof challenge !== "string" || !CODE_CHALLENGE.test(challenge)) return null;
  return { challenge };
}

/** RFC 7636 §4.1: 43–128 characters from the unreserved set. */
export function isWellFormedCodeVerifier(value: unknown): value is string {
  return typeof value === "string" && CODE_VERIFIER.test(value);
}

/**
 * BASE64URL(SHA256(ASCII(verifier))) === challenge.
 *
 * Async because Workers' SubtleCrypto is; comparison is length-independent and
 * constant-time over the bytes it does compare, so a mismatch says nothing
 * about how much of the challenge was right.
 */
export async function verifyCodeVerifier(verifier: unknown, challenge: string): Promise<boolean> {
  if (!isWellFormedCodeVerifier(verifier)) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return constantTimeEquals(base64url(new Uint8Array(digest)), challenge);
}

/**
 * The only form of a secret we ever store: SHA-256, lowercase hex.
 *
 * Hex rather than raw bytes because these values are compared in JavaScript as
 * well as in SQL — a rotated refresh token is recognised by comparing it with
 * the one generation we keep — and one spelling everywhere means the two
 * comparisons cannot disagree.
 */
export async function hashSecret(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Compares every character of the shorter string, and never short-circuits. */
export function constantTimeEquals(a: string, b: string): boolean {
  let difference = a.length ^ b.length;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

/* -------------------------------------------------------------------------- */
/* Client registration (RFC 7591) and redirect URIs                            */
/* -------------------------------------------------------------------------- */

export type ClientRegistration = {
  clientName: string | null;
  redirectUris: readonly string[];
};

export type RegistrationResult =
  | { ok: true; registration: ClientRegistration }
  | { ok: false; error: "invalid_client_metadata" | "invalid_redirect_uri"; description: string };

const MAX_REDIRECT_URIS = 8;
const MAX_CLIENT_NAME = 120;

/**
 * Registration is open, because MCP clients register themselves before anybody
 * has signed in. A client id therefore proves nothing at all — it is a label,
 * not a credential — and every decision that matters is taken later, at the
 * authorization endpoint, by a signed-in person looking at a consent screen.
 */
export function parseClientRegistration(body: unknown): RegistrationResult {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "invalid_client_metadata", description: "a JSON object is required" };
  }
  const input = body as Record<string, unknown>;

  const method = input.token_endpoint_auth_method;
  if (method !== undefined && method !== "none") {
    return {
      ok: false,
      error: "invalid_client_metadata",
      description: "only public clients are supported; use PKCE rather than a client secret",
    };
  }

  const grantTypes = input.grant_types;
  if (grantTypes !== undefined) {
    if (!Array.isArray(grantTypes)) {
      return { ok: false, error: "invalid_client_metadata", description: "grant_types must be an array" };
    }
    for (const grant of grantTypes) {
      if (grant !== "authorization_code" && grant !== "refresh_token") {
        return {
          ok: false,
          error: "invalid_client_metadata",
          description: `unsupported grant type ${String(grant)}`,
        };
      }
    }
  }

  const uris = input.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) {
    return { ok: false, error: "invalid_redirect_uri", description: "at least one redirect URI is required" };
  }
  if (uris.length > MAX_REDIRECT_URIS) {
    return { ok: false, error: "invalid_redirect_uri", description: "too many redirect URIs" };
  }
  const redirectUris: string[] = [];
  for (const uri of uris) {
    if (!isRegistrableRedirectUri(uri)) {
      return {
        ok: false,
        error: "invalid_redirect_uri",
        description: `redirect URI is not usable: ${String(uri)}`,
      };
    }
    if (!redirectUris.includes(uri)) redirectUris.push(uri);
  }

  const name = input.client_name;
  const clientName =
    typeof name === "string" && name.trim().length > 0 ? name.trim().slice(0, MAX_CLIENT_NAME) : null;

  return { ok: true, registration: { clientName, redirectUris } };
}

/**
 * What a client may register: HTTPS for anything hosted, loopback HTTP for a
 * command-line tool that listens on a port it chose at start-up, and a
 * private-use scheme for a native application. Plain HTTP to any other host is
 * refused, because that is a redirect somebody else can read.
 */
export function isRegistrableRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash !== "") return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return isLoopbackHost(url.hostname);
  // A private-use scheme must be a reverse-DNS name, which is what makes it
  // claimable by exactly one installed application.
  return /^[a-z][a-z0-9+.-]*\.[a-z0-9+.-]+:$/.test(url.protocol);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1" || hostname === "localhost";
}

/**
 * OAuth 2.1 requires exact string comparison against what was registered, with
 * one carve-out: a loopback client cannot know its port until it starts, so the
 * port alone may differ. Everything else — scheme, host, path, query — must be
 * identical, because a redirect URI is where an authorization code is delivered.
 */
export function redirectUriAllowed(registered: readonly string[], requested: unknown): boolean {
  if (typeof requested !== "string" || requested.length === 0) return false;
  if (registered.includes(requested)) return true;

  let candidate: URL;
  try {
    candidate = new URL(requested);
  } catch {
    return false;
  }
  if (candidate.protocol !== "http:" || !isLoopbackHost(candidate.hostname)) return false;

  return registered.some((entry) => {
    let known: URL;
    try {
      known = new URL(entry);
    } catch {
      return false;
    }
    return (
      known.protocol === "http:" &&
      known.hostname === candidate.hostname &&
      known.pathname === candidate.pathname &&
      known.search === candidate.search
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Scope                                                                       */
/* -------------------------------------------------------------------------- */

export type ScopeResult =
  | { ok: true; scope: string }
  | { ok: false; error: "invalid_scope"; description: string };

/**
 * An unrecognised scope is refused rather than dropped. Silently narrowing a
 * request means the client believes it holds something it does not, and finds
 * out at the first call that matters.
 */
export function parseScope(requested: unknown): ScopeResult {
  if (requested === undefined || requested === null || requested === "") {
    return { ok: true, scope: DEFAULT_SCOPE };
  }
  if (typeof requested !== "string") {
    return { ok: false, error: "invalid_scope", description: "scope must be a string" };
  }
  const parts = requested.split(/\s+/).filter((part) => part.length > 0);
  if (parts.length === 0) return { ok: true, scope: DEFAULT_SCOPE };

  const granted: string[] = [];
  for (const part of parts) {
    if (!(SUPPORTED_SCOPES as readonly string[]).includes(part)) {
      return { ok: false, error: "invalid_scope", description: `unknown scope ${part}` };
    }
    if (!granted.includes(part)) granted.push(part);
  }
  return { ok: true, scope: granted.join(" ") };
}

export function scopeAllows(scope: string, required: SupportedScope): boolean {
  return scope.split(/\s+/).includes(required);
}

/* -------------------------------------------------------------------------- */
/* Bearer presentation and the 401 challenge (RFC 6750, RFC 9728)              */
/* -------------------------------------------------------------------------- */

/** Only the header form. A token in a query string is a token in an access log. */
export function bearerFromHeader(header: string | null): string | null {
  if (header === null) return null;
  const match = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(header.trim());
  return match === null ? null : match[1];
}

/**
 * An MCP client discovers where to authenticate from the challenge on the 401,
 * so an unauthenticated request has to answer with one that points at this
 * workspace's own metadata. Without it the client has nothing to go on.
 */
export function bearerChallenge(input: {
  resourceMetadataUrl: string;
  error?: "invalid_token" | "insufficient_scope";
  description?: string;
}): string {
  const parts = [`Bearer resource_metadata="${input.resourceMetadataUrl}"`];
  if (input.error !== undefined) parts.push(`error="${input.error}"`);
  if (input.description !== undefined) {
    parts.push(`error_description="${input.description.replaceAll('"', "'")}"`);
  }
  return parts.join(", ");
}

/* -------------------------------------------------------------------------- */
/* The decisions the endpoints make                                            */
/* -------------------------------------------------------------------------- */

export type AuthorizationRequest = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string;
  state: string | null;
};

export type AuthorizationRequestResult =
  | { ok: true; request: AuthorizationRequest }
  /** Refusals a client may be told about by redirecting back to it. */
  | { ok: false; redirectable: true; error: string; description: string }
  /**
   * Refusals that must be shown to the person instead. A bad `client_id` or a
   * redirect URI that was never registered cannot be reported by redirecting to
   * it — that would make the authorization server an open redirector, and would
   * report our refusal to whoever chose the address.
   */
  | { ok: false; redirectable: false; error: string; description: string };

/**
 * Validate an authorization request against a registered client and the
 * workspace it names. This decides everything except whether the person
 * consents, which is not a rule and belongs to them.
 */
export function checkAuthorizationRequest(input: {
  params: Record<string, string | null | undefined>;
  client: { clientId: string; redirectUris: readonly string[] } | null;
  expectedResource: string;
}): AuthorizationRequestResult {
  const { params, client, expectedResource } = input;

  if (client === null) {
    return { ok: false, redirectable: false, error: "invalid_client", description: "unknown client" };
  }
  const redirectUri = params.redirect_uri ?? null;
  if (redirectUri === null || !redirectUriAllowed(client.redirectUris, redirectUri)) {
    return {
      ok: false,
      redirectable: false,
      error: "invalid_request",
      description: "redirect_uri does not match this client's registration",
    };
  }

  const state = typeof params.state === "string" && params.state.length > 0 ? params.state : null;

  if (params.response_type !== "code") {
    return {
      ok: false,
      redirectable: true,
      error: "unsupported_response_type",
      description: "only the authorization code flow is supported",
    };
  }

  const challenge = parseCodeChallenge(params.code_challenge, params.code_challenge_method);
  if (challenge === null) {
    return {
      ok: false,
      redirectable: true,
      error: "invalid_request",
      description: "a PKCE S256 code_challenge is required",
    };
  }

  const resource = checkResourceIndicator(params.resource, expectedResource);
  if (!resource.ok) {
    return { ok: false, redirectable: true, error: resource.error, description: resource.description };
  }

  const scope = parseScope(params.scope);
  if (!scope.ok) {
    return { ok: false, redirectable: true, error: scope.error, description: scope.description };
  }

  return {
    ok: true,
    request: {
      clientId: client.clientId,
      redirectUri,
      codeChallenge: challenge.challenge,
      scope: scope.scope,
      resource: resource.resource,
      state,
    },
  };
}

/**
 * RFC 9207: the response carries the issuer that produced it, so a client that
 * talks to more than one authorization server cannot have a code from one
 * accepted as a code from another.
 */
export function authorizationRedirect(input: {
  redirectUri: string;
  issuer: string;
  code?: string;
  state: string | null;
  error?: string;
  errorDescription?: string;
}): string {
  const url = new URL(input.redirectUri);
  if (input.code !== undefined) url.searchParams.set("code", input.code);
  if (input.error !== undefined) {
    url.searchParams.set("error", input.error);
    if (input.errorDescription !== undefined) {
      url.searchParams.set("error_description", input.errorDescription);
    }
  }
  if (input.state !== null) url.searchParams.set("state", input.state);
  url.searchParams.set("iss", normaliseIssuer(input.issuer));
  return url.toString();
}

export type StoredCode = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  expiresAt: number;
  consumedAt: number | null;
};

export type CodeExchangeResult =
  | { ok: true }
  | { ok: false; error: "invalid_grant" | "invalid_client" | "invalid_target"; description: string };

/**
 * Everything a code exchange must agree with, decided in one place.
 *
 * The redirect URI and the client id are re-checked here even though the code
 * was minted against them, because a code is a bearer value until it is bound:
 * the binding is only real if it is verified at redemption. The PKCE proof is
 * checked by the caller, which has to await a digest.
 */
export function checkCodeExchange(input: {
  stored: StoredCode | null;
  clientId: string;
  redirectUri: unknown;
  resource: unknown;
  now: number;
}): CodeExchangeResult {
  const { stored } = input;
  if (stored === null) {
    return { ok: false, error: "invalid_grant", description: "unknown or already used code" };
  }
  if (stored.consumedAt !== null) {
    return { ok: false, error: "invalid_grant", description: "unknown or already used code" };
  }
  if (stored.expiresAt <= input.now) {
    return { ok: false, error: "invalid_grant", description: "the code has expired" };
  }
  if (stored.clientId !== input.clientId) {
    return { ok: false, error: "invalid_client", description: "the code was issued to another client" };
  }
  if (input.redirectUri !== stored.redirectUri) {
    return { ok: false, error: "invalid_grant", description: "redirect_uri does not match the code" };
  }
  // A resource sent at redemption must agree with the one the code was bound
  // to. Omitting it keeps the binding rather than widening it.
  if (input.resource !== undefined && input.resource !== null && input.resource !== "") {
    const check = checkResourceIndicator(input.resource, stored.resource);
    if (!check.ok) return { ok: false, error: "invalid_target", description: check.description };
  }
  return { ok: true };
}

export type StoredConnection = {
  refreshTokenHash: string;
  previousRefreshTokenHash: string | null;
  clientId: string;
  revokedAt: number | null;
};

export type RefreshDecision =
  | { kind: "rotate" }
  /**
   * A refresh token that was already rotated away has been presented. Either it
   * leaked or the client is retrying a call whose answer it lost — and the two
   * are indistinguishable from here, so the safe reading is the first. The
   * whole connection dies and the person reconnects.
   */
  | { kind: "replay"; description: string }
  | { kind: "refuse"; error: "invalid_grant" | "invalid_client"; description: string };

export function decideRefresh(input: {
  connection: StoredConnection | null;
  presentedHash: string;
  clientId: string;
}): RefreshDecision {
  const { connection } = input;
  if (connection === null) {
    return { kind: "refuse", error: "invalid_grant", description: "unknown refresh token" };
  }
  if (connection.clientId !== input.clientId) {
    return { kind: "refuse", error: "invalid_client", description: "the token belongs to another client" };
  }
  if (connection.revokedAt !== null) {
    return { kind: "refuse", error: "invalid_grant", description: "this connection was revoked" };
  }
  if (
    connection.previousRefreshTokenHash !== null &&
    constantTimeEquals(connection.previousRefreshTokenHash, input.presentedHash)
  ) {
    return { kind: "replay", description: "a rotated refresh token was presented again" };
  }
  if (!constantTimeEquals(connection.refreshTokenHash, input.presentedHash)) {
    return { kind: "refuse", error: "invalid_grant", description: "unknown refresh token" };
  }
  return { kind: "rotate" };
}

export type PresentedToken = {
  connectionId: string;
  resource: string;
  accessExpiresAt: number;
  revokedAt: number | null;
  scope: string;
};

export type TokenVerdict =
  | { ok: true }
  | { ok: false; error: "invalid_token" | "insufficient_scope"; description: string };

/**
 * What the resource server decides about a token it has already found.
 *
 * The audience check is the one that stops a token being useful anywhere other
 * than where it was meant to be used, so it compares against the resource URI
 * of the endpoint this request actually arrived at — not the one the token
 * claims, and not the one the client asked for.
 */
export function checkPresentedToken(input: {
  token: PresentedToken | null;
  audience: string;
  now: number;
  requiredScope?: SupportedScope;
}): TokenVerdict {
  const { token } = input;
  if (token === null) return { ok: false, error: "invalid_token", description: "unknown token" };
  if (token.revokedAt !== null) {
    return { ok: false, error: "invalid_token", description: "this connection was revoked" };
  }
  if (token.accessExpiresAt <= input.now) {
    return { ok: false, error: "invalid_token", description: "the access token has expired" };
  }
  if (token.resource !== input.audience) {
    return {
      ok: false,
      error: "invalid_token",
      description: "the token was issued for a different workspace",
    };
  }
  if (input.requiredScope !== undefined && !scopeAllows(token.scope, input.requiredScope)) {
    return {
      ok: false,
      error: "insufficient_scope",
      description: `this connection does not hold the ${input.requiredScope} scope`,
    };
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Metadata documents                                                          */
/* -------------------------------------------------------------------------- */

export function authorizationServerMetadata(origin: string): Record<string, unknown> {
  const issuer = normaliseIssuer(origin);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/api/oauth/token`,
    registration_endpoint: `${issuer}/api/oauth/register`,
    revocation_endpoint: `${issuer}/api/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...SUPPORTED_SCOPES],
    authorization_response_iss_parameter_supported: true,
  };
}

export function protectedResourceMetadata(
  origin: string,
  workspaceSlug: string,
): Record<string, unknown> {
  return {
    resource: workspaceResourceUri(origin, workspaceSlug),
    authorization_servers: [normaliseIssuer(origin)],
    scopes_supported: [...SUPPORTED_SCOPES],
    bearer_methods_supported: ["header"],
  };
}

/* -------------------------------------------------------------------------- */
/* MCP tool protocol                                                           */
/* -------------------------------------------------------------------------- */

export type McpToolName =
  | "whoami"
  | "list_channels"
  | "read_channel"
  | "read_thread"
  | "post_message"
  | "list_agents"
  | "agent_inbox"
  | "agent_next"
  | "agent_start"
  | "agent_renew"
  | "agent_complete"
  | "agent_mark_read"
  | "agent_mark_unread"
  | "agent_post"
  | "agent_get_prompt"
  | "agent_set_prompt";

export type McpToolDefinition = {
  name: McpToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  requiredScope: SupportedScope;
  /** Whether an unattended runner session may ever receive this capability. */
  sessionCapable: boolean;
};

const objectSchema = (
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): Record<string, unknown> => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required: [...required] } : {}),
  additionalProperties: false,
});

const string = (description: string, maxLength = 256) => ({ type: "string", description, maxLength });
const integer = (minimum: number, maximum: number) => ({ type: "integer", minimum, maximum });

/** The advertised surface is one constant, so listing and dispatch cannot drift. */
export const MCP_TOOL_DEFINITIONS: readonly McpToolDefinition[] = [
  {
    name: "whoami",
    description: "Return the workspace member and MCP connection this request acts as.",
    inputSchema: objectSchema({}),
    requiredScope: "chat:read",
    sessionCapable: true,
  },
  {
    name: "list_channels",
    description: "List rooms and conversations the connected member has joined.",
    inputSchema: objectSchema({ include_dms: { type: "boolean" } }),
    requiredScope: "chat:read",
    sessionCapable: true,
  },
  {
    name: "read_channel",
    description: "Read a joined room newest-first with opaque keyset pagination.",
    inputSchema: objectSchema(
      { channel_id: string("Room id"), cursor: string("Opaque cursor", 1024), limit: integer(1, 100) },
      ["channel_id"],
    ),
    requiredScope: "chat:read",
    sessionCapable: true,
  },
  {
    name: "read_thread",
    description: "Read replies in a visible thread oldest-first with opaque keyset pagination.",
    inputSchema: objectSchema(
      { message_id: string("Thread root message id"), cursor: string("Opaque cursor", 1024), limit: integer(1, 100) },
      ["message_id"],
    ),
    requiredScope: "chat:read",
    sessionCapable: true,
  },
  {
    name: "post_message",
    description: "Post as the connected member with durable MCP attribution; never joins a room automatically.",
    inputSchema: objectSchema(
      {
        channel_id: string("Joined room id"),
        content: string("Markdown message", 8000),
        parent_id: string("Optional thread root id"),
        idempotency_key: string("Stable retry key", 200),
      },
      ["channel_id", "content", "idempotency_key"],
    ),
    requiredScope: "chat:write",
    sessionCapable: false,
  },
  {
    name: "list_agents",
    description: "List only agents the connected member owns, with scope and unread depth.",
    inputSchema: objectSchema({}),
    requiredScope: "agent",
    sessionCapable: true,
  },
  {
    name: "agent_inbox",
    description: "Read an owned agent's mention inbox. Delivery marks items read unless peek is true.",
    inputSchema: objectSchema(
      {
        agent: string("Agent id or a.handle"),
        filter: { type: "string", enum: ["unread", "all"] },
        order: { type: "string", enum: ["newest", "oldest"] },
        limit: integer(1, 100),
        cursor: string("Opaque cursor", 1024),
        peek: { type: "boolean" },
      },
      ["agent"],
    ),
    requiredScope: "agent",
    sessionCapable: true,
  },
  {
    name: "agent_next",
    description:
      "Claim the oldest eligible item for an owned agent under a 60-second fenced lease. This call never parks.",
    inputSchema: objectSchema(
      {
        agent: string("Agent id or a.handle"),
        claim_id: string("Stable retry id", 200),
        lease_token: string("Runner-generated random lease secret", 512),
        session_id: string("Current runner session id", 200),
        peek: { type: "boolean" },
      },
      ["agent", "claim_id", "lease_token", "session_id"],
    ),
    requiredScope: "agent",
    sessionCapable: true,
  },
  {
    name: "agent_start",
    description: "Record execution start under the exact current lease before launching external work.",
    inputSchema: leaseProofSchema(),
    requiredScope: "agent",
    sessionCapable: true,
  },
  {
    name: "agent_renew",
    description: "Renew the exact current fenced lease for another 60 seconds.",
    inputSchema: leaseProofSchema(),
    requiredScope: "agent",
    sessionCapable: true,
  },
  {
    name: "agent_complete",
    description: "Idempotently complete the exact current lease with a stable completion id and output digest.",
    inputSchema: objectSchema(
      {
        ...(leaseProofSchema().properties as Record<string, unknown>),
        completion_id: string("Stable completion retry id", 200),
        output_digest: string("Digest of the recorded outcome", 256),
        result: { type: "object" },
      },
      ["agent", "item_id", "session_id", "lease_generation", "lease_token", "completion_id", "output_digest"],
    ),
    requiredScope: "agent",
    sessionCapable: true,
  },
  {
    name: "agent_mark_read",
    description: "Mark one item in an owned agent's display inbox read.",
    inputSchema: objectSchema({ agent: string("Agent id or a.handle"), item_id: string("Queue item id") }, ["agent", "item_id"]),
    requiredScope: "agent",
    sessionCapable: true,
  },
  {
    name: "agent_mark_unread",
    description: "Mark one item in an owned agent's display inbox unread without changing execution state.",
    inputSchema: objectSchema({ agent: string("Agent id or a.handle"), item_id: string("Queue item id") }, ["agent", "item_id"]),
    requiredScope: "agent",
    sessionCapable: true,
  },
  {
    name: "agent_post",
    description: "Post as an owned agent in-scope, with its operating owner and connection recorded server-side.",
    inputSchema: objectSchema(
      {
        agent: string("Agent id or a.handle"),
        channel_id: string("Joined, in-scope room id"),
        content: string("Markdown message", 8000),
        parent_id: string("Optional thread root id"),
        idempotency_key: string("Stable retry key", 200),
      },
      ["agent", "channel_id", "content", "idempotency_key"],
    ),
    requiredScope: "agent",
    sessionCapable: true,
  },
  {
    name: "agent_get_prompt",
    description: "Return the security preamble and standing brief for an owned agent.",
    inputSchema: objectSchema({ agent: string("Agent id or a.handle") }, ["agent"]),
    requiredScope: "agent",
    sessionCapable: true,
  },
  {
    name: "agent_set_prompt",
    description: "Replace the standing brief for an owned agent. The security preamble is immutable.",
    inputSchema: objectSchema(
      { agent: string("Agent id or a.handle"), prompt: { type: ["string", "null"], maxLength: 12000 } },
      ["agent", "prompt"],
    ),
    requiredScope: "agent",
    sessionCapable: false,
  },
] as const;

export function mcpToolDefinition(name: unknown): McpToolDefinition | null {
  return MCP_TOOL_DEFINITIONS.find((tool) => tool.name === name) ?? null;
}

export type ParsedMcpToolCall = { name: McpToolName; arguments: Record<string, unknown> };

export type McpToolCallResult =
  | { ok: true; call: ParsedMcpToolCall; requiredScope: SupportedScope }
  | { ok: false; code: -32602; message: string };

/**
 * Protocol-shaped validation lives here, not in the route. Business methods
 * still validate authority and content; this only establishes a total MCP call
 * shape and rejects unknown fields before dispatch.
 */
export function parseMcpToolCall(params: unknown): McpToolCallResult {
  if (!isRecord(params) || typeof params.name !== "string") {
    return { ok: false, code: -32602, message: "tools/call requires a tool name" };
  }
  const tool = mcpToolDefinition(params.name);
  if (tool === null) return { ok: false, code: -32602, message: `unknown tool ${params.name}` };
  const args = params.arguments === undefined ? {} : params.arguments;
  if (!isRecord(args)) return { ok: false, code: -32602, message: "tool arguments must be an object" };

  const schema = tool.inputSchema as { properties: Record<string, unknown>; required?: string[] };
  for (const key of Object.keys(args)) {
    if (!(key in schema.properties)) return { ok: false, code: -32602, message: `unknown argument ${key}` };
  }
  for (const key of schema.required ?? []) {
    if (!(key in args)) return { ok: false, code: -32602, message: `missing argument ${key}` };
  }
  for (const [key, value] of Object.entries(args)) {
    if (!matchesProperty(value, schema.properties[key])) {
      return { ok: false, code: -32602, message: `invalid argument ${key}` };
    }
  }
  return { ok: true, call: { name: tool.name, arguments: args }, requiredScope: tool.requiredScope };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function leaseProofSchema(): Record<string, unknown> {
  return objectSchema(
    {
      agent: string("Agent id or a.handle"),
      item_id: string("Queue item id"),
      session_id: string("Current runner session id", 200),
      lease_generation: integer(1, Number.MAX_SAFE_INTEGER),
      lease_token: string("Lease secret returned by the runner", 512),
    },
    ["agent", "item_id", "session_id", "lease_generation", "lease_token"],
  );
}

function matchesProperty(value: unknown, raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  const types = Array.isArray(raw.type) ? raw.type : [raw.type];
  if (value === null) return types.includes("null");
  if (types.includes("string") && typeof value === "string") {
    if (typeof raw.maxLength === "number" && value.length > raw.maxLength) return false;
    return !Array.isArray(raw.enum) || raw.enum.includes(value);
  }
  if (types.includes("boolean") && typeof value === "boolean") return true;
  if (types.includes("object") && isRecord(value)) return true;
  if (types.includes("integer") && Number.isSafeInteger(value)) {
    return (
      (typeof raw.minimum !== "number" || (value as number) >= raw.minimum) &&
      (typeof raw.maximum !== "number" || (value as number) <= raw.maximum)
    );
  }
  return false;
}

export function encodeAgentQueueCursor(cursor: { enqueuedAt: number; messageId: string }): string {
  return base64url(new TextEncoder().encode(JSON.stringify({ v: 1, t: cursor.enqueuedAt, m: cursor.messageId })));
}

export function parseAgentQueueCursor(value: unknown): { enqueuedAt: number; messageId: string } | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) return null;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
    const parsed = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)))) as unknown;
    if (!isRecord(parsed) || parsed.v !== 1 || !Number.isSafeInteger(parsed.t) || typeof parsed.m !== "string") {
      return null;
    }
    return { enqueuedAt: parsed.t as number, messageId: parsed.m };
  } catch {
    return null;
  }
}

export const MCP_WRITE_LIMIT = 20;
export const MCP_WRITE_WINDOW_MS = 60_000;

export function nextMcpWriteWindow(input: {
  now: number;
  windowStartedAt: number | null;
  writeCount: number;
}): { allowed: boolean; windowStartedAt: number; writeCount: number; retryAfterMs: number } {
  if (input.windowStartedAt === null || input.now - input.windowStartedAt >= MCP_WRITE_WINDOW_MS) {
    return { allowed: true, windowStartedAt: input.now, writeCount: 1, retryAfterMs: 0 };
  }
  if (input.writeCount >= MCP_WRITE_LIMIT) {
    return {
      allowed: false,
      windowStartedAt: input.windowStartedAt,
      writeCount: input.writeCount,
      retryAfterMs: Math.max(1, input.windowStartedAt + MCP_WRITE_WINDOW_MS - input.now),
    };
  }
  return {
    allowed: true,
    windowStartedAt: input.windowStartedAt,
    writeCount: input.writeCount + 1,
    retryAfterMs: 0,
  };
}
