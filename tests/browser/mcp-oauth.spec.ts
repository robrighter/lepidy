import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { freshAccount, signUp } from "./auth-helpers";

/**
 * The MCP authorization server and resource server, driven the way a real
 * client drives them: discovery, registration, a consent screen a person
 * actually clicks, a code redeemed for a pair, and the pair used at the
 * workspace's own endpoint.
 *
 * Everything runs against the built Worker with real D1 and real Durable
 * Objects, so the token that comes out of the dance is the token the resource
 * server verifies.
 */

const BASE = "http://127.0.0.1:3100";
/** Registered as the redirect so the browser can actually land on it. */
const REDIRECT_URI = `${BASE}/signin`;
const VERIFIER = "verifier-for-the-browser-suite".padEnd(64, "x");

function slugFor(account: ReturnType<typeof freshAccount>): string {
  return account.workspaceName.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-");
}

async function codeChallenge(): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(VERIFIER));
  return Buffer.from(digest).toString("base64url");
}

async function registerClient(request: APIRequestContext, name: string): Promise<string> {
  const response = await request.post(`${BASE}/api/oauth/register`, {
    data: { client_name: name, redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" },
  });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { client_id: string };
  return body.client_id;
}

/** Walk the consent screen and hand back the code the redirect carried. */
async function consent(page: Page, input: { slug: string; clientId: string; state: string }): Promise<string> {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: await codeChallenge(),
    code_challenge_method: "S256",
    resource: `${BASE}/w/${input.slug}/mcp`,
    scope: "chat:read chat:write",
    state: input.state,
  });
  await page.goto(`/oauth/authorize?${params.toString()}`);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForURL(/\/signin\?/);

  const landed = new URL(page.url());
  expect(landed.searchParams.get("state")).toBe(input.state);
  // RFC 9207: the response says which authorization server produced it.
  expect(landed.searchParams.get("iss")).toBe(BASE);
  const code = landed.searchParams.get("code");
  expect(code).not.toBeNull();
  return code as string;
}

async function exchange(
  request: APIRequestContext,
  input: { code: string; clientId: string; slug: string },
) {
  const response = await request.post(`${BASE}/api/oauth/token`, {
    form: {
      grant_type: "authorization_code",
      code: input.code,
      client_id: input.clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: VERIFIER,
      resource: `${BASE}/w/${input.slug}/mcp`,
    },
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as { access_token: string; refresh_token: string; scope: string };
}

async function initialize(request: APIRequestContext, slug: string, accessToken: string) {
  return request.post(`${BASE}/w/${slug}/mcp`, {
    headers: { authorization: `Bearer ${accessToken}` },
    data: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
  });
}

test("MCP-INT-008 connects an MCP client through discovery, consent and a code exchange", async ({
  page,
}) => {
  const account = freshAccount();
  await signUp(page, account);
  const slug = slugFor(account);
  const request = page.request;

  // The authorization server describes itself, and advertises only what it
  // actually implements.
  const asMetadata = await (await request.get(`${BASE}/.well-known/oauth-authorization-server`)).json();
  expect(asMetadata).toMatchObject({
    issuer: BASE,
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    authorization_response_iss_parameter_supported: true,
  });

  // An unauthenticated call to the workspace's endpoint says where to
  // authenticate, which is the only way a client finds the metadata.
  const challenged = await request.get(`${BASE}/w/${slug}/mcp`);
  expect(challenged.status()).toBe(401);
  const metadataUrl = `${BASE}/.well-known/oauth-protected-resource/w/${slug}/mcp`;
  expect(challenged.headers()["www-authenticate"]).toContain(`resource_metadata="${metadataUrl}"`);

  const resourceMetadata = await (await request.get(metadataUrl)).json();
  expect(resourceMetadata).toMatchObject({
    resource: `${BASE}/w/${slug}/mcp`,
    authorization_servers: [BASE],
  });

  const clientId = await registerClient(request, "Claude Code");

  // The consent screen says who it will act as and what it will be able to do.
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: await codeChallenge(),
    code_challenge_method: "S256",
    resource: `${BASE}/w/${slug}/mcp`,
    scope: "chat:read chat:write",
    state: "state-008",
  });
  await page.goto(`/oauth/authorize?${params.toString()}`);
  await expect(page.getByRole("heading", { name: "Connect Claude Code?" })).toBeVisible();
  await expect(page.locator(".consent-scopes")).toContainText("Post messages as you");
  await expect(page.locator(".auth-intro")).toContainText(account.displayName);

  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForURL(/\/signin\?/);
  const code = new URL(page.url()).searchParams.get("code") as string;
  expect(code.startsWith(`lpd_code_${slug}_`)).toBe(true);

  const tokens = await exchange(request, { code, clientId, slug });
  expect(tokens.access_token.startsWith(`lpd_at_${slug}_`)).toBe(true);
  expect(tokens.scope).toBe("chat:read chat:write");

  // The pair works at the workspace's own endpoint, acting as the person who
  // consented and as nobody else.
  const initialized = await initialize(request, slug, tokens.access_token);
  expect(initialized.status()).toBe(200);
  const body = (await initialized.json()) as { result: { instructions: string } };
  expect(body.result.instructions).toContain(`@${account.handle}`);

  // The paired refusal: the same code cannot be redeemed twice.
  const replayed = await request.post(`${BASE}/api/oauth/token`, {
    form: {
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: VERIFIER,
    },
  });
  expect(replayed.status()).toBe(400);
  expect((await replayed.json()) as { error: string }).toMatchObject({ error: "invalid_grant" });
});

test("MCP-INT-009 rotates a connection, kills a replayed one and can be ended by its owner", async ({
  page,
}) => {
  const account = freshAccount();
  await signUp(page, account);
  const slug = slugFor(account);
  const request = page.request;

  const clientId = await registerClient(request, "Claude Desktop");
  const first = await exchange(request, {
    code: await consent(page, { slug, clientId, state: "state-009" }),
    clientId,
    slug,
  });

  const refreshed = await request.post(`${BASE}/api/oauth/token`, {
    form: { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId },
  });
  expect(refreshed.status()).toBe(200);
  const second = (await refreshed.json()) as { access_token: string; refresh_token: string };
  expect(second.refresh_token).not.toBe(first.refresh_token);

  // The superseded access token stops working, the new one works.
  expect((await initialize(request, slug, first.access_token)).status()).toBe(401);
  expect((await initialize(request, slug, second.access_token)).status()).toBe(200);

  // A rotated refresh token presented again is read as a leak, and the whole
  // connection dies rather than only the replayed token.
  const replay = await request.post(`${BASE}/api/oauth/token`, {
    form: { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId },
  });
  expect(replay.status()).toBe(400);
  expect((await initialize(request, slug, second.access_token)).status()).toBe(401);

  // A fresh connection, so the person has something to disconnect by hand.
  const third = await exchange(request, {
    code: await consent(page, { slug, clientId, state: "state-009b" }),
    clientId,
    slug,
  });
  expect((await initialize(request, slug, third.access_token)).status()).toBe(200);

  await page.goto("/connections");
  await expect(page.locator(".connection-list li")).toHaveCount(1);
  await expect(page.locator(".connection-list li").first()).toContainText("Claude Desktop");
  await page.getByRole("button", { name: /Disconnect/ }).click();
  await expect(page.getByRole("heading", { name: "No connections yet" })).toBeVisible();

  expect((await initialize(request, slug, third.access_token)).status()).toBe(401);
});

test("MCP-INT-010 refuses one workspace's token at another workspace", async ({ page, browser }) => {
  const first = freshAccount();
  await signUp(page, first);
  const firstSlug = slugFor(first);
  const clientId = await registerClient(page.request, "Cross Tenant Probe");
  const grant = await exchange(page.request, {
    code: await consent(page, { slug: firstSlug, clientId, state: "state-010" }),
    clientId,
    slug: firstSlug,
  });
  expect((await initialize(page.request, firstSlug, grant.access_token)).status()).toBe(200);

  // A second workspace, owned by somebody else entirely.
  const secondContext = await browser.newContext({ baseURL: BASE });
  const secondPage = await secondContext.newPage();
  const second = freshAccount();
  await signUp(secondPage, second);
  const secondSlug = slugFor(second);

  // The first workspace's token, presented at the second workspace's endpoint.
  const refused = await initialize(page.request, secondSlug, grant.access_token);
  expect(refused.status()).toBe(401);
  expect(refused.headers()["www-authenticate"]).toContain(
    `${BASE}/.well-known/oauth-protected-resource/w/${secondSlug}/mcp`,
  );

  // And it still works where it belongs, so the refusal was about the audience
  // rather than about the token having been spent.
  expect((await initialize(page.request, firstSlug, grant.access_token)).status()).toBe(200);
  await secondContext.close();
});
