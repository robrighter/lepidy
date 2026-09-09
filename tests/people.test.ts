import { env } from "cloudflare:workers";
import { applyD1Migrations, runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import type { Actor, Workspace } from "../src/cloudflare/workspace";
import { AdministrationService } from "../src/control/administration";
import { OnboardingService } from "../src/control/onboarding";

const NOW = 1_800_000_000_000;

async function register(service: OnboardingService, email: string, displayName: string): Promise<string> {
  const challenge = await service.issueEmailChallenge(email, "verify_email");
  return (await service.registerPassword({
    challengeId: challenge.id, token: challenge.token, displayName,
    password: "correct horse battery staple",
  })).accountId;
}

describe("people, groups and administration", () => {
  beforeAll(async () => applyD1Migrations(env.CONTROL_DB, env.TEST_CONTROL_MIGRATIONS));

  it("C07-INT-001 exposes safe profiles and creator/admin-controlled groups with notification fan-out", async () => {
    const stub = env.WORKSPACE.getByName("c07-directory");
    await stub.initializeWorkspace({ storageMode: "cloud", hostEpoch: 0, routingEpoch: 1, now: NOW });
    const members = [
      ["owner", "maya", "Maya Chen", "owner"],
      ["creator", "lee", "Lee Ortiz", "member"],
      ["other", "priya", "Priya Singh", "member"],
    ] as const;
    for (const [memberId, handle, displayName, role] of members) await stub.applyMembership({
      operationId: `c07-directory-${memberId}`, memberId, accountId: `account-${memberId}`,
      handle, displayName, role, status: "active", authorizationEpoch: 1, version: 1, now: NOW,
    });
    const owner: Actor = { memberId: "owner", authorizationEpoch: 1 };
    const creator: Actor = { memberId: "creator", authorizationEpoch: 1 };
    const other: Actor = { memberId: "other", authorizationEpoch: 1 };

    await stub.updateOwnProfile({ actor: creator, displayName: "Lee Ortiz", title: "Platform", timezone: "Europe/London", workingStartMinute: 540, workingEndMinute: 1020, customStatus: "On call", availability: "focus", now: NOW + 1 });
    expect((await stub.listPeople({ actor: other })).people.find((person) => person.id === "creator")).toMatchObject({
      title: "Platform", timezone: "Europe/London", customStatus: "On call", workingStartMinute: 540,
      availability: "focus", presence: "focus",
    });
    // Clearing the declaration hands the dot back to the connection state, and
    // an unknown value is refused rather than stored.
    await runInDurableObject<Workspace, void>(stub, async (instance) => {
      await expect(instance.updateOwnProfile({ actor: creator, displayName: "Lee Ortiz", availability: "invisible", now: NOW + 1 })).rejects.toThrow("auto, focus or away");
    });
    await stub.updateOwnProfile({ actor: creator, displayName: "Lee Ortiz", availability: "auto", now: NOW + 1 });
    expect((await stub.listPeople({ actor: other })).people.find((person) => person.id === "creator")).toMatchObject({
      availability: "auto", presence: "offline",
    });

    const group = await stub.createGroup({
      actor: creator, idempotencyKey: "c07-group-create-0001", handle: "Platform", displayName: "Platform",
      description: "Shipping group", memberIds: ["owner", "creator"], now: NOW + 2,
    });
    expect((await stub.listPeople({ actor: other })).groups[0]).toMatchObject({ handle: "g.platform", memberIds: ["creator", "owner"] });
    await runInDurableObject<Workspace, void>(stub, async (instance) => {
      await expect(instance.replaceGroupMembers({ actor: other, groupId: group.groupId, memberIds: ["other"], now: NOW + 3 })).rejects.toThrow("creator or an administrator");
    });
    await stub.replaceGroupMembers({ actor: owner, groupId: group.groupId, memberIds: ["owner", "other"], now: NOW + 4 });

    const channel = await stub.createChannel({ actor: creator, idempotencyKey: "c07-channel-create-01", kind: "public", slug: "platform", memberIds: ["owner", "other"], now: NOW + 5 });
    await stub.sendMessage({ actor: creator, idempotencyKey: "c07-group-message-001", channelId: channel.channelId, bodyMarkdown: "@g.platform release review", now: NOW + 6 });
    expect(await stub.listNotificationActivity({ actor: owner })).toMatchObject({ unread: { total: 1 }, items: [{ kind: "mention" }] });
    expect(await stub.listNotificationActivity({ actor: other })).toMatchObject({ unread: { total: 1 }, items: [{ kind: "mention" }] });

    const empty = await stub.createGroup({ actor: creator, idempotencyKey: "c07-group-empty-0001", handle: "g.empty", displayName: "Empty", now: NOW + 7 });
    await runInDurableObject<Workspace, void>(stub, async (instance) => {
      await expect(instance.sendMessage({ actor: creator, idempotencyKey: "c07-empty-message-001", channelId: channel.channelId, bodyMarkdown: "@g.empty hello", now: NOW + 8 })).rejects.toThrow("no active members");
    });
    await stub.archiveGroup({ actor: creator, groupId: empty.groupId, now: NOW + 9 });
    expect((await stub.listPeople({ actor: creator })).groups.some((entry) => entry.id === empty.groupId)).toBe(false);
  });

  it("C07-INT-002 holds seat-bound invitations and enforces role, offboarding and transfer authority across both planes", async () => {
    const service = new OnboardingService(env.CONTROL_DB, env.WORKSPACE, () => NOW);
    const administration = new AdministrationService(env.CONTROL_DB, env.WORKSPACE, () => NOW);
    const ownerAccount = await register(service, "c07-owner@example.com", "C07 Owner");
    const workspace = await service.createWorkspace({ accountId: ownerAccount, name: "C07 Admin", slug: "c07-admin", handle: "owner", jurisdiction: "global" });
    const invite = await administration.inviteMember({ workspaceId: workspace.workspaceId, invitedByMemberId: workspace.memberId, email: "c07-target@example.com", role: "member" });
    expect(invite.heldForPlan).toBe(true);
    await expect(administration.inviteMember({ workspaceId: workspace.workspaceId, invitedByMemberId: workspace.memberId, email: " C07-TARGET@example.com ", role: "member" })).rejects.toThrow("pending invitation");
    const targetAccount = await register(service, "c07-target@example.com", "C07 Target");
    await expect(service.acceptInvitation({ invitationId: invite.id, token: invite.token, accountId: targetAccount, handle: "target" })).rejects.toThrow("invalid or expired");
    await administration.confirmInvitationPlan(workspace.workspaceId, workspace.memberId, invite.id);
    const target = await service.acceptInvitation({ invitationId: invite.id, token: invite.token, accountId: targetAccount, handle: "target" });

    await expect(administration.administerMember({ workspaceId: workspace.workspaceId, actorMemberId: target.memberId, memberId: workspace.memberId, role: "member" })).rejects.toThrow("owner or admin");
    await expect(administration.transferOwnership({ workspaceId: workspace.workspaceId, actorMemberId: workspace.memberId, targetMemberId: target.memberId, confirmation: "yes" })).rejects.toThrow("did not match");
    await administration.transferOwnership({ workspaceId: workspace.workspaceId, actorMemberId: workspace.memberId, targetMemberId: target.memberId, confirmation: "transfer ownership to @target" });
    expect((await administration.listAdministration(workspace.workspaceId, target.memberId)).members).toEqual(expect.arrayContaining([
      expect.objectContaining({ memberId: target.memberId, role: "owner" }),
      expect.objectContaining({ memberId: workspace.memberId, role: "admin" }),
    ]));

    const doId = await env.CONTROL_DB.prepare("SELECT durable_object_id FROM workspaces WHERE id = ?").bind(workspace.workspaceId).first<{ durable_object_id: string }>();
    const stub = env.WORKSPACE.get(env.WORKSPACE.idFromString(doId!.durable_object_id));
    const formerOwner: Actor = { memberId: workspace.memberId, authorizationEpoch: 2 };
    const channel = await stub.createChannel({
      actor: formerOwner, idempotencyKey: "c07-offboard-channel", kind: "public", slug: "offboarding", now: NOW,
    });
    const agent = await stub.createAgent({ actor: formerOwner, idempotencyKey: "c07-offboard-agent", handle: "helper", now: NOW });
    const delegation = await stub.createAgentDelegation({
      actor: formerOwner, agent: agent.agentId, channelIds: [channel.channelId], credentialIds: [], deliveryModes: ["inject"],
      projectIds: [], expiresAt: NOW + 60_000, now: NOW,
    });
    const session = await stub.startAgentSession({
      actor: formerOwner, delegationId: delegation.id, deviceId: "c07-runner", runnerEpoch: 1, presetRevision: 1,
      capabilities: ["whoami"], now: NOW,
    });

    await administration.administerMember({ workspaceId: workspace.workspaceId, actorMemberId: target.memberId, memberId: workspace.memberId, status: "removed" });
    const control = await env.CONTROL_DB.prepare("SELECT status, authorization_epoch FROM memberships WHERE member_id = ?").bind(workspace.memberId).first<{ status: string; authorization_epoch: number }>();
    expect(control).toMatchObject({ status: "removed", authorization_epoch: 3 });
    expect(await stub.authorizeMember(workspace.memberId, 2)).toBe(false);
    expect(await stub.authenticateMcpToken({ token: session.token, audience: "", toolName: "whoami", now: NOW + 1 })).toMatchObject({ ok: false });
    await runInDurableObject<Workspace, void>(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ revoked_reason: string }>("SELECT revoked_reason FROM agent_delegations WHERE id = ?", delegation.id).one()).toEqual({ revoked_reason: "owner_authority_changed" });
      expect(state.storage.sql.exec<{ revoked_reason: string }>("SELECT revoked_reason FROM agent_sessions WHERE id = ?", session.sessionId).one()).toEqual({ revoked_reason: "owner_authority_changed" });
    });
  });

  it("C07-INT-003 hides inactive directory entries from members while retaining administrator tombstones", async () => {
    const stub = env.WORKSPACE.getByName("c07-tombstones");
    await stub.initializeWorkspace({ storageMode: "cloud", hostEpoch: 0, routingEpoch: 1, now: NOW });
    await stub.applyMembership({ operationId: "c07-tomb-owner", memberId: "owner", accountId: "tomb-owner", handle: "owner", displayName: "Owner", role: "owner", status: "active", authorizationEpoch: 1, version: 1, now: NOW });
    await stub.applyMembership({ operationId: "c07-tomb-member", memberId: "member", accountId: "tomb-member", handle: "member", displayName: "Former Member", role: "member", status: "removed", authorizationEpoch: 2, version: 1, now: NOW });
    await stub.applyMembership({ operationId: "c07-tomb-viewer", memberId: "viewer", accountId: "tomb-viewer", handle: "viewer", displayName: "Viewer", role: "member", status: "active", authorizationEpoch: 1, version: 1, now: NOW });
    const owner: Actor = { memberId: "owner", authorizationEpoch: 1 };
    expect((await stub.listPeople({ actor: owner })).people).toEqual(expect.arrayContaining([expect.objectContaining({ id: "member", status: "removed" })]));
    expect((await stub.listPeople({ actor: { memberId: "viewer", authorizationEpoch: 1 } })).people.some((person) => person.id === "member")).toBe(false);
  });
});
