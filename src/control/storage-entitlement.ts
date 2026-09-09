import type { Workspace } from "../cloudflare/workspace";
import { teamStorageQuotaBytes, STORAGE_PACK_BYTES } from "../domain/files";

const GB = 1024 * 1024 * 1024;

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
      `SELECT w.plan, w.durable_object_id, w.updated_at AS workspace_updated_at,
              s.seat_quantity, s.storage_pack_gb, s.updated_at AS subscription_updated_at
       FROM workspaces w LEFT JOIN subscriptions s ON s.workspace_id = w.id
       WHERE w.id = ?`,
    ).bind(workspaceId).first<{
      plan: "solo" | "team"; durable_object_id: string; workspace_updated_at: number;
      seat_quantity: number | null; storage_pack_gb: number | null; subscription_updated_at: number | null;
    }>();
    if (!row) throw new Error("workspace not found");

    const quotaBytes = row.plan === "team"
      ? teamStorageQuotaBytes({
          seatQuantity: row.seat_quantity ?? 5,
          // Packs are sold in 100 GB units and stored as gigabytes.
          storagePackCount: Math.floor(((row.storage_pack_gb ?? 0) * GB) / STORAGE_PACK_BYTES),
        })
      : 0;

    // The version is the newer of the two rows the allowance is derived from,
    // so any change that could move the number also moves the version.
    const version = Math.max(row.workspace_updated_at, row.subscription_updated_at ?? 0, 1);
    const stub = this.workspaces.get(this.workspaces.idFromString(row.durable_object_id));
    const { applied } = await stub.applyStorageEntitlement({ quotaBytes, version, now: this.now() });
    return { quotaBytes, applied };
  }
}
