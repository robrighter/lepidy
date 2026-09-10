import { teamStorageQuotaBytes } from "./files";

export type WorkspacePlan = "solo" | "team";
export type EntitlementStatus = "active" | "past_due" | "canceled";

export const SOLO_INCLUDED_SEATS = 1;
export const TEAM_INCLUDED_SEATS = 5;
export const TEAM_MAX_SEATS = 50;
export const TEAM_BASE_MONTHLY_CENTS = 1_900;
export const TEAM_EXTRA_SEAT_MONTHLY_CENTS = 400;
export const STORAGE_PACK_GB = 100;
export const STORAGE_PACK_MONTHLY_CENTS = 500;

export type Entitlement = {
  plan: WorkspacePlan;
  status: EntitlementStatus;
  seatQuantity: number;
  storagePackCount: number;
  storageQuotaBytes: number;
  monthlyPriceCents: number;
  writable: boolean;
};

export function parseSeatQuantity(plan: WorkspacePlan, raw: number): number {
  if (!Number.isSafeInteger(raw)) throw new Error("seat quantity must be a whole number");
  if (plan === "solo" && raw !== SOLO_INCLUDED_SEATS) throw new Error("Solo includes exactly one human seat");
  if (plan === "team" && (raw < TEAM_INCLUDED_SEATS || raw > TEAM_MAX_SEATS)) {
    throw new Error("Team supports 5-50 human seats");
  }
  return raw;
}

export function storagePackCountFromGb(raw: number): number {
  if (!Number.isSafeInteger(raw) || raw < 0 || raw % STORAGE_PACK_GB !== 0) {
    throw new Error("storage packs must be purchased in 100 GB units");
  }
  return raw / STORAGE_PACK_GB;
}

export function deriveEntitlement(input: {
  plan: WorkspacePlan;
  status: EntitlementStatus;
  seatQuantity: number;
  storagePackGb: number;
}): Entitlement {
  const seatQuantity = parseSeatQuantity(input.plan, input.seatQuantity);
  const storagePackCount = storagePackCountFromGb(input.storagePackGb);
  const team = input.plan === "team";
  return {
    plan: input.plan,
    status: input.status,
    seatQuantity,
    storagePackCount,
    storageQuotaBytes: team ? teamStorageQuotaBytes({ seatQuantity, storagePackCount }) : 0,
    monthlyPriceCents: team
      ? TEAM_BASE_MONTHLY_CENTS
        + Math.max(0, seatQuantity - TEAM_INCLUDED_SEATS) * TEAM_EXTRA_SEAT_MONTHLY_CENTS
        + storagePackCount * STORAGE_PACK_MONTHLY_CENTS
      : 0,
    writable: input.status === "active",
  };
}

/** Minimum purchasable capacity for a workspace with this many active humans. */
export function entitlementForHumanCount(activeHumans: number): Entitlement {
  if (!Number.isSafeInteger(activeHumans) || activeHumans < 1 || activeHumans > TEAM_MAX_SEATS) {
    throw new Error("a workspace supports 1-50 active humans");
  }
  const plan: WorkspacePlan = activeHumans === 1 ? "solo" : "team";
  const seatQuantity = plan === "solo" ? 1 : Math.max(TEAM_INCLUDED_SEATS, activeHumans);
  return deriveEntitlement({ plan, status: "active", seatQuantity, storagePackGb: 0 });
}

export function hasSeatAvailable(input: { seatQuantity: number; activeHumans: number; readyInvitations: number }): boolean {
  for (const value of [input.seatQuantity, input.activeHumans, input.readyInvitations]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("seat counts must be non-negative whole numbers");
  }
  return input.activeHumans + input.readyInvitations < input.seatQuantity;
}
