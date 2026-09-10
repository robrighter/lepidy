import type { Workspace } from "../cloudflare/workspace";
import { mayAdministerMember, ownershipTransferConfirmation, type MemberStatus, type WorkspaceRole } from "../domain/people";
import { normalizeEmail } from "./identity-rules";
import { hashOpaqueToken, randomToken } from "./opaque-tokens";

export type IssuedInvitation = { id: string; token: string; expiresAt: number; heldForPlan: boolean };
export type AdministrationSnapshot = {
  members: readonly { memberId: string; displayName: string; email: string; role: WorkspaceRole; status: MemberStatus; authorizationEpoch: number }[];
  invitations: readonly { id: string; email: string; role: Exclude<WorkspaceRole, "owner">; expiresAt: number; createdAt: number; deliveryState: "ready" | "held_for_plan" }[];
};

export class AdministrationService {
  constructor(
    private readonly db: D1Database,
    private readonly workspaces: DurableObjectNamespace<Workspace>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async inviteMember(input: { workspaceId: string; invitedByMemberId: string; email: string; role: Exclude<WorkspaceRole, "owner">; billingConfirmed?: boolean }): Promise<IssuedInvitation> {
    const inviter = await this.db.prepare(
      `SELECT m.role, m.status,
              (SELECT seat_quantity FROM subscriptions s WHERE s.workspace_id = m.workspace_id) AS paid_seats
       FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
       WHERE m.workspace_id = ? AND m.member_id = ?`,
    ).bind(input.workspaceId, input.invitedByMemberId).first<{ role: WorkspaceRole; status: string; paid_seats: number | null }>();
    if (!inviter || inviter.status !== "active" || (inviter.role !== "owner" && inviter.role !== "admin")) throw new Error("active owner or admin required to invite");
    const email = normalizeEmail(input.email);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("invitation email is invalid");
    const existing = await this.db.prepare(
      `SELECT 1 AS present FROM memberships m JOIN accounts a ON a.id = m.account_id
       WHERE m.workspace_id = ? AND a.primary_email_normalized = ? AND m.status <> 'removed'
       UNION ALL SELECT 1 FROM invitations WHERE workspace_id = ? AND email_normalized = ?
       AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? LIMIT 1`,
    ).bind(input.workspaceId, email, input.workspaceId, email, this.now()).first<{ present: number }>();
    if (existing) throw new Error("that person is already a member or has a pending invitation");
    const id = crypto.randomUUID();
    const token = randomToken();
    const createdAt = this.now();
    const expiresAt = createdAt + 7 * 24 * 60 * 60_000;
    if (inviter.paid_seats === null) throw new Error("workspace entitlement not found");
    await this.db.prepare(
      `INSERT INTO invitations(id, workspace_id, email_normalized, token_hash, role, invited_by_member_id,
         expires_at, created_at, delivery_state, last_sent_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?,
         CASE WHEN
           (SELECT COUNT(*) FROM memberships WHERE workspace_id = ? AND status = 'active')
           + (SELECT COUNT(*) FROM invitations WHERE workspace_id = ? AND delivery_state = 'ready'
               AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?)
           >= (SELECT seat_quantity FROM subscriptions WHERE workspace_id = ?)
         THEN 'held_for_plan' ELSE 'ready' END,
         CASE WHEN
           (SELECT COUNT(*) FROM memberships WHERE workspace_id = ? AND status = 'active')
           + (SELECT COUNT(*) FROM invitations WHERE workspace_id = ? AND delivery_state = 'ready'
               AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?)
           >= (SELECT seat_quantity FROM subscriptions WHERE workspace_id = ?)
         THEN NULL ELSE ? END`,
    ).bind(id, input.workspaceId, email, await hashOpaqueToken(token), input.role, input.invitedByMemberId,
      expiresAt, createdAt,
      input.workspaceId, input.workspaceId, createdAt, input.workspaceId,
      input.workspaceId, input.workspaceId, createdAt, input.workspaceId, createdAt).run();
    const inserted = await this.db.prepare("SELECT delivery_state FROM invitations WHERE id = ?")
      .bind(id).first<{ delivery_state: "ready" | "held_for_plan" }>();
    const heldForPlan = inserted?.delivery_state === "held_for_plan";
    return { id, token, expiresAt, heldForPlan };
  }

  async listAdministration(workspaceId: string, actorMemberId: string): Promise<AdministrationSnapshot> {
    await this.requireAdministrator(workspaceId, actorMemberId);
    const members = await this.db.prepare(
      `SELECT m.member_id, a.display_name, a.primary_email_normalized, m.role, m.status, m.authorization_epoch
       FROM memberships m JOIN accounts a ON a.id = m.account_id WHERE m.workspace_id = ?
       ORDER BY a.display_name COLLATE NOCASE, m.member_id`,
    ).bind(workspaceId).all<{ member_id: string; display_name: string; primary_email_normalized: string; role: WorkspaceRole; status: MemberStatus; authorization_epoch: number }>();
    const invitations = await this.db.prepare(
      `SELECT id, email_normalized, role, expires_at, created_at, delivery_state FROM invitations
       WHERE workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC`,
    ).bind(workspaceId, this.now()).all<{ id: string; email_normalized: string; role: Exclude<WorkspaceRole, "owner">; expires_at: number; created_at: number; delivery_state: "ready" | "held_for_plan" }>();
    return {
      members: members.results.map((row) => ({ memberId: row.member_id, displayName: row.display_name, email: row.primary_email_normalized, role: row.role, status: row.status, authorizationEpoch: row.authorization_epoch })),
      invitations: invitations.results.map((row) => ({ id: row.id, email: row.email_normalized, role: row.role, expiresAt: row.expires_at, createdAt: row.created_at, deliveryState: row.delivery_state })),
    };
  }

  async revokeInvitation(workspaceId: string, actorMemberId: string, invitationId: string): Promise<void> {
    await this.requireAdministrator(workspaceId, actorMemberId);
    const result = await this.db.prepare("UPDATE invitations SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL").bind(this.now(), invitationId, workspaceId).run();
    if (result.meta.changes !== 1) throw new Error("pending invitation not found");
  }

  async confirmInvitationPlan(workspaceId: string, actorMemberId: string, invitationId: string): Promise<void> {
    await this.requireAdministrator(workspaceId, actorMemberId);
    const result = await this.db.prepare(
      `UPDATE invitations SET delivery_state = 'ready', last_sent_at = ?
       WHERE id = ? AND workspace_id = ? AND delivery_state = 'held_for_plan'
         AND accepted_at IS NULL AND revoked_at IS NULL
         AND (SELECT COUNT(*) FROM memberships WHERE workspace_id = ? AND status = 'active')
           + (SELECT COUNT(*) FROM invitations WHERE workspace_id = ? AND delivery_state = 'ready'
               AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?)
           < (SELECT seat_quantity FROM subscriptions WHERE workspace_id = ?)`,
    ).bind(this.now(), invitationId, workspaceId, workspaceId, workspaceId, this.now(), workspaceId).run();
    if (result.meta.changes === 1) return;
    const held = await this.db.prepare(
      "SELECT 1 AS present FROM invitations WHERE id = ? AND workspace_id = ? AND delivery_state = 'held_for_plan' AND accepted_at IS NULL AND revoked_at IS NULL",
    ).bind(invitationId, workspaceId).first<{ present: number }>();
    if (held) throw new Error("increase the workspace seat capacity before releasing this invitation");
    throw new Error("held invitation not found");
  }

  async administerMember(input: { workspaceId: string; actorMemberId: string; memberId: string; role?: WorkspaceRole; status?: Exclude<MemberStatus, "pending"> }): Promise<void> {
    const actor = await this.requireAdministrator(input.workspaceId, input.actorMemberId);
    const target = await this.memberRow(input.workspaceId, input.memberId);
    if (!mayAdministerMember({ actorRole: actor.role, actorId: actor.memberId, targetRole: target.role, targetId: target.memberId, nextRole: input.role, nextStatus: input.status })) throw new Error("that role cannot administer this member");
    if (target.status !== "active" && input.status === "active") {
      const capacity = await this.seatCapacity(input.workspaceId);
      if (capacity.activeSeats + capacity.readyInvitations >= capacity.seatQuantity) {
        throw new Error("increase the workspace seat capacity before restoring this person");
      }
    }
    await this.changeMemberProjection(input.workspaceId, input.memberId, input.role ?? target.role, input.status ?? target.status);
  }

  async transferOwnership(input: { workspaceId: string; actorMemberId: string; targetMemberId: string; confirmation: string }): Promise<void> {
    const actor = await this.requireAdministrator(input.workspaceId, input.actorMemberId);
    if (actor.role !== "owner") throw new Error("only an owner may transfer ownership");
    const target = await this.memberRow(input.workspaceId, input.targetMemberId);
    if (target.status !== "active") throw new Error("ownership target must be active");
    const local = await this.workspaces.get(this.workspaces.idFromString(target.durableObjectId)).getMember(target.memberId);
    if (!local) throw new Error("workspace membership projection not found");
    if (input.confirmation !== ownershipTransferConfirmation(local.handle)) throw new Error("ownership transfer confirmation did not match");
    await this.changeMemberProjection(input.workspaceId, target.memberId, "owner", "active");
    if (actor.memberId !== target.memberId) await this.changeMemberProjection(input.workspaceId, actor.memberId, "admin", "active");
  }

  async changeMemberRole(workspaceId: string, memberId: string, role: WorkspaceRole): Promise<void> {
    const current = await this.memberRow(workspaceId, memberId);
    await this.changeMemberProjection(workspaceId, memberId, role, current.status);
  }

  private async changeMemberProjection(workspaceId: string, memberId: string, role: WorkspaceRole, status: MemberStatus): Promise<void> {
    const now = this.now();
    const current = await this.memberRow(workspaceId, memberId);
    const workspace = this.workspaces.get(this.workspaces.idFromString(current.durableObjectId));
    const local = await workspace.getMember(memberId);
    if (!local) throw new Error("workspace membership projection not found");
    const version = current.membershipVersion + 1;
    const operationId = crypto.randomUUID();
    const member = { operationId, memberId, accountId: current.accountId, handle: local.handle, displayName: current.displayName, role, status, authorizationEpoch: current.authorizationEpoch + 1, version, now };
    const operation = this.db.prepare("INSERT INTO control_operations(id, workspace_id, kind, aggregate_id, version, payload_json, next_attempt_at, created_at) VALUES (?, ?, 'membership_upsert', ?, ?, ?, ?, ?)").bind(operationId, workspaceId, memberId, version, JSON.stringify(member), now, now);
    const workspaceVersion = this.db.prepare("UPDATE workspaces SET membership_version = ?, updated_at = ? WHERE id = ?").bind(version, now, workspaceId);
    const update = this.db.prepare("UPDATE memberships SET role = ?, status = ?, version = ?, authorization_epoch = ?, updated_at = ? WHERE workspace_id = ? AND member_id = ?").bind(role, status, version, member.authorizationEpoch, now, workspaceId, memberId);
    const isReduction = status !== "active" || roleRank(role) > roleRank(current.role);
    await this.db.batch(isReduction ? [workspaceVersion, operation, update] : [workspaceVersion, operation]);
    await workspace.applyMembership(member);
    await this.db.batch([...(isReduction ? [] : [update]), this.db.prepare("UPDATE control_operations SET status = 'applied', applied_at = ? WHERE id = ?").bind(now, operationId)]);
  }

  private async requireAdministrator(workspaceId: string, memberId: string): Promise<{ memberId: string; role: WorkspaceRole }> {
    const row = await this.db.prepare("SELECT member_id, role FROM memberships WHERE workspace_id = ? AND member_id = ? AND status = 'active'").bind(workspaceId, memberId).first<{ member_id: string; role: WorkspaceRole }>();
    if (!row || (row.role !== "owner" && row.role !== "admin")) throw new Error("active owner or admin required");
    return { memberId: row.member_id, role: row.role };
  }

  private async seatCapacity(workspaceId: string): Promise<{ activeSeats: number; readyInvitations: number; seatQuantity: number }> {
    const row = await this.db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM memberships WHERE workspace_id = ? AND status = 'active') AS active_seats,
         (SELECT COUNT(*) FROM invitations WHERE workspace_id = ? AND delivery_state = 'ready'
            AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?) AS ready_invitations,
         (SELECT seat_quantity FROM subscriptions WHERE workspace_id = ?) AS seat_quantity`,
    ).bind(workspaceId, workspaceId, this.now(), workspaceId).first<{
      active_seats: number; ready_invitations: number; seat_quantity: number | null;
    }>();
    if (!row || row.seat_quantity === null) throw new Error("workspace entitlement not found");
    return { activeSeats: row.active_seats, readyInvitations: row.ready_invitations, seatQuantity: row.seat_quantity };
  }

  private async memberRow(workspaceId: string, memberId: string): Promise<{ memberId: string; accountId: string; displayName: string; role: WorkspaceRole; status: MemberStatus; authorizationEpoch: number; membershipVersion: number; durableObjectId: string }> {
    const row = await this.db.prepare(
      `SELECT m.member_id, m.account_id, a.display_name, m.role, m.status, m.authorization_epoch, w.membership_version, w.durable_object_id
       FROM memberships m JOIN accounts a ON a.id = m.account_id JOIN workspaces w ON w.id = m.workspace_id WHERE m.workspace_id = ? AND m.member_id = ?`,
    ).bind(workspaceId, memberId).first<{ member_id: string; account_id: string; display_name: string; role: WorkspaceRole; status: MemberStatus; authorization_epoch: number; membership_version: number; durable_object_id: string }>();
    if (!row) throw new Error("membership not found");
    return { memberId: row.member_id, accountId: row.account_id, displayName: row.display_name, role: row.role, status: row.status, authorizationEpoch: row.authorization_epoch, membershipVersion: row.membership_version, durableObjectId: row.durable_object_id };
  }
}

function roleRank(role: WorkspaceRole): number {
  return role === "owner" ? 0 : role === "admin" ? 1 : role === "member" ? 2 : 3;
}
