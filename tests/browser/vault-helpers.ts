import { expect, type Page } from "@playwright/test";

import { freshAccount, signUp } from "./auth-helpers";
import { LOCALHOST_BASE, PROJECT, enrolDevice, signedRequest, slugFor, type Enrolment } from "./device-helpers";
import { encryptVaultValue, wrapVaultDek } from "../../src/domain/vault-client-crypto";
import { VAULT_WRAP_SUITE } from "../../src/domain/vault-envelope";

/**
 * A workspace with a credential worth asking about, and a passkey to answer
 * with. Shared by the approval and vault-page scenarios so both exercise the
 * same real setup rather than two approximations of it.
 */

export const CANARY = "approval-browser-canary-2291";

export type Fixture = {
  account: ReturnType<typeof freshAccount>;
  enrolment: Enrolment;
  keys: Awaited<ReturnType<typeof enrolDevice>>["keys"];
  origin: { channelId: string; messageId: string };
  credentialId: string;
};

/** A workspace with one ask-every-time credential and a device able to request it. */
export async function seedAskCredential(
  page: Page,
  options: { grantTtlMs?: number } = {},
): Promise<Fixture> {
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
      // Ask every time, and high risk, so the card has to carry the warning. A
      // TTL is what makes the timed allow windows available at all.
      policy: {
        mode: "ask",
        allowedDeliveries: ["inject"],
        projectIds: [PROJECT],
        highRisk: true,
        ...(options.grantTtlMs === undefined ? {} : { grantTtlMs: options.grantTtlMs }),
      },
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

/**
 * A credential created the way `lepidy capture` creates one: switched off, with
 * the program that produced it recorded.
 */
export async function seedCapturedCredential(page: Page): Promise<Fixture> {
  const fixture = await seedAskCredential(page);
  const credentialId = `cred-captured-${Date.now()}`;
  const encrypted = await encryptVaultValue({
    workspaceId: fixture.enrolment.workspaceId,
    credentialId,
    version: 1,
    keyEpoch: 1,
    plaintext: new TextEncoder().encode(CANARY),
  });
  const wrap = await wrapVaultDek({
    workspaceId: fixture.enrolment.workspaceId,
    credentialId,
    version: 1,
    custodianMemberId: fixture.enrolment.memberId,
    recipientKeyEpoch: fixture.enrolment.vaultKey.keyEpoch,
    recipientPublicKey: fixture.keys.vaultPublicKey,
    dek: encrypted.dek,
  });
  const created = await signedRequest(page.request, {
    keys: fixture.keys,
    enrolment: fixture.enrolment,
    path: "/api/device/vault/credentials",
    base: LOCALHOST_BASE,
    body: {
      credentialId,
      idempotencyKey: `browser:capture:${credentialId}`,
      password: fixture.account.password,
      metadata: {
        name: "CAPTURED_TOKEN",
        description: "Captured from a command",
        envVar: "CAPTURED_TOKEN",
        tags: [],
        commands: [],
        proxyHosts: [],
      },
      policy: { mode: "ask", allowedDeliveries: ["inject"], projectIds: [PROJECT], highRisk: false },
      envelope: encrypted.envelope,
      wraps: [{ ...wrap, wrapSuite: VAULT_WRAP_SUITE }],
      acl: [
        { subjectType: "member", subjectId: fixture.enrolment.memberId, verb: "manage" },
        { subjectType: "member", subjectId: fixture.enrolment.memberId, verb: "use" },
      ],
      capturedFrom: "gh",
    },
  });
  expect(created.status()).toBe(200);
  return { ...fixture, credentialId };
}

export function requestRelease(page: Page, fixture: Fixture) {
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
export async function registerPasskey(page: Page): Promise<void> {
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

