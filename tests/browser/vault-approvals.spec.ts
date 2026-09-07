import { expect, test, type Page } from "@playwright/test";

import { freshAccount, signUp } from "./auth-helpers";
import { LOCALHOST_BASE, PROJECT, enrolDevice, signedRequest, slugFor, type Enrolment } from "./device-helpers";
import { encryptVaultValue, wrapVaultDek } from "../../src/domain/vault-client-crypto";
import { VAULT_WRAP_SUITE } from "../../src/domain/vault-envelope";

/**
 * Approval as a conversation, end to end in a browser.
 *
 * A credential that asks every time is requested by a device, the card arrives
 * in the Inbox and as a message from `@a.vault`, and a person answers it — with
 * a real WebAuthn assertion for allow and with nothing at all for deny. The
 * gesture is made by a virtual authenticator, so the assertion the server
 * verifies is a genuine one rather than a stub.
 */

const CANARY = "approval-browser-canary-2291";

type Fixture = {
  account: ReturnType<typeof freshAccount>;
  enrolment: Enrolment;
  keys: Awaited<ReturnType<typeof enrolDevice>>["keys"];
  origin: { channelId: string; messageId: string };
  credentialId: string;
};

/** A workspace with one ask-every-time credential and a device able to request it. */
async function seedAskCredential(page: Page): Promise<Fixture> {
  const account = freshAccount();
  await signUp(page, account, LOCALHOST_BASE);
  const session = (await page.context().cookies()).find((cookie) => cookie.name === "lepidy_session");
  const origin = (await (
    await page.request.post(`${LOCALHOST_BASE}/__fixture/device-origin`, { headers: { authorization: session!.value } })
  ).json()) as { channelId: string; messageId: string };

  const { keys, enrolment } = await enrolDevice(page, {
    email: account.email,
    password: account.password,
    workspaceSlug: slugFor(account),
    label: "approval suite",
    base: LOCALHOST_BASE,
  });

  const credentialId = `cred-approval-${Date.now()}`;
  const encrypted = await encryptVaultValue({
    workspaceId: enrolment.workspaceId,
    credentialId,
    version: 1,
    keyEpoch: 1,
    plaintext: new TextEncoder().encode(CANARY),
  });
  const wrap = await wrapVaultDek({
    workspaceId: enrolment.workspaceId,
    credentialId,
    version: 1,
    custodianMemberId: enrolment.memberId,
    recipientKeyEpoch: enrolment.vaultKey.keyEpoch,
    recipientPublicKey: keys.vaultPublicKey,
    dek: encrypted.dek,
  });
  const created = await signedRequest(page.request, {
    keys,
    enrolment,
    path: "/api/device/vault/credentials",
    base: LOCALHOST_BASE,
    body: {
      credentialId,
      idempotencyKey: `browser:approval:add:${credentialId}`,
      password: account.password,
      metadata: {
        name: "ASK_TOKEN",
        description: "Asks every time",
        envVar: "ASK_TOKEN",
        tags: [],
        commands: [],
        proxyHosts: [],
      },
      // Ask every time, and high risk, so the card has to carry the warning.
      policy: { mode: "ask", allowedDeliveries: ["inject"], projectIds: [PROJECT], highRisk: true },
      envelope: encrypted.envelope,
      wraps: [{ ...wrap, wrapSuite: VAULT_WRAP_SUITE }],
      acl: [
        { subjectType: "member", subjectId: enrolment.memberId, verb: "manage" },
        { subjectType: "member", subjectId: enrolment.memberId, verb: "use" },
      ],
    },
  });
  expect(created.status()).toBe(200);
  return { account, enrolment, keys, origin, credentialId };
}

function requestRelease(page: Page, fixture: Fixture) {
  return signedRequest(page.request, {
    keys: fixture.keys,
    enrolment: fixture.enrolment,
    path: "/api/device/vault/release",
    base: LOCALHOST_BASE,
    body: {
      credentialIds: [fixture.credentialId],
      delivery: "inject",
      reason: "deploy the staging migration",
      origin: fixture.origin,
    },
  });
}

/** A virtual authenticator with user verification, so `allow` can be pressed. */
async function registerPasskey(page: Page): Promise<void> {
  const client = await page.context().newCDPSession(page);
  await client.send("WebAuthn.enable");
  await client.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });

  // The session cookie is HttpOnly, as it must be, so the ceremony is driven
  // from the test: the page only makes the credential.
  const session = (await page.context().cookies()).find((cookie) => cookie.name === "lepidy_session");
  const begun = (await (
    await page.request.post(`${LOCALHOST_BASE}/__fixture/passkey/begin`, { headers: { authorization: session!.value } })
  ).json()) as { id: string; options: Record<string, unknown> };

  const created = await page.evaluate(async (options) => {
    const decode = (value: string) => {
      const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return bytes.buffer;
    };
    const encode = (value: ArrayBuffer) => {
      let binary = "";
      for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
      return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
    };
    const typed = options as unknown as {
      challenge: string;
      user: { id: string; name: string; displayName: string };
      excludeCredentials?: { id: string; type: string }[];
    };
    const credential = (await navigator.credentials.create({
      publicKey: {
        ...(options as object),
        challenge: decode(typed.challenge),
        user: { ...typed.user, id: decode(typed.user.id) },
        excludeCredentials: (typed.excludeCredentials ?? []).map((entry) => ({
          ...entry,
          id: decode(entry.id),
        })),
      } as unknown as PublicKeyCredentialCreationOptions,
    })) as PublicKeyCredential;
    const response = credential.response as AuthenticatorAttestationResponse;
    return {
      id: credential.id,
      rawId: encode(credential.rawId),
      type: credential.type,
      clientExtensionResults: credential.getClientExtensionResults(),
      response: {
        clientDataJSON: encode(response.clientDataJSON),
        attestationObject: encode(response.attestationObject),
      },
    };
  }, begun.options);

  const finished = await page.request.post(`${LOCALHOST_BASE}/__fixture/passkey/finish`, {
    headers: { authorization: session!.value },
    data: { challengeId: begun.id, response: created },
  });
  expect(finished.status()).toBe(200);
}

test("VAULT-APPROVAL-INT-001 asks a person, is answered with a real gesture, and only then releases", async ({
  page,
}) => {
  const fixture = await seedAskCredential(page);

  // An ask-every-time credential is not released; a card is raised instead.
  const asked = await requestRelease(page, fixture);
  expect(asked.status()).toBe(200);
  const pending = (await asked.json()) as {
    results: { decision: { kind: string } }[];
    approvals: { approvalId: string; hint: string }[];
  };
  expect(pending.results[0].decision).toEqual({ kind: "needs_approval" });
  expect(pending.approvals).toHaveLength(1);
  expect(pending.approvals[0].hint).toContain("do not retry in a loop");
  expect(await asked.text()).not.toContain(CANARY);

  // The card is in the Inbox, carrying every fact the approver needs.
  await page.goto(`${LOCALHOST_BASE}/inbox`);
  const card = page.getByRole("article").first();
  await expect(card).toContainText("wants a credential");
  await expect(card).toContainText("deploy the staging migration");
  await expect(card).toContainText("ASK_TOKEN");
  await expect(card).toContainText("High risk");
  await expect(card).toContainText("no answer is a denial");
  await expect(page.getByRole("button", { name: "Deny" })).toBeEnabled();

  // Allowing needs a passkey; until there is one the page says so rather than
  // offering a button that cannot work.
  await expect(card).toContainText("Allowing needs a passkey");
  await expect(page.getByRole("button", { name: /^Allow/ }).first()).toBeDisabled();

  await registerPasskey(page);
  await page.goto(`${LOCALHOST_BASE}/inbox`);
  const allow = page.getByRole("button", { name: "Allow once" });
  await expect(allow).toBeEnabled();
  await allow.click();
  await expect(page.getByText("Nothing is waiting on you")).toBeVisible();

  // The grant the gesture issued is the one the release path honours, and the
  // value still crosses the wire sealed.
  const released = await requestRelease(page, fixture);
  const payload = (await released.json()) as {
    results: { decision: { kind: string; via?: string }; envelope?: unknown }[];
  };
  expect(payload.results[0].decision).toEqual({ kind: "allow", via: "grant" });
  expect(payload.results[0].envelope).toBeDefined();
  expect(await released.text()).not.toContain(CANARY);

  // "Allow once" is spent by that one use, so the next request asks again
  // rather than riding on the answer somebody already gave.
  const again = (await (await requestRelease(page, fixture)).json()) as {
    results: { decision: { kind: string } }[];
    approvals: unknown[];
  };
  expect(again.results[0].decision.kind).toBe("needs_approval");
  expect(again.approvals).toHaveLength(1);

  // The card and its answer are a real conversation with @a.vault, readable
  // where the person already is — not a notification that vanishes.
  // Followed by its address rather than by clicking the rail, so the scenario
  // proves the conversation exists at both viewports rather than proving where
  // a narrow layout happens to put the rail.
  await page.goto(`${LOCALHOST_BASE}/`);
  const conversation = await page
    .getByRole("link", { name: "a.vault", exact: true })
    .first()
    .getAttribute("href");
  await page.goto(`${LOCALHOST_BASE}${conversation}`);
  await expect(page.getByText("deploy the staging migration").first()).toBeVisible();
  await expect(page.getByText("ASK_TOKEN").first()).toBeVisible();
  // The answer is a reply on the card, so a second owner opening it sees who
  // decided rather than an open request.
  await expect(page.getByText(/repl(y|ies)/).first()).toBeVisible();
  // The conversation carries the question and the answer, and never the value.
  expect(await page.content()).not.toContain(CANARY);
});

test("VAULT-APPROVAL-INT-002 lets anyone deny with no gesture, before the page has hydrated", async ({ browser }) => {
  // Scripting off, so nothing on this page can ever hydrate: denying has to be
  // the action that always works, including on a phone that has not finished
  // loading.
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  const fixture = await seedAskCredential(page);
  const asked = await requestRelease(page, fixture);
  expect(((await asked.json()) as { approvals: unknown[] }).approvals).toHaveLength(1);

  await page.goto(`${LOCALHOST_BASE}/inbox`);
  await expect(page.getByRole("article").first()).toContainText("ASK_TOKEN");
  // The allow buttons say plainly that they are not ready, rather than
  // pretending to work.
  await expect(page.getByRole("article").first()).toContainText("Allowing needs");
  await page.getByRole("button", { name: "Deny" }).click();
  await expect(page.getByText("Nothing is waiting on you")).toBeVisible();

  // And the denial is real: the next request is refused rather than released.
  const after = (await (await requestRelease(page, fixture)).json()) as {
    results: { decision: { kind: string } }[];
    approvals: unknown[];
  };
  expect(after.results[0].decision.kind).toBe("needs_approval");
  expect(after.approvals).toHaveLength(1);
  await context.close();
});
