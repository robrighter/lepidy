import type { BillingSource, ProviderEntitlement } from "../domain/billing";

export type BillingEvent = {
  id: string;
  type: string;
  created: number;
  entitlement?: ProviderEntitlement;
};

export class BillingReconciliationService {
  constructor(private readonly db: D1Database, private readonly now: () => number = () => Date.now()) {}

  async accept(source: BillingSource, event: BillingEvent): Promise<"applied" | "duplicate" | "stale" | "ignored"> {
    if (!/^evt_[A-Za-z0-9_]+$/.test(event.id) || !Number.isInteger(event.created) || event.created <= 0) throw new Error("invalid billing event");
    const existing = await this.db.prepare("SELECT disposition FROM billing_event_receipts WHERE source = ? AND event_id = ?")
      .bind(source, event.id).first<{ disposition: "applied" | "stale" | "ignored" | "failed" }>();
    if (existing) return "duplicate";
    const receivedAt = this.now();
    if (!event.entitlement) {
      await this.receipt(source, event, null, "ignored", receivedAt);
      return "ignored";
    }
    const entitlement = event.entitlement;
    const current = await this.db.prepare("SELECT provider_version FROM subscriptions WHERE workspace_id = ?")
      .bind(entitlement.workspaceId).first<{ provider_version: number }>();
    if (!current) throw new Error("workspace entitlement not found");
    if (entitlement.providerVersion < current.provider_version) {
      await this.receipt(source, event, entitlement.workspaceId, "stale", receivedAt);
      return "stale";
    }
    try {
      await this.db.batch([
      this.db.prepare(
        `UPDATE subscriptions SET provider = ?, source = ?, provider_subscription_id = ?, external_id = ?,
          plan = ?, status = ?, seat_quantity = ?, storage_pack_gb = ?, current_period_end = ?,
          cancel_at_period_end = ?, provider_version = ?, updated_at = ?
         WHERE workspace_id = ? AND provider_version < ?`,
      ).bind(source, source, entitlement.externalId, entitlement.externalId, entitlement.plan, entitlement.status,
        entitlement.seats, entitlement.storagePackGb, entitlement.currentPeriodEnd,
        entitlement.cancelAtPeriodEnd ? 1 : 0, entitlement.providerVersion, receivedAt,
        entitlement.workspaceId, entitlement.providerVersion),
      this.db.prepare(
        `INSERT INTO billing_event_receipts(source, event_id, event_created_at, event_type, workspace_id,
          received_at, applied_at, disposition) VALUES (?, ?, ?, ?, ?, ?, ?, 'applied')`,
      ).bind(source, event.id, event.created, event.type, entitlement.workspaceId, receivedAt, receivedAt),
      this.db.prepare(
        `INSERT INTO billing_reconciliation_jobs(workspace_id, source, external_id, attempts, next_attempt_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET source = excluded.source,
         external_id = excluded.external_id, attempts = 0, next_attempt_at = excluded.next_attempt_at,
         last_error = NULL, updated_at = excluded.updated_at`,
      ).bind(entitlement.workspaceId, source, entitlement.externalId, receivedAt + 24 * 60 * 60_000, receivedAt),
      ]);
    } catch (error) {
      const raced = await this.db.prepare("SELECT 1 AS present FROM billing_event_receipts WHERE source = ? AND event_id = ?")
        .bind(source, event.id).first<{ present: number }>();
      if (raced) return "duplicate";
      throw error;
    }
    return "applied";
  }

  async reconcileDue(read: (job: { source: BillingSource; externalId: string; workspaceId: string }) => Promise<BillingEvent>, limit = 25): Promise<{ applied: number; failed: number }> {
    const now = this.now();
    const jobs = await this.db.prepare(
      "SELECT workspace_id, source, external_id, attempts FROM billing_reconciliation_jobs WHERE next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?",
    ).bind(now, Math.max(1, Math.min(limit, 100))).all<{ workspace_id: string; source: BillingSource; external_id: string; attempts: number }>();
    let applied = 0;
    let failed = 0;
    for (const job of jobs.results) {
      try {
        const event = await read({ source: job.source, externalId: job.external_id, workspaceId: job.workspace_id });
        await this.accept(job.source, event);
        await this.db.prepare("UPDATE billing_reconciliation_jobs SET attempts = 0, last_error = NULL, next_attempt_at = ?, updated_at = ? WHERE workspace_id = ?")
          .bind(now + 24 * 60 * 60_000, now, job.workspace_id).run();
        applied += 1;
      } catch (error) {
        const attempts = job.attempts + 1;
        const delay = Math.min(2 ** attempts * 60_000, 24 * 60 * 60_000);
        await this.db.prepare("UPDATE billing_reconciliation_jobs SET attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE workspace_id = ?")
          .bind(attempts, error instanceof Error ? error.message.slice(0, 500) : "reconciliation failed", now + delay, now, job.workspace_id).run();
        failed += 1;
      }
    }
    return { applied, failed };
  }

  private async receipt(source: BillingSource, event: BillingEvent, workspaceId: string | null, disposition: "stale" | "ignored", now: number) {
    await this.db.prepare(
      `INSERT INTO billing_event_receipts(source, event_id, event_created_at, event_type, workspace_id,
       received_at, applied_at, disposition) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(source, event.id, event.created, event.type, workspaceId, now, now, disposition).run();
  }
}
