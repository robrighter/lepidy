import { env } from "cloudflare:workers";
import { applyD1Migrations, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import type { Workspace } from "../src/cloudflare/workspace";
import { AuthorizationService } from "../src/control/authorization";
import { OnboardingService } from "../src/control/onboarding";
import { ControlPlaneShellSource } from "../src/shell/workspace-shell-source";

const NOW = 1_800_000_000_000;

describe("workspace shell data adapter", () => {
  let onboarding: OnboardingService;
  let authorization: AuthorizationService;

  beforeAll(async () => {
    await applyD1Migrations(env.CONTROL_DB, env.TEST_CONTROL_MIGRATIONS);
    onboarding = new OnboardingService(env.CONTROL_DB, env.WORKSPACE, () => NOW);
    authorization = new AuthorizationService(env.CONTROL_DB, env.WORKSPACE, () => NOW);
  });

  async function account(email: string, displayName: string): Promise<string> {
    const challenge = await onboarding.issueEmailChallenge(email, "verify_email");
    const { accountId } = await onboarding.registerPassword({
      challengeId: challenge.id,
      token: challenge.token,
      displayName,
      password: "correct horse battery staple",
    });
    return accountId;
  }

  function source(token: string | null) {
    return new ControlPlaneShellSource(
      {
        db: env.CONTROL_DB,
        workspaces: env.WORKSPACE,
        authenticateSession: (value) => authorization.authenticateBrowserSession(value),
      },
      token,
    );
  }

  it("SHELL-DATA-INT-001 renders a signed-in workspace and hides a room the viewer is not in", async () => {
    const ownerAccount = await account("shell-owner@example.test", "Maya Chen");
    const guestAccount = await account("shell-guest@example.test", "Daniel Park");
    const { workspaceId, memberId } = await onboarding.createWorkspace({
      accountId: ownerAccount,
      name: "Shell Workspace",
      slug: "shell-workspace",
      handle: "maya",
      jurisdiction: "global",
    });
    const invitation = await onboarding.inviteMember({
      workspaceId,
      invitedByMemberId: memberId,
      email: "shell-guest@example.test",
      role: "member",
    });
    const guest = await onboarding.acceptInvitation({
      invitationId: invitation.id,
      token: invitation.token,
      accountId: guestAccount,
      handle: "daniel",
    });

    const row = await env.CONTROL_DB.prepare(
      "SELECT durable_object_id FROM workspaces WHERE id = ?",
    )
      .bind(workspaceId)
      .first<{ durable_object_id: string }>();
    const stub = env.WORKSPACE.get(env.WORKSPACE.idFromString(row!.durable_object_id));

    // A public room, an archived room and a private room only the owner is in.
    await runInDurableObject<Workspace, void>(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO channels(id, kind, slug, name, archived_at, created_at, updated_at) VALUES
           ('channel-eng', 'public', 'eng', 'Engineering', NULL, ?, ?),
           ('channel-old', 'public', 'old', 'Retired', ?, ?, ?),
           ('channel-design', 'private', 'design', 'Design', NULL, ?, ?)`,
        NOW, NOW, NOW, NOW, NOW, NOW, NOW,
      );
      state.storage.sql.exec(
        "INSERT INTO channel_members(channel_id, member_id, joined_at) VALUES ('channel-design', ?, ?)",
        memberId,
        NOW,
      );
      state.storage.sql.exec(
        `INSERT INTO agents(id, handle, display_name, status, created_at, updated_at) VALUES
           ('agent-release', 'a.releasebot', 'Release Bot', 'active', ?, ?),
           ('agent-gone', 'a.retired', 'Retired', 'archived', ?, ?)`,
        NOW, NOW, NOW, NOW,
      );
    });

    const ownerSession = await authorization.issueBrowserSession({
      accountId: ownerAccount,
      deviceLabel: "shell test browser",
      platform: "test",
    });
    const ownerState = await source(ownerSession.token).load();
    expect(ownerState.status).toBe("ready");
    if (ownerState.status !== "ready") throw new Error("expected a ready shell");

    expect(ownerState.authenticated).toBe(true);
    expect(ownerState.workspace).toMatchObject({ slug: "shell-workspace", name: "Shell Workspace", plan: "solo" });
    expect(ownerState.snapshot.viewer).toMatchObject({ memberId, handle: "maya", role: "owner" });
    expect(ownerState.snapshot.channels.map((channel) => channel.id)).toEqual([
      "channel-design",
      "channel-eng",
    ]);
    // Archived rooms are gone and the private room is marked as the viewer's own.
    expect(ownerState.snapshot.channels.find((channel) => channel.id === "channel-design")?.isMember).toBe(true);
    expect(ownerState.snapshot.agents.map((agent) => agent.handle)).toEqual(["a.releasebot"]);
    expect(ownerState.snapshot.storageMode).toBe("local_host");

    // Same workspace, a valid session, a member who is not in the private room.
    const guestSession = await authorization.issueBrowserSession({
      accountId: guestAccount,
      deviceLabel: "shell test browser",
      platform: "test",
    });
    const guestState = await source(guestSession.token).load();
    if (guestState.status !== "ready") throw new Error("expected a ready shell");
    expect(guestState.snapshot.viewer.memberId).toBe(guest.memberId);
    expect(guestState.snapshot.channels.map((channel) => channel.id)).toEqual(["channel-eng"]);
    expect(JSON.stringify(guestState)).not.toContain("Design");
  });

  it("SHELL-DATA-INT-002 refuses a missing, forged, revoked or unmatched session", async () => {
    await expect(source(null).load()).resolves.toEqual({ status: "signed_out" });
    await expect(source("not-a-real-session-token").load()).resolves.toEqual({ status: "signed_out" });

    const orphan = await account("shell-orphan@example.test", "Priya Singh");
    const orphanSession = await authorization.issueBrowserSession({
      accountId: orphan,
      deviceLabel: "shell test browser",
      platform: "test",
    });
    await expect(source(orphanSession.token).load()).resolves.toEqual({
      status: "unavailable",
      reason: "no active workspace membership",
    });

    const revokedAccount = await account("shell-revoked@example.test", "Sam Reed");
    await onboarding.createWorkspace({
      accountId: revokedAccount,
      name: "Revoked Workspace",
      slug: "revoked-workspace",
      handle: "sam",
      jurisdiction: "global",
    });
    const session = await authorization.issueBrowserSession({
      accountId: revokedAccount,
      deviceLabel: "shell test browser",
      platform: "test",
    });
    await expect(source(session.token).load()).resolves.toMatchObject({ status: "ready" });

    await authorization.revokeBrowserSession(session.token);
    await expect(source(session.token).load()).resolves.toEqual({ status: "signed_out" });
  });

  it("SHELL-DATA-INT-003 refuses a shell read whose membership epoch is stale", async () => {
    const stub = env.WORKSPACE.getByName("shell-epoch");
    await stub.initializeWorkspace({ storageMode: "cloud", hostEpoch: 0, routingEpoch: 1, now: NOW });
    // The workspace keeps a separate owner, so suspending this member is not
    // blocked by the last-owner guard.
    await stub.applyMembership({
      operationId: "op-shell-epoch-owner",
      memberId: "member-owner",
      accountId: "account-owner",
      handle: "grace",
      displayName: "Grace Hopper",
      role: "owner",
      status: "active",
      authorizationEpoch: 1,
      version: 1,
      now: NOW,
    });
    await stub.applyMembership({
      operationId: "op-shell-epoch-1",
      memberId: "member-epoch",
      accountId: "account-epoch",
      handle: "ada",
      displayName: "Ada Lovelace",
      role: "member",
      status: "active",
      authorizationEpoch: 1,
      version: 1,
      now: NOW,
    });

    await expect(
      stub.shellSnapshot({ memberId: "member-epoch", authorizationEpoch: 1 }),
    ).resolves.toMatchObject({ viewer: { handle: "ada" } });

    await runInDurableObject<Workspace, void>(stub, async (instance) => {
      // A wrong epoch, an unknown member and a suspended member all fail closed.
      expect(() =>
        instance.shellSnapshot({ memberId: "member-epoch", authorizationEpoch: 2 }),
      ).toThrow("member is not authorized for this workspace");
      expect(() =>
        instance.shellSnapshot({ memberId: "member-unknown", authorizationEpoch: 1 }),
      ).toThrow("member is not authorized for this workspace");

      await instance.applyMembership({
        operationId: "op-shell-epoch-2",
        memberId: "member-epoch",
        accountId: "account-epoch",
        handle: "ada",
        displayName: "Ada Lovelace",
        role: "member",
        status: "suspended",
        authorizationEpoch: 2,
        version: 2,
        now: NOW + 1,
      });
      expect(() =>
        instance.shellSnapshot({ memberId: "member-epoch", authorizationEpoch: 2 }),
      ).toThrow("member is not authorized for this workspace");
    });
  });
});
