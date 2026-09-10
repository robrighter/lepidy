import { billingDirection, billingSelection, requireDowngradeFits, type BillingSelection } from "../domain/billing-management";
import { deriveEntitlement, type EntitlementStatus, type WorkspacePlan } from "../domain/entitlements";

export type BillingInvoice = { id: string; amountDueCents: number; currency: string; status: string; hostedUrl: string | null; issuedAt: number };
export type BillingSnapshot = {
  role: string; plan: WorkspacePlan; status: EntitlementStatus; seats: number; storagePacks: number;
  monthlyPriceCents: number; currentPeriodEnd: number | null; cancelAtPeriodEnd: boolean;
  activeHumans: number; readyInvitations: number; usedStorageBytes: number; invoices: BillingInvoice[];
};
export type PendingBillingRequest = { id: string; plan: WorkspacePlan; seats: number; storagePacks: number; monthlyPriceCents: number; direction: string; expiresAt: number };

export class BillingManagementService {
  constructor(private readonly db: D1Database, private readonly now: () => number = () => Date.now()) {}

  async snapshot(workspaceId: string, memberId: string): Promise<BillingSnapshot> {
    const row = await this.db.prepare(
      `SELECT m.role, s.plan, s.status, s.seat_quantity, s.storage_pack_gb, s.current_period_end, s.cancel_at_period_end,
        (SELECT COUNT(*) FROM memberships WHERE workspace_id = ? AND status = 'active') active_humans,
        (SELECT COUNT(*) FROM invitations WHERE workspace_id = ? AND delivery_state = 'ready' AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?) ready_invitations
       FROM memberships m JOIN subscriptions s ON s.workspace_id = m.workspace_id
       WHERE m.workspace_id = ? AND m.member_id = ? AND m.status = 'active'`,
    ).bind(workspaceId, workspaceId, this.now(), workspaceId, memberId).first<{
      role: string; plan: WorkspacePlan; status: EntitlementStatus; seat_quantity: number; storage_pack_gb: number;
      current_period_end: number | null; cancel_at_period_end: number; active_humans: number; ready_invitations: number;
    }>();
    if (!row) throw new Error("active workspace membership required");
    const entitlement = deriveEntitlement({ plan: row.plan, status: row.status, seatQuantity: row.seat_quantity, storagePackGb: row.storage_pack_gb });
    const invoices = await this.db.prepare("SELECT external_id, amount_due_cents, currency, status, hosted_url, issued_at FROM billing_invoices WHERE workspace_id = ? ORDER BY issued_at DESC LIMIT 24")
      .bind(workspaceId).all<{ external_id: string; amount_due_cents: number; currency: string; status: string; hosted_url: string | null; issued_at: number }>();
    return {
      role: row.role, plan: row.plan, status: row.status, seats: row.seat_quantity,
      storagePacks: entitlement.storagePackCount, monthlyPriceCents: entitlement.monthlyPriceCents,
      currentPeriodEnd: row.current_period_end, cancelAtPeriodEnd: row.cancel_at_period_end === 1,
      activeHumans: row.active_humans, readyInvitations: row.ready_invitations, usedStorageBytes: 0,
      invoices: invoices.results.map((invoice) => ({ id: invoice.external_id, amountDueCents: invoice.amount_due_cents, currency: invoice.currency, status: invoice.status, hostedUrl: invoice.hosted_url, issuedAt: invoice.issued_at })),
    };
  }

  async requestChange(input: { workspaceId: string; memberId: string; plan: string; seats: number; storagePacks: number; usedStorageBytes?: number }): Promise<{ id: string; selection: BillingSelection; direction: string; monthlyPriceCents: number }> {
    const current = await this.snapshot(input.workspaceId, input.memberId);
    current.usedStorageBytes = input.usedStorageBytes ?? 0;
    if (current.role !== "owner" && current.role !== "admin") throw new Error("an owner or admin must manage billing");
    const selection = billingSelection(input);
    const direction = billingDirection(current, selection);
    if (direction === "same") throw new Error("this is already the workspace plan");
    if (direction === "decrease") {
      const next = deriveEntitlement({ plan: selection.plan, status: "active", seatQuantity: selection.seats, storagePackGb: selection.storagePacks * 100 });
      requireDowngradeFits({ requestedSeats: selection.seats, activeHumans: current.activeHumans, readyInvitations: current.readyInvitations, usedStorageBytes: current.usedStorageBytes, requestedStorageBytes: next.storageQuotaBytes });
    }
    const entitlement = deriveEntitlement({ plan: selection.plan, status: "active", seatQuantity: selection.seats, storagePackGb: selection.storagePacks * 100 });
    const id = crypto.randomUUID();
    const now = this.now();
    await this.db.batch([
      this.db.prepare("UPDATE billing_change_requests SET status = 'superseded' WHERE workspace_id = ? AND status = 'pending_checkout'").bind(input.workspaceId),
      this.db.prepare(`INSERT INTO billing_change_requests(id, workspace_id, requested_by_member_id, plan, seat_quantity, storage_pack_gb, monthly_price_cents, direction, status, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_checkout', ?, ?)`)
        .bind(id, input.workspaceId, input.memberId, selection.plan, selection.seats, selection.storagePacks * 100, entitlement.monthlyPriceCents, direction, now, now + 30 * 60_000),
    ]);
    return { id, selection, direction, monthlyPriceCents: entitlement.monthlyPriceCents };
  }

  async pendingRequest(workspaceId: string, memberId: string, id: string): Promise<PendingBillingRequest | null> {
    const snapshot = await this.snapshot(workspaceId, memberId);
    if (snapshot.role !== "owner" && snapshot.role !== "admin") return null;
    const row = await this.db.prepare(`SELECT id, plan, seat_quantity, storage_pack_gb, monthly_price_cents, direction, expires_at
      FROM billing_change_requests WHERE id = ? AND workspace_id = ? AND status = 'pending_checkout' AND expires_at > ?`)
      .bind(id, workspaceId, this.now()).first<{ id: string; plan: WorkspacePlan; seat_quantity: number; storage_pack_gb: number; monthly_price_cents: number; direction: string; expires_at: number }>();
    return row ? { id: row.id, plan: row.plan, seats: row.seat_quantity, storagePacks: row.storage_pack_gb / 100, monthlyPriceCents: row.monthly_price_cents, direction: row.direction, expiresAt: row.expires_at } : null;
  }

  async markSubmitted(workspaceId: string, id: string, providerSessionId: string): Promise<void> {
    const result = await this.db.prepare("UPDATE billing_change_requests SET status = 'submitted', provider_session_id = ? WHERE id = ? AND workspace_id = ? AND status = 'pending_checkout' AND expires_at > ?")
      .bind(providerSessionId, id, workspaceId, this.now()).run();
    if (result.meta.changes !== 1) throw new Error("billing request expired; review the change again");
  }
}
