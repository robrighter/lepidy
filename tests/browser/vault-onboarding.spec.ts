import { type APIRequestContext, type Page } from "@playwright/test";
import { expect, test } from "./harness";

import { freshAccount, signUp } from "./auth-helpers";
import { LOCALHOST_BASE, PROJECT, enrolDevice, signedRequest, slugFor } from "./device-helpers";
import { encryptVaultValue, wrapVaultDek } from "../../src/domain/vault-client-crypto";
import { VAULT_WRAP_SUITE } from "../../src/domain/vault-envelope";
import { VAULT_INSTRUCTION } from "../../src/domain/agent-onboarding";
import { canaryMarkerFor, canaryValue, scanDigestPreimage } from "../../src/domain/vault-canary";

/**
 * V08 over real HTTP against the built Worker: the onboarding text a client is
 * handed, the hint tool it can ask, the scan targets a device can fetch, and
 * the canary tripwire refusing a write.
 *
 * Every response body this file receives is scanned for the two synthetic
 * values it seeded. A test that only asserts the happy shape would not notice a
 * value being added to a payload somewhere else.
 */

// The whole spec runs on one origin, because the device transport and the
// OAuth consent screen both depend on the browser session cookie.
const BASE = LOCALHOST_BASE;
const REDIRECT_URI = `${BASE}/signin`;
const VERIFIER = "verifier-for-the-onboarding-suite".padEnd(64, "x");

/**
 * Recognisable enough to spot anywhere, worthless everywhere, and different
 * per workspace so a cross-tenant assertion means something.
 */
function secretFor(label: string): string {
  return `lepidy-onboarding-browser-canary-${label}-77213`;
}

async function codeChallenge(): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(VERIFIER));
  return Buffer.from(digest).toString("base64url");
}

async function digestOf(input: { workspaceId: string; credentialId: string; version: number; value: string }) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(scanDigestPreimage(input)));
  return Buffer.from(digest).toString("base64url");
}

/** Connect an MCP client the way a real one does, and hand back its token. */
async function connect(page: Page, slug: string, scope: string): Promise<string> {
  const registered = await page.request.post(`${BASE}/api/oauth/register`, {
    data: { client_name: "Onboarding suite", redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" },
  });
  expect(registered.status()).toBe(201);
  const { client_id: clientId } = (await registered.json()) as { client_id: string };

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: await codeChallenge(),
    code_challenge_method: "S256",
    resource: `${BASE}/w/${slug}/mcp`,
    scope,
    state: "onboarding",
  });
  await settle(page);
  await page.goto(`${BASE}/oauth/authorize?${params.toString()}`);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForURL(/\/signin\?/);
  const code = new URL(page.url()).searchParams.get("code");
  expect(code).not.toBeNull();
  // The redirect target is still fetching its scripts and fonts. Everything
  // after this is API traffic, and a later navigation would abandon them.
  await settle(page);

  const exchanged = await page.request.post(`${BASE}/api/oauth/token`, {
    form: {
      grant_type: "authorization_code",
      code: code as string,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: VERIFIER,
      resource: `${BASE}/w/${slug}/mcp`,
    },
  });
  expect(exchanged.status()).toBe(200);
  return ((await exchanged.json()) as { access_token: string }).access_token;
}

function rpc(request: APIRequestContext, slug: string, token: string, method: string, params: unknown) {
  return request.post(`${BASE}/w/${slug}/mcp`, {
    headers: { authorization: `Bearer ${token}` },
    data: { jsonrpc: "2.0", id: 1, method, params },
  });
}

/**
 * Let whatever the page is still fetching finish.
 *
 * Navigating away mid-load abandons those requests, and `wrangler dev` reports
 * an abandoned request to its controller as fatal — the defect the browser
 * harness exists for. A scenario that signs up twice in one page is exactly the
 * shape that trips it, so each phase settles before the next navigation.
 */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
}

/** Sign up, enrol a device, and seal one ordinary credential and one canary. */
async function seed(page: Page, label: string, canaryTag: string, options: { credentials?: boolean } = {}) {
  const secret = secretFor(label);
  const account = freshAccount();
  await settle(page);
  await signUp(page, account, LOCALHOST_BASE);
  const session = (await page.context().cookies()).find((cookie) => cookie.name === "lepidy_session");
  const origin = (await (
    await page.request.post(`${LOCALHOST_BASE}/__fixture/device-origin`, { headers: { authorization: session!.value } })
  ).json()) as { channelId: string; messageId: string };

  const { keys, enrolment } = await enrolDevice(page, {
    email: account.email,
    password: account.password,
    workspaceSlug: slugFor(account),
    label: "onboarding suite",
    base: LOCALHOST_BASE,
  });

  const create = async (input: { credentialId: string; name: string; value: string; canaryMarker?: string; commands?: string[] }) => {
    const encrypted = await encryptVaultValue({
      workspaceId: enrolment.workspaceId, credentialId: input.credentialId, version: 1, keyEpoch: 1,
      plaintext: new TextEncoder().encode(input.value),
    });
    const wrap = await wrapVaultDek({
      workspaceId: enrolment.workspaceId, credentialId: input.credentialId, version: 1,
      custodianMemberId: enrolment.memberId, recipientKeyEpoch: enrolment.vaultKey.keyEpoch,
      recipientPublicKey: keys.vaultPublicKey, dek: encrypted.dek,
    });
    const created = await signedRequest(page.request, {
      keys, enrolment, path: "/api/device/vault/credentials", base: LOCALHOST_BASE,
      body: {
        credentialId: input.credentialId,
        idempotencyKey: `browser:onboarding:${input.credentialId}`,
        password: account.password,
        metadata: {
          name: input.name, description: "Onboarding fixture", envVar: input.name,
          tags: [], commands: input.commands ?? [], proxyHosts: [],
        },
        policy: { mode: "auto", allowedDeliveries: ["inject"], projectIds: [PROJECT], highRisk: false },
        envelope: encrypted.envelope,
        wraps: [{ ...wrap, wrapSuite: VAULT_WRAP_SUITE }],
        acl: [
          { subjectType: "member", subjectId: enrolment.memberId, verb: "manage" },
          { subjectType: "member", subjectId: enrolment.memberId, verb: "use" },
        ],
        scan: {
          digest: await digestOf({
            workspaceId: enrolment.workspaceId, credentialId: input.credentialId, version: 1, value: input.value,
          }),
          length: input.value.length,
        },
        ...(input.canaryMarker === undefined ? {} : { canaryMarker: input.canaryMarker }),
      },
    });
    expect(created.status()).toBe(200);
  };

  const canary = canaryValue(canaryTag, "0123456789abcdef0123456789abcdef");
  // A workspace that exists only to be refused needs no credentials of its own,
  // and creating them would be four more requests for nothing.
  if (options.credentials !== false) {
    await create({ credentialId: "cred-house", name: "HOUSE_TOKEN", value: secret, commands: ["housectl"] });
    await create({ credentialId: "cred-trap", name: "TRAP_TOKEN", value: canary, canaryMarker: canaryMarkerFor(canaryTag) });
  }

  return { account, keys, enrolment, origin, canary, secret, marker: canaryMarkerFor(canaryTag), slug: slugFor(account) };
}

test("VAULT-ONBOARD-UI-001 hands every MCP client the one vault rule and a hint tool", async ({ page }) => {
  const seeded = await seed(page, "hint", "b7c8d9e0f1a2");
  const token = await connect(page, seeded.slug, "chat:read chat:write agent vault");

  // Layer 1: the only text every session pays for, in the initialize response.
  const initialized = await rpc(page.request, seeded.slug, token, "initialize", {});
  expect(initialized.status()).toBe(200);
  const instructions = ((await initialized.json()) as { result: { instructions: string } }).result.instructions;
  expect(instructions).toContain(`@${seeded.account.handle}`);
  expect(instructions).toContain(VAULT_INSTRUCTION);
  expect(instructions).toContain("lepidy run --with");
  expect(instructions).toContain("A refusal is an answer");

  // Layer 2: the tools say what they will and will not do.
  const listed = await rpc(page.request, seeded.slug, token, "tools/list", {});
  const tools = ((await listed.json()) as { result: { tools: { name: string; description: string }[] } }).result.tools;
  const named = (name: string) => tools.find((tool) => tool.name === name);
  expect(named("credential_hint")?.description).toContain("never a value");
  expect(named("list_credentials")?.description).toContain("never ask a person to paste one");
  expect(named("describe_credential")?.description).toContain("report it and stop");
  // There is no tool that returns a value, and none that stores one.
  expect(tools.map((tool) => tool.name)).not.toContain("request_secret");
  expect(tools.map((tool) => tool.name)).not.toContain("store_secret");

  // The hint names the credential and the exact command, and no value.
  const hinted = await rpc(page.request, seeded.slug, token, "tools/call", {
    name: "credential_hint", arguments: { command: "housectl deploy && cargo test" },
  });
  const hintBody = await hinted.text();
  expect(hintBody).not.toContain(seeded.secret);
  const hint = (JSON.parse(hintBody) as { result: { structuredContent: { hints: { credentials: string[]; run: string }[] } } })
    .result.structuredContent;
  expect(hint.hints).toHaveLength(1);
  expect(hint.hints[0].credentials).toEqual(["HOUSE_TOKEN"]);
  expect(hint.hints[0].run).toBe("lepidy run --with HOUSE_TOKEN -- housectl deploy");

  // A listing carries the command that uses each credential, and no value.
  const credentials = await rpc(page.request, seeded.slug, token, "tools/call", {
    name: "list_credentials", arguments: {},
  });
  const listingBody = await credentials.text();
  expect(listingBody).not.toContain(seeded.secret);
  expect(listingBody).not.toContain(seeded.canary);
  expect(listingBody).not.toContain("ciphertext");
  expect(listingBody).toContain("lepidy run --with HOUSE_TOKEN");
  expect(listingBody).toContain("\"canary\":true");

  // A tool nobody defined stays undefined, whatever the client asks for.
  const invented = await rpc(page.request, seeded.slug, token, "tools/call", {
    name: "request_secret", arguments: { name: "HOUSE_TOKEN" },
  });
  const inventedBody = (await invented.json()) as { error?: { code: number; message: string } };
  expect(inventedBody.error?.code).toBe(-32602);
  expect(inventedBody.error?.message).toContain("unknown tool");
});

test("VAULT-ONBOARD-UI-002 serves scan targets to the enrolled device and to nobody else", async ({ page }) => {
  const seeded = await seed(page, "targets", "c1d2e3f4a5b6");

  const targets = await signedRequest(page.request, {
    keys: seeded.keys, enrolment: seeded.enrolment, path: "/api/device/vault/scan-targets", base: LOCALHOST_BASE, body: {},
  });
  expect(targets.status()).toBe(200);
  const body = await targets.text();
  // Digests and a public marker; never a value, a wrap or a ciphertext.
  expect(body).not.toContain(seeded.secret);
  expect(body).not.toContain(seeded.canary);
  expect(body).not.toContain("wrappedDek");
  expect(body).not.toContain("ciphertext");

  const parsed = (JSON.parse(body) as { targets: { credentialId: string; name: string; digest: string | null; length: number | null; canaryMarker: string | null }[] }).targets;
  const house = parsed.find((target) => target.name === "HOUSE_TOKEN");
  expect(house?.digest).toBe(await digestOf({
    workspaceId: seeded.enrolment.workspaceId, credentialId: "cred-house", version: 1, value: seeded.secret,
  }));
  expect(house?.length).toBe(seeded.secret.length);
  const trap = parsed.find((target) => target.name === "TRAP_TOKEN");
  expect(trap?.canaryMarker).toBe(seeded.marker);

  // The deny half, with a valid device belonging to a different workspace
  // rather than a malformed request: it must see none of these.
  const other = await seed(page, "other", "e1f2a3b4c5d6", { credentials: false });
  const crossed = await signedRequest(page.request, {
    keys: other.keys, enrolment: other.enrolment, path: "/api/device/vault/scan-targets", base: LOCALHOST_BASE, body: {},
  });
  expect(crossed.status()).toBe(200);
  const crossedBody = await crossed.text();
  expect(crossedBody).not.toContain(seeded.secret);
  expect(crossedBody).not.toContain(seeded.canary);
  expect(crossedBody).not.toContain(seeded.marker);
  expect(crossedBody).not.toContain(house?.digest ?? "no digest");
});

test("VAULT-ONBOARD-UI-003 refuses an MCP write carrying a canary and says why", async ({ page }) => {
  const seeded = await seed(page, "trip", "d1e2f3a4b5c6");
  const token = await connect(page, seeded.slug, "chat:read chat:write agent vault");

  const refused = await rpc(page.request, seeded.slug, token, "tools/call", {
    name: "post_message",
    arguments: {
      channel_id: seeded.origin.channelId,
      content: `Here is the token: ${seeded.canary}`,
      idempotency_key: "browser:onboarding:canary:1",
    },
  });
  expect(refused.status()).toBe(200);
  const body = await refused.text();
  // The refusal names the credential and tells the agent to stop, and it does
  // not quote the value back — a refusal that echoed it would be its own leak.
  expect(body).not.toContain(seeded.canary);
  expect(body).toContain("TRAP_TOKEN");
  expect(body).toContain("canary credential");
  expect(body).toContain("Do not try to send it another way");
  expect((JSON.parse(body) as { result: { isError: boolean } }).result.isError).toBe(true);

  // The paired allow: the same room takes an ordinary message.
  const allowed = await rpc(page.request, seeded.slug, token, "tools/call", {
    name: "post_message",
    arguments: {
      channel_id: seeded.origin.channelId,
      content: "TRAP_TOKEN is configured; I used it through lepidy run.",
      idempotency_key: "browser:onboarding:canary:2",
    },
  });
  const allowedBody = (await allowed.json()) as { result: { isError?: boolean } };
  expect(allowedBody.result.isError).toBeFalsy();
});
