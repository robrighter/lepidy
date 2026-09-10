import { describe, expect, it } from "vitest";

import { deriveEntitlement, entitlementForHumanCount, hasSeatAvailable, parseSeatQuantity, storagePackCountFromGb } from "./entitlements";

describe("seat and storage entitlements", () => {
  it.each([
    [1, 0, 1], [2, 1_900, 5], [5, 1_900, 5], [6, 2_300, 6],
    [20, 7_900, 20], [21, 8_300, 21], [50, 19_900, 50],
  ] as const)("B01-RULE-001 prices %i active humans deterministically", (humans, cents, seats) => {
    expect(entitlementForHumanCount(humans)).toMatchObject({ monthlyPriceCents: cents, seatQuantity: seats });
  });

  it("B01-RULE-002 enforces plan boundaries and whole 100 GB packs", () => {
    expect(() => parseSeatQuantity("solo", 2)).toThrow("exactly one");
    expect(() => parseSeatQuantity("team", 2)).toThrow("5-50");
    expect(() => parseSeatQuantity("team", 4)).toThrow("5-50");
    expect(() => parseSeatQuantity("team", 51)).toThrow("5-50");
    expect(storagePackCountFromGb(200)).toBe(2);
    expect(() => storagePackCountFromGb(50)).toThrow("100 GB");
  });

  it("B01-RULE-003 reserves seats for invitations that can actually be accepted", () => {
    expect(hasSeatAvailable({ seatQuantity: 5, activeHumans: 4, readyInvitations: 0 })).toBe(true);
    expect(hasSeatAvailable({ seatQuantity: 5, activeHumans: 4, readyInvitations: 1 })).toBe(false);
  });

  it("B01-RULE-004 makes a lapsed entitlement read-only without deleting its allowance", () => {
    const active = deriveEntitlement({ plan: "team", status: "active", seatQuantity: 6, storagePackGb: 100 });
    const lapsed = deriveEntitlement({ plan: "team", status: "canceled", seatQuantity: 6, storagePackGb: 100 });
    expect(lapsed).toMatchObject({ writable: false, storageQuotaBytes: active.storageQuotaBytes, seatQuantity: 6 });
  });
});
