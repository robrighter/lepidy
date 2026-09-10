import { describe, expect, it } from "vitest";
import { billingDirection, billingSelection, formatMoney, requireDowngradeFits } from "./billing-management";

describe("billing management rules", () => {
  it("prices only valid catalogue selections", () => {
    expect(billingSelection({ plan: "solo", seats: 50, storagePacks: 0 })).toEqual({ plan: "solo", seats: 1, storagePacks: 0 });
    expect(billingSelection({ plan: "team", seats: 6, storagePacks: 2 })).toEqual({ plan: "team", seats: 6, storagePacks: 2 });
    expect(() => billingSelection({ plan: "team", seats: 51, storagePacks: 0 })).toThrow("5–50");
    expect(() => billingSelection({ plan: "team", seats: 5, storagePacks: 0.5 })).toThrow("whole number");
  });

  it("distinguishes restoration from an ordinary plan change", () => {
    expect(billingDirection({ plan: "team", status: "past_due", seats: 5, storagePacks: 0 }, { plan: "team", seats: 5, storagePacks: 0 })).toBe("restore");
    expect(billingDirection({ plan: "solo", status: "active", seats: 1, storagePacks: 0 }, { plan: "team", seats: 5, storagePacks: 0 })).toBe("increase");
  });

  it("formats invoice amounts", () => expect(formatMoney(2400)).toBe("$24.00"));

  it("never silently evicts a person, invitation or stored byte", () => {
    expect(() => requireDowngradeFits({ requestedSeats: 5, activeHumans: 5, readyInvitations: 1, usedStorageBytes: 0, requestedStorageBytes: 25 })).toThrow("6 are reserved");
    expect(() => requireDowngradeFits({ requestedSeats: 5, activeHumans: 5, readyInvitations: 0, usedStorageBytes: 26, requestedStorageBytes: 25 })).toThrow("remove stored files");
  });
});
