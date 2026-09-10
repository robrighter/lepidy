import { parseSeatQuantity, storagePackCountFromGb, type EntitlementStatus, type WorkspacePlan } from "./entitlements";

export type DistributionChannel = "web" | "direct" | "mac_app_store" | "microsoft_store";
export type BillingSource = "stripe" | "apple" | "microsoft";

export function purchaseRail(channel: DistributionChannel): BillingSource | "web_only" {
  if (channel === "mac_app_store") return "web_only";
  return "stripe";
}

export type ProviderEntitlement = {
  workspaceId: string;
  externalId: string;
  plan: WorkspacePlan;
  status: EntitlementStatus;
  seats: number;
  storagePackGb: number;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  providerVersion: number;
};

type StripeSubscription = {
  id?: unknown;
  status?: unknown;
  cancel_at_period_end?: unknown;
  current_period_end?: unknown;
  metadata?: unknown;
  items?: { data?: unknown };
};

function metadata(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") throw new Error("billing metadata is required");
  return value as Record<string, string>;
}

function status(value: unknown, deleted: boolean): EntitlementStatus {
  if (deleted || value === "canceled" || value === "unpaid" || value === "incomplete_expired") return "canceled";
  if (value === "active" || value === "trialing") return "active";
  return "past_due";
}

export function stripeEntitlement(object: StripeSubscription, eventCreated: number, deleted = false): ProviderEntitlement {
  if (typeof object.id !== "string" || !object.id.startsWith("sub_")) throw new Error("invalid Stripe subscription");
  const meta = metadata(object.metadata);
  if (!meta.lepidy_workspace_id) throw new Error("Stripe subscription is not bound to a workspace");
  const plan = meta.lepidy_plan;
  if (plan !== "solo" && plan !== "team") throw new Error("invalid entitlement plan");
  const seats = parseSeatQuantity(plan, Number(meta.lepidy_seats));
  const storagePackGb = Number(meta.lepidy_storage_pack_gb ?? "0");
  storagePackCountFromGb(storagePackGb);
  const period = object.current_period_end;
  if (period !== undefined && period !== null && (!Number.isInteger(period) || Number(period) <= 0)) throw new Error("invalid billing period end");
  return {
    workspaceId: meta.lepidy_workspace_id,
    externalId: object.id,
    plan,
    status: status(object.status, deleted),
    seats,
    storagePackGb,
    currentPeriodEnd: period == null ? null : Number(period) * 1000,
    cancelAtPeriodEnd: object.cancel_at_period_end === true,
    providerVersion: eventCreated * 1000,
  };
}

export type SeatChange = { direction: "increase" | "decrease" | "same"; prorationBehavior: "always_invoice" | "none"; effective: "immediate" | "period_end" };

export function seatChange(current: number, requested: number): SeatChange {
  if (!Number.isInteger(current) || !Number.isInteger(requested) || current < 1 || requested < 1) throw new Error("seat quantities must be positive integers");
  if (requested > current) return { direction: "increase", prorationBehavior: "always_invoice", effective: "immediate" };
  if (requested < current) return { direction: "decrease", prorationBehavior: "none", effective: "period_end" };
  return { direction: "same", prorationBehavior: "none", effective: "immediate" };
}
