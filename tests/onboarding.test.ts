import { env } from "cloudflare:workers";
import { applyD1Migrations, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import type { Workspace } from "../src/cloudflare/workspace";
import { OnboardingService } from "../src/control/onboarding";
import {
  SimpleWebAuthnPasskeyProvider,
  type PasskeyProvider,
} from "../src/control/passkeys";

const NOW = 1_800_000_000_000;

describe("identity and workspace onboarding", () => {
  let service: OnboardingService;

  beforeAll(async () => {
    await applyD1Migrations(env.CONTROL_DB, env.TEST_CONTROL_MIGRATIONS);
    service = new OnboardingService(env.CONTROL_DB, env.WORKSPACE, () => NOW);
  });

  it("IDENTITY-INT-001 verifies email, hashes a password and consumes links once", async () => {
    const verification = await service.issueEmailChallenge(" Maya@Example.COM ", "verify_email");
    const { accountId } = await service.registerPassword({
      challengeId: verification.id,
      token: verification.token,
      displayName: "Maya Chen",
      password: "correct horse battery staple",
    });

    await expect(
      service.registerPassword({
        challengeId: verification.id,
        token: verification.token,
        displayName: "Replay",
        password: "correct horse battery staple",
      }),
    ).rejects.toThrow("challenge is invalid");
    await expect(service.authenticatePassword("maya@example.com", "wrong password value")).resolves.toBeNull();
    await expect(
      service.authenticatePassword("MAYA@example.com", "correct horse battery staple"),
    ).resolves.toBe(accountId);

    const emailLogin = await service.issueEmailChallenge("maya@example.com", "email_login");
    await expect(service.authenticateEmailLink(emailLogin.id, emailLogin.token)).resolves.toBe(accountId);
    await expect(service.authenticateEmailLink(emailLogin.id, emailLogin.token)).rejects.toThrow(
      "challenge is invalid",
    );
  });

  it("IDENTITY-INT-002 never auto-links a matching verified Google email", async () => {
    const account = await env.CONTROL_DB.prepare(
      "SELECT id FROM accounts WHERE primary_email_normalized = 'maya@example.com'",
    ).first<{ id: string }>();
    expect(account).not.toBeNull();
    const assertion = {
      provider: "google" as const,
      subject: "google-maya-1",
      email: "maya@example.com",
      emailVerified: true,
    };

    await expect(service.authenticateGoogle(assertion)).resolves.toEqual({ status: "link_required" });
    await expect(
      service.linkGoogle(account!.id, assertion, {
        freshSession: true,
        stepUpVerified: false,
        confirmed: true,
      }),
    ).rejects.toThrow("step-up verification required");
    await service.linkGoogle(account!.id, assertion, {
      freshSession: true,
      stepUpVerified: true,
      confirmed: true,
    });
    await expect(service.authenticateGoogle(assertion)).resolves.toEqual({
      status: "authenticated",
      accountId: account!.id,
    });
  });

  it("PASSKEY-INT-001 binds required-UV ceremonies to one account and consumes each challenge once", async () => {
    const account = await env.CONTROL_DB.prepare(
      "SELECT id FROM accounts WHERE primary_email_normalized = 'maya@example.com'",
    ).first<{ id: string }>();
    const realOptions = new SimpleWebAuthnPasskeyProvider();
    const provider: PasskeyProvider = {
      registrationOptions: (input) => realOptions.registrationOptions(input),
      authenticationOptions: (existing) => realOptions.authenticationOptions(existing),
      async verifyRegistration() {
        return {
          id: "credential-alpha",
          publicKey: new Uint8Array([1, 2, 3, 4]),
          counter: 0,
          transports: ["internal"],
        };
      },
      async verifyAuthentication() {
        return 1;
      },
    };
    const passkeys = new OnboardingService(env.CONTROL_DB, env.WORKSPACE, () => NOW, provider);

    const registration = await passkeys.beginPasskeyRegistration(account!.id, {
      freshSession: true,
      stepUpVerified: true,
      confirmed: true,
    });
    expect(registration.options.rp.id).toBe("app.lepidy.com");
    expect(registration.options.authenticatorSelection?.userVerification).toBe("required");
    await expect(
      passkeys.finishPasskeyRegistration({
        accountId: account!.id,
        challengeId: registration.id,
        response: { fixture: true },
      }),
    ).resolves.toBe("credential-alpha");
    await expect(
      passkeys.finishPasskeyRegistration({
        accountId: account!.id,
        challengeId: registration.id,
        response: { replay: true },
      }),
    ).rejects.toThrow("passkey challenge is invalid");

    const authentication = await passkeys.beginPasskeyAuthentication(account!.id);
    expect(authentication.options.rpId).toBe("app.lepidy.com");
    expect(authentication.options.userVerification).toBe("required");
    expect(authentication.options.allowCredentials?.[0]?.id).toBe("credential-alpha");
    await expect(
      passkeys.finishPasskeyAuthentication({
        accountId: account!.id,
        challengeId: authentication.id,
        credentialId: "credential-alpha",
        response: { fixture: true },
      }),
    ).resolves.toBe(account!.id);

    const stored = await env.CONTROL_DB.prepare(
      "SELECT sign_count FROM passkeys WHERE account_id = ?",
    )
      .bind(account!.id)
      .first<{ sign_count: number }>();
    expect(stored?.sign_count).toBe(1);
  });

  it("ONBOARD-INT-001 provisions one owner in D1 and the tenant object", async () => {
    const account = await env.CONTROL_DB.prepare(
      "SELECT id FROM accounts WHERE primary_email_normalized = 'maya@example.com'",
    ).first<{ id: string }>();
    const created = await service.createWorkspace({
      accountId: account!.id,
      name: "Acme Engineering",
      slug: "acme-eng",
      handle: "maya",
      jurisdiction: "global",
    });
    const control = await env.CONTROL_DB.prepare(
      `SELECT w.status AS workspace_status, w.storage_mode, w.durable_object_id, m.status AS member_status, m.role
       FROM workspaces w JOIN memberships m ON m.workspace_id = w.id
       WHERE w.id = ? AND m.member_id = ?`,
    )
      .bind(created.workspaceId, created.memberId)
      .first<{
        workspace_status: string;
        storage_mode: string;
        durable_object_id: string;
        member_status: string;
        role: string;
      }>();
    expect(control).toMatchObject({
      workspace_status: "active",
      storage_mode: "local_host",
      member_status: "active",
      role: "owner",
    });

    const stub = env.WORKSPACE.get(env.WORKSPACE.idFromString(control!.durable_object_id));
    await runInDurableObject<Workspace, void>(stub, (_instance, state) => {
      const config = state.storage.sql
        .exec<{ storage_mode: string; host_epoch: number }>(
          "SELECT storage_mode, host_epoch FROM workspace_config WHERE singleton = 1",
        )
        .one();
      const member = state.storage.sql
        .exec<{ id: string; account_id: string; handle: string; role: string; status: string }>(
          "SELECT id, account_id, handle, role, status FROM members WHERE id = ?",
          created.memberId,
        )
        .one();
      expect(member).toEqual({
        id: created.memberId,
        account_id: account!.id,
        handle: "maya",
        role: "owner",
        status: "active",
      });
      expect(config).toEqual({ storage_mode: "local_host", host_epoch: 0 });
      expect(state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM messages").one().count).toBe(0);
    });

    await expect(service.changeMemberRole(created.workspaceId, created.memberId, "admin")).rejects.toThrow(
      "workspace requires an active owner",
    );
  });

  it("ONBOARD-INT-002 binds an invitation to its verified email and accepts it once", async () => {
    const maya = await env.CONTROL_DB.prepare(
      "SELECT id FROM accounts WHERE primary_email_normalized = 'maya@example.com'",
    ).first<{ id: string }>();
    const owner = await env.CONTROL_DB.prepare(
      "SELECT workspace_id, member_id FROM memberships WHERE account_id = ? AND role = 'owner'",
    )
      .bind(maya!.id)
      .first<{ workspace_id: string; member_id: string }>();
    const invite = await service.inviteMember({
      workspaceId: owner!.workspace_id,
      invitedByMemberId: owner!.member_id,
      email: "Lee@example.com",
      role: "member",
    });

    const wrongVerification = await service.issueEmailChallenge("other@example.com", "verify_email");
    const wrong = await service.registerPassword({
      challengeId: wrongVerification.id,
      token: wrongVerification.token,
      displayName: "Wrong Person",
      password: "another correct horse battery",
    });
    await expect(
      service.acceptInvitation({
        invitationId: invite.id,
        token: invite.token,
        accountId: wrong.accountId,
        handle: "wrong",
      }),
    ).rejects.toThrow("invitation email is not verified");

    const leeVerification = await service.issueEmailChallenge("lee@example.com", "verify_email");
    const lee = await service.registerPassword({
      challengeId: leeVerification.id,
      token: leeVerification.token,
      displayName: "Lee Ortiz",
      password: "one more correct horse battery",
    });
    const accepted = await service.acceptInvitation({
      invitationId: invite.id,
      token: invite.token,
      accountId: lee.accountId,
      handle: "lee",
    });
    await expect(
      service.acceptInvitation({
        invitationId: invite.id,
        token: invite.token,
        accountId: lee.accountId,
        handle: "lee-two",
      }),
    ).rejects.toThrow("invitation is invalid");

    const member = await env.CONTROL_DB.prepare(
      "SELECT role, status FROM memberships WHERE member_id = ?",
    )
      .bind(accepted.memberId)
      .first<{ role: string; status: string }>();
    expect(member).toEqual({ role: "member", status: "active" });

    await service.changeMemberRole(owner!.workspace_id, accepted.memberId, "owner");
    await service.changeMemberRole(owner!.workspace_id, owner!.member_id, "admin");
    const roles = await env.CONTROL_DB.prepare(
      "SELECT member_id, role FROM memberships WHERE workspace_id = ? ORDER BY member_id",
    )
      .bind(owner!.workspace_id)
      .all<{ member_id: string; role: string }>();
    expect(roles.results).toEqual(
      expect.arrayContaining([
        { member_id: accepted.memberId, role: "owner" },
        { member_id: owner!.member_id, role: "admin" },
      ]),
    );
  });
});
