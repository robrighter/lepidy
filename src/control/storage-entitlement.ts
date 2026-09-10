import type { Workspace } from "../cloudflare/workspace";
import { deriveEntitlement, type EntitlementStatus, type WorkspacePlan } from "../domain/entitlements";

/**
 * Mirrors the storage allowance from D1 into the workspace object.
 *
 * The allowance is a commercial fact and D1 owns it; the object needs it to
 * answer an upload without a cross-database read. This is the same shape as
 * membership projection — versioned, idempotent, and safe to run again — so a
 * late projection cannot undo a newer one.
 *
 * A Solo workspace gets no cloud allowance at all, because its attachments
 * live on its designated host under that host's own local quota.
 */
export class StorageEntitlementService {
  constructor(
    private readonly db: D1Database,
    private readonly workspaces: DurableObjectNamespace<Workspace>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async project(workspaceId: string): Promise<{ quotaBytes: number; applied: boolean }> {
    const row = await this.db.prepare(
      `SELECT w.durable_object_id, s.plan, s.status, s.seat_quantity, s.storage_pack_gb,
              s.updated_at AS subscription_updated_at
       FROM workspaces w JOIN subscriptions s ON s.workspace_id = w.id
       WHERE w.id = ?`,
    ).bind(workspaceId).first<{
      durable_object_id: string; plan: WorkspacePlan; status: EntitlementStatus;
      seat_quantity: number; storage_pack_gb: number; subscription_updated_at: number;
    }>();
    if (!row) throw new Error("workspace entitlement not found");

    const quotaBytes = deriveEntitlement({
      plan: row.plan, status: row.status, seatQuantity: row.seat_quantity, storagePackGb: row.storage_pack_gb,
    }).storageQuotaBytes;

    // The version is the newer of the two rows the allowance is derived from,
    // so any change that could move the number also moves the version.
    const version = Math.max(row.subscription_updated_at, 1);
    const stub = this.workspaces.get(this.workspaces.idFromString(row.durable_object_id));
    const { applied } = await stub.applyStorageEntitlement({ quotaBytes, version, now: this.now() });
    return { quotaBytes, applied };
  }
}
