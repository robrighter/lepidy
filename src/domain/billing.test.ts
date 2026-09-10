import { describe, expect, it } from "vitest";
import { purchaseRail, seatChange, stripeEntitlement } from "./billing";

describe("billing rules", () => {
  it("B02-RULE-001 keeps store policy explicit", () => {
    expect(purchaseRail("web")).toBe("stripe");
    expect(purchaseRail("direct")).toBe("stripe");
    expect(purchaseRail("microsoft_store")).toBe("stripe");
    expect(purchaseRail("mac_app_store")).toBe("web_only");
  });

  it("B02-RULE-002 charges additions now and schedules removals", () => {
    expect(seatChange(5, 6)).toEqual({ direction: "increase", prorationBehavior: "always_invoice", effective: "immediate" });
    expect(seatChange(6, 5)).toEqual({ direction: "decrease", prorationBehavior: "none", effective: "period_end" });
  });

  it("B02-RULE-003 maps every provider lapse to the same entitlement states", () => {
    const base = { id: "sub_test", metadata: { lepidy_workspace_id: "workspace", lepidy_plan: "team", lepidy_seats: "5", lepidy_storage_pack_gb: "100" }, current_period_end: 1_900_000_000 };
    expect(stripeEntitlement({ ...base, status: "active" }, 10).status).toBe("active");
    expect(stripeEntitlement({ ...base, status: "past_due" }, 11).status).toBe("past_due");
    expect(stripeEntitlement({ ...base, status: "active" }, 12, true).status).toBe("canceled");
  });
});
