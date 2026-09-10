import {
  deriveEntitlement,
  SOLO_INCLUDED_SEATS,
  STORAGE_PACK_GB,
  TEAM_INCLUDED_SEATS,
  TEAM_MAX_SEATS,
  type EntitlementStatus,
  type WorkspacePlan,
} from "./entitlements";

export type BillingSelection = { plan: WorkspacePlan; seats: number; storagePacks: number };

export function billingSelection(input: { plan: string; seats: number; storagePacks: number }): BillingSelection {
  if (input.plan !== "solo" && input.plan !== "team") throw new Error("choose Solo or Team");
  if (!Number.isSafeInteger(input.storagePacks) || input.storagePacks < 0 || input.storagePacks > 100) throw new Error("storage packs must be a whole number");
  const seats = input.plan === "solo" ? SOLO_INCLUDED_SEATS : input.seats;
  if (!Number.isSafeInteger(seats) || (input.plan === "team" && (seats < TEAM_INCLUDED_SEATS || seats > TEAM_MAX_SEATS))) {
    throw new Error("Team supports 5–50 seats");
  }
  deriveEntitlement({ plan: input.plan, status: "active", seatQuantity: seats, storagePackGb: input.storagePacks * STORAGE_PACK_GB });
  return { plan: input.plan, seats, storagePacks: input.storagePacks };
}

export function billingDirection(current: { plan: WorkspacePlan; status: EntitlementStatus; seats: number; storagePacks: number }, next: BillingSelection) {
  if (current.status !== "active") return "restore" as const;
  const currentRank = (current.plan === "team" ? 1_000 : 0) + current.seats * 10 + current.storagePacks;
  const nextRank = (next.plan === "team" ? 1_000 : 0) + next.seats * 10 + next.storagePacks;
  return nextRank > currentRank ? "increase" as const : nextRank < currentRank ? "decrease" as const : "same" as const;
}

export function formatMoney(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(cents / 100);
}

export function requireDowngradeFits(input: { requestedSeats: number; activeHumans: number; readyInvitations: number; usedStorageBytes: number; requestedStorageBytes: number }): void {
  const occupied = input.activeHumans + input.readyInvitations;
  if (input.requestedSeats < occupied) throw new Error(`deactivate people or cancel invitations until ${input.requestedSeats} seats are enough; ${occupied} are reserved now`);
  if (input.usedStorageBytes > input.requestedStorageBytes) throw new Error("remove stored files before lowering storage capacity");
}
