import { describe, expect, it } from "vitest";

import {
  ACCESS_TOKEN_TTL_MS,
  AUTHORIZATION_CODE_TTL_MS,
  DEFAULT_SCOPE,
  authorizationRedirect,
  authorizationServerMetadata,
  base64url,
  bearerChallenge,
  bearerFromHeader,
  checkAuthorizationRequest,
  checkCodeExchange,
  checkPresentedToken,
  checkResourceIndicator,
  constantTimeEquals,
  decideRefresh,
  formatToken,
  isRegistrableRedirectUri,
  isWellFormedCodeVerifier,
  originFromHeaders,
  parseClientRegistration,
  parseCodeChallenge,
  parseScope,
  parseToken,
  parseTokenOfKind,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
  redirectUriAllowed,
  scopeAllows,
  verifyCodeVerifier,
  workspaceResourceUri,
  workspaceSlugFromResource,
} from "./mcp-oauth";

const ORIGIN = "https://lepidy.test";
const SLUG = "acme-tools";
const RESOURCE = `${ORIGIN}/w/${SLUG}/mcp`;

/** A verifier and the challenge it hashes to, computed once for the suite. */
async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

const VERIFIER = "a".repeat(64);

describe("MCP-RULE-001 a token names the workspace it belongs to", () => {
  it("round-trips through one unambiguous spelling", () => {
    const token = formatToken("at", SLUG, "AbC-123_xyz789ABCdef");
    expect(token).toBe(`lpd_at_${SLUG}_AbC-123_xyz789ABCdef`);
    expect(parseToken(token)).toEqual({
      kind: "at",
      workspaceSlug: SLUG,
      secret: "AbC-123_xyz789ABCdef",
    });
  });

  it("keeps a base64url secret whole even though it contains the separator", () => {
    // The secret's own underscores must not be read as field boundaries, or one
    // token would route two ways.
    const parsed = parseToken(`lpd_rt_${SLUG}_aa_bb_cc_ddddddddddddddd`);
    expect(parsed).toEqual({
      kind: "rt",
      workspaceSlug: SLUG,
      secret: "aa_bb_cc_ddddddddddddddd",
    });
  });

  it("refuses anything that is not one of the three kinds, or not a slug", () => {
    expect(parseToken(`lpd_session_${SLUG}_abcdefghijklmnop`)).toBeNull();
    expect(parseToken(`lpd_at_UPPER_abcdefghijklmnop`)).toBeNull();
    expect(parseToken(`lpd_at_a_abcdefghijklmnop`)).toBeNull();
    expect(parseToken(`lpd_at_${SLUG}_short`)).toBeNull();
    expect(parseToken(`other_at_${SLUG}_abcdefghijklmnop`)).toBeNull();
    expect(parseToken(`lpd_at_${SLUG}`)).toBeNull();
    expect(parseToken(42)).toBeNull();
    expect(parseToken(null)).toBeNull();
  });

  it("insists a token is the kind the endpoint is handling", () => {
    const refresh = formatToken("rt", SLUG, "abcdefghijklmnop");
    expect(parseTokenOfKind(refresh, "rt")).not.toBeNull();
    // A refresh token offered as a bearer credential is refused rather than
    // looked up, so the two never share a lookup path.
    expect(parseTokenOfKind(refresh, "at")).toBeNull();
    expect(parseTokenOfKind(refresh, "code")).toBeNull();
  });
});

describe("MCP-RULE-002 resource identity is one string both sides derive", () => {
  it("builds the resource URI and its RFC 9728 metadata location", () => {
    expect(workspaceResourceUri(ORIGIN, SLUG)).toBe(RESOURCE);
    expect(workspaceResourceUri(`${ORIGIN}///`, SLUG)).toBe(RESOURCE);
    // The well-known segment is inserted before the resource path, not at the
    // root, so one host can describe a protected resource per workspace.
    expect(protectedResourceMetadataUrl(ORIGIN, SLUG)).toBe(
      `${ORIGIN}/.well-known/oauth-protected-resource/w/${SLUG}/mcp`,
    );
  });

  it("recovers the workspace from a resource URI, and only from that shape", () => {
    expect(workspaceSlugFromResource(RESOURCE)).toBe(SLUG);
    expect(workspaceSlugFromResource(`${ORIGIN}/w/${SLUG}/mcp/extra`)).toBeNull();
    expect(workspaceSlugFromResource(`${ORIGIN}/mcp`)).toBeNull();
    expect(workspaceSlugFromResource("not a url")).toBeNull();
  });
});

describe("MCP-RULE-003 a resource indicator is required and exact", () => {
  it("accepts the workspace's own resource URI", () => {
    expect(checkResourceIndicator(RESOURCE, RESOURCE)).toEqual({ ok: true, resource: RESOURCE });
  });

  it("refuses a missing, relative, fragment-bearing or foreign resource", () => {
    for (const value of [
      undefined,
      "",
      "/w/acme-tools/mcp",
      `${RESOURCE}#part`,
      `${ORIGIN}/w/other-team/mcp`,
      `${RESOURCE}/`,
      "https://evil.test/w/acme-tools/mcp",
    ]) {
      const result = checkResourceIndicator(value, RESOURCE);
      expect(result.ok, `expected ${String(value)} to be refused`).toBe(false);
      if (!result.ok) expect(result.error).toBe("invalid_target");
    }
  });
});

describe("MCP-RULE-004 PKCE is S256 or nothing", () => {
  it("accepts an S256 challenge with or without the method spelled out", () => {
    const challenge = "b".repeat(43);
    expect(parseCodeChallenge(challenge, "S256")).toEqual({ challenge });
    expect(parseCodeChallenge(challenge, undefined)).toEqual({ challenge });
  });

  it("refuses plain, an unknown method and a malformed challenge", () => {
    const challenge = "b".repeat(43);
    expect(parseCodeChallenge(challenge, "plain")).toBeNull();
    expect(parseCodeChallenge(challenge, "S512")).toBeNull();
    expect(parseCodeChallenge("b".repeat(42), "S256")).toBeNull();
    expect(parseCodeChallenge("b".repeat(44), "S256")).toBeNull();
    expect(parseCodeChallenge("has spaces in it".padEnd(43, "x"), "S256")).toBeNull();
    expect(parseCodeChallenge(undefined, "S256")).toBeNull();
  });

  it("bounds a verifier to the unreserved set at RFC 7636's lengths", () => {
    expect(isWellFormedCodeVerifier("c".repeat(43))).toBe(true);
    expect(isWellFormedCodeVerifier("c".repeat(128))).toBe(true);
    expect(isWellFormedCodeVerifier("c".repeat(42))).toBe(false);
    expect(isWellFormedCodeVerifier("c".repeat(129))).toBe(false);
    expect(isWellFormedCodeVerifier(`${"c".repeat(42)}/`)).toBe(false);
  });

  it("verifies a real verifier and refuses every near miss", async () => {
    const challenge = await challengeFor(VERIFIER);
    expect(await verifyCodeVerifier(VERIFIER, challenge)).toBe(true);
    expect(await verifyCodeVerifier(`${VERIFIER.slice(0, 63)}b`, challenge)).toBe(false);
    // A verifier that is not well-formed never reaches the digest at all.
    expect(await verifyCodeVerifier("short", challenge)).toBe(false);
    expect(await verifyCodeVerifier(undefined, challenge)).toBe(false);
    expect(await verifyCodeVerifier(VERIFIER, challenge.slice(0, 42))).toBe(false);
  });

  it("compares without leaking length or position", () => {
    expect(constantTimeEquals("abc", "abc")).toBe(true);
    expect(constantTimeEquals("abc", "abd")).toBe(false);
    expect(constantTimeEquals("abc", "abcd")).toBe(false);
    expect(constantTimeEquals("", "")).toBe(true);
  });
});

describe("MCP-RULE-005 what a client may register as a redirect", () => {
  it("accepts HTTPS, loopback HTTP and a private-use scheme", () => {
    expect(isRegistrableRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isRegistrableRedirectUri("http://127.0.0.1:33418/callback")).toBe(true);
    expect(isRegistrableRedirectUri("http://localhost:6274/oauth/callback")).toBe(true);
    expect(isRegistrableRedirectUri("com.example.app:/callback")).toBe(true);
  });

  it("refuses plain HTTP to a real host, a fragment and anything unparseable", () => {
    expect(isRegistrableRedirectUri("http://example.test/callback")).toBe(false);
    expect(isRegistrableRedirectUri("https://claude.ai/cb#part")).toBe(false);
    expect(isRegistrableRedirectUri("not a uri")).toBe(false);
    expect(isRegistrableRedirectUri("")).toBe(false);
    expect(isRegistrableRedirectUri(undefined)).toBe(false);
  });
});

describe("MCP-RULE-006 a redirect is matched exactly, apart from a loopback port", () => {
  const registered = ["https://claude.ai/api/mcp/auth_callback", "http://127.0.0.1:1234/callback"];

  it("allows the exact registration and a loopback client's chosen port", () => {
    expect(redirectUriAllowed(registered, "https://claude.ai/api/mcp/auth_callback")).toBe(true);
    // The port is the one thing a command-line client cannot know in advance.
    expect(redirectUriAllowed(registered, "http://127.0.0.1:55123/callback")).toBe(true);
  });

  it("refuses a different path, host, scheme, query or a non-loopback near miss", () => {
    expect(redirectUriAllowed(registered, "https://claude.ai/api/mcp/auth_callback/")).toBe(false);
    expect(redirectUriAllowed(registered, "https://claude.ai/api/mcp/auth_callback?x=1")).toBe(false);
    expect(redirectUriAllowed(registered, "https://claude.ai.evil.test/api/mcp/auth_callback")).toBe(false);
    expect(redirectUriAllowed(registered, "http://claude.ai/api/mcp/auth_callback")).toBe(false);
    expect(redirectUriAllowed(registered, "http://127.0.0.1:55123/other")).toBe(false);
    expect(redirectUriAllowed(registered, "http://localhost:55123/callback")).toBe(false);
    expect(redirectUriAllowed(registered, undefined)).toBe(false);
  });
});

describe("MCP-RULE-007 registration is open but bounded", () => {
  it("accepts a public client and normalises its metadata", () => {
    const result = parseClientRegistration({
      client_name: "  Claude Code  ",
      redirect_uris: ["http://127.0.0.1:1234/callback", "http://127.0.0.1:1234/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    });
    expect(result).toEqual({
      ok: true,
      registration: { clientName: "Claude Code", redirectUris: ["http://127.0.0.1:1234/callback"] },
    });
  });

  it("refuses a confidential client, an unsupported grant and bad redirects", () => {
    expect(
      parseClientRegistration({
        redirect_uris: ["https://claude.ai/cb"],
        token_endpoint_auth_method: "client_secret_basic",
      }),
    ).toMatchObject({ ok: false, error: "invalid_client_metadata" });
    expect(
      parseClientRegistration({ redirect_uris: ["https://claude.ai/cb"], grant_types: ["implicit"] }),
    ).toMatchObject({ ok: false, error: "invalid_client_metadata" });
    expect(parseClientRegistration({ redirect_uris: [] })).toMatchObject({
      ok: false,
      error: "invalid_redirect_uri",
    });
    expect(parseClientRegistration({ redirect_uris: ["http://example.test/cb"] })).toMatchObject({
      ok: false,
      error: "invalid_redirect_uri",
    });
    expect(
      parseClientRegistration({ redirect_uris: Array.from({ length: 9 }, (_, i) => `https://a.test/${i}`) }),
    ).toMatchObject({ ok: false, error: "invalid_redirect_uri" });
    expect(parseClientRegistration(null)).toMatchObject({ ok: false });
    expect(parseClientRegistration("nope")).toMatchObject({ ok: false });
  });
});

describe("MCP-RULE-008 an unknown scope is refused, never dropped", () => {
  it("defaults when none is asked for and preserves what is", () => {
    expect(parseScope(undefined)).toEqual({ ok: true, scope: DEFAULT_SCOPE });
    expect(parseScope("")).toEqual({ ok: true, scope: DEFAULT_SCOPE });
    expect(parseScope("  ")).toEqual({ ok: true, scope: DEFAULT_SCOPE });
    expect(parseScope("chat:read agent chat:read")).toEqual({ ok: true, scope: "chat:read agent" });
  });

  it("refuses a scope it does not know rather than quietly narrowing", () => {
    expect(parseScope("chat:read admin")).toMatchObject({ ok: false, error: "invalid_scope" });
    expect(parseScope(["chat:read"])).toMatchObject({ ok: false, error: "invalid_scope" });
  });

  it("answers whether a granted scope carries a right", () => {
    expect(scopeAllows("chat:read chat:write", "chat:write")).toBe(true);
    expect(scopeAllows("chat:read", "chat:write")).toBe(false);
    expect(scopeAllows("chat:read", "chat:read")).toBe(true);
    // Whole tokens only. A scope that merely starts the same is not the same.
    expect(scopeAllows("chat:readonly", "chat:read")).toBe(false);
    expect(scopeAllows("xchat:read", "chat:read")).toBe(false);
  });
});

describe("MCP-RULE-009 how a bearer token may be presented, and refused", () => {
  it("reads only the header form", () => {
    expect(bearerFromHeader("Bearer lpd_at_acme-tools_abcdefghijklmnop")).toBe(
      "lpd_at_acme-tools_abcdefghijklmnop",
    );
    expect(bearerFromHeader("bearer lpd_at_x")).toBeNull();
    expect(bearerFromHeader("Basic abcdef")).toBeNull();
    expect(bearerFromHeader(null)).toBeNull();
    expect(bearerFromHeader("Bearer ")).toBeNull();
  });

  it("points an unauthenticated client at this workspace's own metadata", () => {
    const challenge = bearerChallenge({
      resourceMetadataUrl: protectedResourceMetadataUrl(ORIGIN, SLUG),
      error: "invalid_token",
      description: 'the "token" expired',
    });
    expect(challenge).toBe(
      `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/w/${SLUG}/mcp", ` +
        `error="invalid_token", error_description="the 'token' expired"`,
    );
    // A description can never break out of its own quoted string.
    expect(challenge.match(/"/g)?.length).toBe(6);
  });
});

describe("MCP-RULE-010 an authorization request is checked before anybody is asked to consent", () => {
  const client = { clientId: "client-1", redirectUris: ["https://claude.ai/cb"] };
  const good = {
    response_type: "code",
    client_id: "client-1",
    redirect_uri: "https://claude.ai/cb",
    code_challenge: "b".repeat(43),
    code_challenge_method: "S256",
    resource: RESOURCE,
    scope: "chat:read",
    state: "xyz",
  };

  it("accepts a complete request", () => {
    expect(checkAuthorizationRequest({ params: good, client, expectedResource: RESOURCE })).toEqual({
      ok: true,
      request: {
        clientId: "client-1",
        redirectUri: "https://claude.ai/cb",
        codeChallenge: "b".repeat(43),
        scope: "chat:read",
        resource: RESOURCE,
        state: "xyz",
      },
    });
  });

  it("will not report an unknown client or an unregistered redirect by redirecting", () => {
    // Redirecting these would make the authorization server an open redirector
    // and would report our refusal to whoever chose the address.
    expect(checkAuthorizationRequest({ params: good, client: null, expectedResource: RESOURCE })).toEqual({
      ok: false,
      redirectable: false,
      error: "invalid_client",
      description: "unknown client",
    });
    expect(
      checkAuthorizationRequest({
        params: { ...good, redirect_uri: "https://evil.test/cb" },
        client,
        expectedResource: RESOURCE,
      }),
    ).toMatchObject({ ok: false, redirectable: false, error: "invalid_request" });
  });

  it("reports every other refusal to the registered redirect", () => {
    for (const [params, error] of [
      [{ ...good, response_type: "token" }, "unsupported_response_type"],
      [{ ...good, code_challenge: undefined }, "invalid_request"],
      [{ ...good, code_challenge_method: "plain" }, "invalid_request"],
      [{ ...good, resource: `${ORIGIN}/w/other/mcp` }, "invalid_target"],
      [{ ...good, resource: undefined }, "invalid_target"],
      [{ ...good, scope: "everything" }, "invalid_scope"],
    ] as const) {
      const result = checkAuthorizationRequest({ params, client, expectedResource: RESOURCE });
      expect(result).toMatchObject({ ok: false, redirectable: true, error });
    }
  });
});

describe("MCP-RULE-011 the redirect back always says who issued it", () => {
  it("carries the code, the client's state and the issuer", () => {
    const url = authorizationRedirect({
      redirectUri: "https://claude.ai/cb?keep=1",
      issuer: `${ORIGIN}/`,
      code: "lpd_code_acme-tools_abcdefghijklmnop",
      state: "xyz",
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("keep")).toBe("1");
    expect(parsed.searchParams.get("code")).toBe("lpd_code_acme-tools_abcdefghijklmnop");
    expect(parsed.searchParams.get("state")).toBe("xyz");
    // RFC 9207: without this a code from one authorization server can be
    // accepted as a code from another.
    expect(parsed.searchParams.get("iss")).toBe(ORIGIN);
  });

  it("carries an error the same way, and omits state when none was sent", () => {
    const parsed = new URL(
      authorizationRedirect({
        redirectUri: "https://claude.ai/cb",
        issuer: ORIGIN,
        state: null,
        error: "access_denied",
        errorDescription: "the person declined",
      }),
    );
    expect(parsed.searchParams.get("error")).toBe("access_denied");
    expect(parsed.searchParams.get("error_description")).toBe("the person declined");
    expect(parsed.searchParams.has("state")).toBe(false);
    expect(parsed.searchParams.has("code")).toBe(false);
  });
});

describe("MCP-RULE-012 a code is only bound if the binding is checked at redemption", () => {
  const stored = {
    clientId: "client-1",
    redirectUri: "https://claude.ai/cb",
    codeChallenge: "b".repeat(43),
    resource: RESOURCE,
    expiresAt: 1_000 + AUTHORIZATION_CODE_TTL_MS,
    consumedAt: null,
  };
  const base = { stored, clientId: "client-1", redirectUri: "https://claude.ai/cb", resource: RESOURCE, now: 1_000 };

  it("accepts a redemption that agrees with the code, with or without the resource repeated", () => {
    expect(checkCodeExchange(base)).toEqual({ ok: true });
    expect(checkCodeExchange({ ...base, resource: undefined })).toEqual({ ok: true });
  });

  it("refuses an unknown, spent or expired code", () => {
    expect(checkCodeExchange({ ...base, stored: null })).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(
      checkCodeExchange({ ...base, stored: { ...stored, consumedAt: 999 } }),
    ).toMatchObject({ ok: false, error: "invalid_grant" });
    expect(
      checkCodeExchange({ ...base, now: stored.expiresAt }),
    ).toMatchObject({ ok: false, error: "invalid_grant", description: "the code has expired" });
  });

  it("refuses another client, another redirect and another audience", () => {
    expect(checkCodeExchange({ ...base, clientId: "client-2" })).toMatchObject({
      ok: false,
      error: "invalid_client",
    });
    expect(checkCodeExchange({ ...base, redirectUri: "https://claude.ai/cb?x=1" })).toMatchObject({
      ok: false,
      error: "invalid_grant",
    });
    expect(checkCodeExchange({ ...base, resource: `${ORIGIN}/w/other/mcp` })).toMatchObject({
      ok: false,
      error: "invalid_target",
    });
  });

  it("expires a code inside a minute", () => {
    expect(AUTHORIZATION_CODE_TTL_MS).toBe(60_000);
    expect(ACCESS_TOKEN_TTL_MS).toBe(3_600_000);
  });
});

describe("MCP-RULE-013 a rotated refresh token presented again kills the connection", () => {
  const connection = {
    refreshTokenHash: "current-hash",
    previousRefreshTokenHash: "previous-hash",
    clientId: "client-1",
    revokedAt: null,
  };

  it("rotates when the current token is presented", () => {
    expect(decideRefresh({ connection, presentedHash: "current-hash", clientId: "client-1" })).toEqual({
      kind: "rotate",
    });
  });

  it("treats a replayed rotation as a leak rather than a retry", () => {
    // A lost response and a stolen token look identical from here, so the safe
    // reading is the second one: the whole connection dies.
    expect(decideRefresh({ connection, presentedHash: "previous-hash", clientId: "client-1" })).toMatchObject(
      { kind: "replay" },
    );
  });

  it("refuses an unknown token, another client and a revoked connection", () => {
    expect(decideRefresh({ connection, presentedHash: "nothing", clientId: "client-1" })).toMatchObject({
      kind: "refuse",
      error: "invalid_grant",
    });
    expect(decideRefresh({ connection, presentedHash: "current-hash", clientId: "client-2" })).toMatchObject({
      kind: "refuse",
      error: "invalid_client",
    });
    expect(
      decideRefresh({
        connection: { ...connection, revokedAt: 5 },
        presentedHash: "current-hash",
        clientId: "client-1",
      }),
    ).toMatchObject({ kind: "refuse", error: "invalid_grant" });
    expect(decideRefresh({ connection: null, presentedHash: "x", clientId: "client-1" })).toMatchObject({
      kind: "refuse",
      error: "invalid_grant",
    });
  });

  it("does not mistake a first rotation for a replay", () => {
    expect(
      decideRefresh({
        connection: { ...connection, previousRefreshTokenHash: null },
        presentedHash: "current-hash",
        clientId: "client-1",
      }),
    ).toEqual({ kind: "rotate" });
  });
});

describe("MCP-RULE-014 the resource server checks the audience it was reached at", () => {
  const token = {
    connectionId: "connection-1",
    resource: RESOURCE,
    accessExpiresAt: 2_000,
    revokedAt: null,
    scope: "chat:read",
  };

  it("accepts a live token at its own workspace", () => {
    expect(checkPresentedToken({ token, audience: RESOURCE, now: 1_000 })).toEqual({ ok: true });
  });

  it("refuses a token minted for another workspace", () => {
    // The comparison is against where the request actually arrived, not what
    // the token or the client claims, which is what makes it worth doing.
    expect(
      checkPresentedToken({ token, audience: `${ORIGIN}/w/other-team/mcp`, now: 1_000 }),
    ).toMatchObject({ ok: false, error: "invalid_token" });
  });

  it("refuses an unknown, revoked or expired token", () => {
    expect(checkPresentedToken({ token: null, audience: RESOURCE, now: 1_000 })).toMatchObject({
      ok: false,
      error: "invalid_token",
    });
    expect(
      checkPresentedToken({ token: { ...token, revokedAt: 500 }, audience: RESOURCE, now: 1_000 }),
    ).toMatchObject({ ok: false, error: "invalid_token" });
    expect(checkPresentedToken({ token, audience: RESOURCE, now: 2_000 })).toMatchObject({
      ok: false,
      error: "invalid_token",
    });
  });

  it("separates a missing right from a bad token", () => {
    expect(
      checkPresentedToken({ token, audience: RESOURCE, now: 1_000, requiredScope: "chat:write" }),
    ).toMatchObject({ ok: false, error: "insufficient_scope" });
    expect(
      checkPresentedToken({ token, audience: RESOURCE, now: 1_000, requiredScope: "chat:read" }),
    ).toEqual({ ok: true });
  });
});

describe("MCP-RULE-016 identity comes from the address the client used", () => {
  it("uses the host the client addressed, not what the runtime rewrote it to", () => {
    // Locally the runtime turns 127.0.0.1 into localhost in `request.url`. An
    // issuer or an audience derived from that would not match what the client
    // typed, and every RFC 8707 comparison would fail for a legitimate client.
    expect(originFromHeaders("127.0.0.1:3100", null, "http://localhost:3100")).toBe(
      "http://127.0.0.1:3100",
    );
    expect(originFromHeaders("acme.lepidy.app", "https", "http://localhost")).toBe(
      "https://acme.lepidy.app",
    );
  });

  it("assumes https off the loopback, and takes the first forwarded protocol", () => {
    expect(originFromHeaders("acme.lepidy.app", null, "http://localhost")).toBe(
      "https://acme.lepidy.app",
    );
    expect(originFromHeaders("localhost:3000", null, "http://x")).toBe("http://localhost:3000");
    expect(originFromHeaders("acme.lepidy.app", "https, http", "http://x")).toBe(
      "https://acme.lepidy.app",
    );
    // A protocol we do not recognise is ignored rather than echoed into an
    // issuer, which is a string clients compare literally.
    expect(originFromHeaders("acme.lepidy.app", "javascript", "http://x")).toBe(
      "https://acme.lepidy.app",
    );
    expect(originFromHeaders(null, "https", "http://fallback")).toBe("http://fallback");
    expect(originFromHeaders("", null, "http://fallback")).toBe("http://fallback");
  });
});

describe("MCP-RULE-015 the metadata documents say exactly what is implemented", () => {
  it("advertises only the grants, methods and challenge we actually accept", () => {
    const metadata = authorizationServerMetadata(`${ORIGIN}/`);
    expect(metadata).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/api/oauth/token`,
      registration_endpoint: `${ORIGIN}/api/oauth/register`,
      revocation_endpoint: `${ORIGIN}/api/oauth/revoke`,
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true,
    });
  });

  it("describes one protected resource per workspace, pointing at this issuer", () => {
    expect(protectedResourceMetadata(ORIGIN, SLUG)).toEqual({
      resource: RESOURCE,
      authorization_servers: [ORIGIN],
      scopes_supported: ["chat:read", "chat:write", "agent", "vault"],
      bearer_methods_supported: ["header"],
    });
  });
});
