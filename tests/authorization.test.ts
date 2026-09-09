import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import {
  AuthorizationService,
  canonicalSignedDeviceRequest,
  type SignedDeviceClaims,
} from "../src/control/authorization";
import { OnboardingService } from "../src/control/onboarding";

const NOW = 1_800_000_000_000;
const encoder = new TextEncoder();

describe("session and device authorization", () => {
  let auth: AuthorizationService;
  let onboarding: OnboardingService;

  beforeAll(async () => {
    await applyD1Migrations(env.CONTROL_DB, env.TEST_CONTROL_MIGRATIONS);
    auth = new AuthorizationService(env.CONTROL_DB, env.WORKSPACE, () => NOW);
    onboarding = new OnboardingService(env.CONTROL_DB, env.WORKSPACE, () => NOW);
  });

  async function account(email: string): Promise<string> {
    const challenge = await onboarding.issueEmailChallenge(email, "verify_email");
    return (
      await onboarding.registerPassword({
        challengeId: challenge.id,
        token: challenge.token,
        displayName: email.split("@")[0],
        password: "correct horse battery staple",
      })
    ).accountId;
  }

  it("SESSION-INT-001 issues opaque CSRF-bound sessions and revokes one or all", async () => {
    const accountId = await account("session-owner@example.com");
    const first = await auth.issueBrowserSession({ accountId, deviceLabel: "Firefox", platform: "web" });
    const second = await auth.issueBrowserSession({ accountId, deviceLabel: "Phone", platform: "ios" });
    const keys = await publicDeviceKeys();
    const runner = await auth.registerDevice({
      accountId,
      kind: "runner",
      label: "independent-runner",
      ...keys,
    });

    expect(first.token).not.toBe(first.csrfToken);
    await expect(auth.authenticateBrowserSession(first.token, first.csrfToken)).resolves.toEqual({ accountId });
    await expect(auth.authenticateBrowserSession(first.token, "wrong-csrf-token-value")).rejects.toThrow(
      "csrf token is invalid",
    );
    await auth.revokeBrowserSession(first.token);
    await expect(auth.authenticateBrowserSession(first.token)).rejects.toThrow("session is invalid");
    await expect(auth.authenticateBrowserSession(second.token)).resolves.toEqual({ accountId });
    expect(
      await env.CONTROL_DB.prepare("SELECT status FROM devices WHERE id = ?")
        .bind(runner.deviceId)
        .first<{ status: string }>(),
    ).toEqual({ status: "active" });
    await auth.revokeDevice(accountId, runner.deviceId);
    await expect(auth.authenticateBrowserSession(second.token)).resolves.toEqual({ accountId });
    await auth.revokeAllBrowserSessions(accountId);
    await expect(auth.authenticateBrowserSession(second.token)).rejects.toThrow("session is invalid");
  });

  it("DEVICE-INT-001 verifies a signed request against D1 and tenant-local membership once", async () => {
    const accountId = await account("device-owner@example.com");
    const workspace = await onboarding.createWorkspace({
      accountId,
      name: "Signed Device Workspace",
      slug: "signed-device-workspace",
      handle: "device-owner",
      jurisdiction: "global",
    });
    const signing = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const encryption = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    );
    const registered = await auth.registerDevice({
      accountId,
      kind: "runner",
      label: "test-runner",
      signingPublicKey: await crypto.subtle.exportKey("jwk", signing.publicKey),
      encryptionPublicKey: await crypto.subtle.exportKey("jwk", encryption.publicKey),
    });
    const body = encoder.encode('{"operation":"read"}');
    const claims = await claimsFor({
      body,
      workspaceId: workspace.workspaceId,
      memberId: workspace.memberId,
      deviceId: registered.deviceId,
      nonce: "nonce_device_001",
      requestId: "request_device_001",
    });
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        signing.privateKey,
        encoder.encode(canonicalSignedDeviceRequest(claims)),
      ),
    );

    await expect(
      auth.authorizeSignedDeviceRequest({ credential: registered.credential, claims, body, signature }),
    ).resolves.toEqual({
      accountId,
      memberId: workspace.memberId,
      workspaceId: workspace.workspaceId,
      deviceId: registered.deviceId,
    });
    await expect(
      auth.authorizeSignedDeviceRequest({ credential: registered.credential, claims, body, signature }),
    ).rejects.toThrow("request was already used");
    await expect(
      auth.authorizeSignedDeviceRequest({
        credential: registered.credential,
        claims,
        body: encoder.encode('{"operation":"write"}'),
        signature,
      }),
    ).rejects.toThrow("request body hash does not match");

    const tamperedClaims = {
      ...claims,
      nonce: "nonce_device_bad_sig",
      requestId: "request_device_bad_sig",
    };
    await expect(
      auth.authorizeSignedDeviceRequest({
        credential: registered.credential,
        claims: tamperedClaims,
        body,
        signature,
      }),
    ).rejects.toThrow("request signature is invalid");

    const next = { ...claims, nonce: "nonce_device_002", requestId: "request_device_002" };
    const nextSignature = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        signing.privateKey,
        encoder.encode(canonicalSignedDeviceRequest(next)),
      ),
    );
    await auth.revokeDevice(accountId, registered.deviceId);
    await expect(
      auth.authorizeSignedDeviceRequest({
        credential: registered.credential,
        claims: next,
        body,
        signature: nextSignature,
      }),
    ).rejects.toThrow("device is invalid");
  });

  it("DEVICE-INT-002 rejects stale tenant authority even with a valid current device signature", async () => {
    const accountId = await account("stale-member@example.com");
    const workspace = await onboarding.createWorkspace({
      accountId,
      name: "Stale Membership Workspace",
      slug: "stale-membership-workspace",
      handle: "stale-member",
      jurisdiction: "global",
    });
    const secondAccountId = await account("second-owner@example.com");
    const invite = await onboarding.inviteMember({
      workspaceId: workspace.workspaceId,
      invitedByMemberId: workspace.memberId,
      email: "second-owner@example.com",
      role: "member",
      billingConfirmed: true,
    });
    const second = await onboarding.acceptInvitation({
      invitationId: invite.id,
      token: invite.token,
      accountId: secondAccountId,
      handle: "second-owner",
    });
    await onboarding.changeMemberRole(workspace.workspaceId, second.memberId, "owner");

    const control = await env.CONTROL_DB.prepare(
      "SELECT durable_object_id FROM workspaces WHERE id = ?",
    )
      .bind(workspace.workspaceId)
      .first<{ durable_object_id: string }>();
    const socketResponse = await env.WORKSPACE.get(
      env.WORKSPACE.idFromString(control!.durable_object_id),
    ).fetch("http://workspace/_internal/member-socket", {
      headers: {
        Upgrade: "websocket",
        "x-lepidy-member-id": workspace.memberId,
        "x-lepidy-authorization-epoch": "1",
      },
    });
    expect(socketResponse.status).toBe(101);
    const socket = socketResponse.webSocket!;
    socket.accept();
    const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve, { once: true }));
    await onboarding.changeMemberRole(workspace.workspaceId, workspace.memberId, "admin");
    await expect(closed).resolves.toMatchObject({ code: 4003 });

    const signing = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const encryption = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    );
    const registered = await auth.registerDevice({
      accountId,
      kind: "client",
      label: "stale-client",
      signingPublicKey: await crypto.subtle.exportKey("jwk", signing.publicKey),
      encryptionPublicKey: await crypto.subtle.exportKey("jwk", encryption.publicKey),
    });
    const body = new Uint8Array();
    const claims = await claimsFor({
      body,
      workspaceId: workspace.workspaceId,
      memberId: workspace.memberId,
      deviceId: registered.deviceId,
      nonce: "nonce_stale_001",
      requestId: "request_stale_001",
      authorizationEpoch: 1,
    });
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        signing.privateKey,
        encoder.encode(canonicalSignedDeviceRequest(claims)),
      ),
    );
    await expect(
      auth.authorizeSignedDeviceRequest({ credential: registered.credential, claims, body, signature }),
    ).rejects.toThrow("membership is invalid");
  });
});

async function claimsFor(input: {
  body: Uint8Array;
  workspaceId: string;
  memberId: string;
  deviceId: string;
  nonce: string;
  requestId: string;
  authorizationEpoch?: number;
}): Promise<SignedDeviceClaims> {
  return {
    method: "POST",
    path: "/v1/workspace/action",
    bodyHash: toBase64Url(
      new Uint8Array(await crypto.subtle.digest("SHA-256", ownedBytes(input.body))),
    ),
    workspaceId: input.workspaceId,
    memberId: input.memberId,
    authorizationEpoch: input.authorizationEpoch ?? 1,
    deviceId: input.deviceId,
    deviceKeyEpoch: 1,
    timestamp: NOW,
    nonce: input.nonce,
    requestId: input.requestId,
    projectId: "project_fixture",
    configRevision: 1,
  };
}

function toBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function publicDeviceKeys(): Promise<{
  signingPublicKey: JsonWebKey;
  encryptionPublicKey: JsonWebKey;
}> {
  const signing = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const encryption = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  return {
    signingPublicKey: await crypto.subtle.exportKey("jwk", signing.publicKey),
    encryptionPublicKey: await crypto.subtle.exportKey("jwk", encryption.publicKey),
  };
}

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
  copy.set(value);
  return copy;
}
