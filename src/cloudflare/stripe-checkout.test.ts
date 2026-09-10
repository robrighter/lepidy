import { describe, expect, it, vi } from "vitest";
import { createStripeCheckout } from "./stripe-checkout";

const request = { id: "request-1", plan: "team" as const, seats: 6, storagePacks: 2, monthlyPriceCents: 3300, direction: "increase", expiresAt: Date.now() + 1_000 };

describe("Stripe checkout boundary", () => {
  it("fails closed before network access without a complete test catalogue", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(createStripeCheckout({ config: {}, request, workspaceId: "workspace-1", origin: "https://lepidy.test", fetcher })).rejects.toThrow("not configured");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends exact quantities and authority metadata to test-mode checkout", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: "cs_test_one", url: "https://checkout.stripe.com/c/pay/cs_test_one" }));
    const result = await createStripeCheckout({ config: { secretKey: "sk_test_secret", teamPriceId: "price_team", extraSeatPriceId: "price_seat", storagePackPriceId: "price_storage" }, request, workspaceId: "workspace-1", origin: "https://lepidy.test", fetcher });
    expect(result.id).toBe("cs_test_one");
    const init = fetcher.mock.calls[0]![1]!;
    const body = init.body as URLSearchParams;
    expect(body.get("line_items[1][quantity]")).toBe("1");
    expect(body.get("line_items[2][quantity]")).toBe("2");
    expect(body.get("subscription_data[metadata][lepidy_workspace_id]")).toBe("workspace-1");
    expect(body.get("subscription_data[metadata][lepidy_seats]")).toBe("6");
  });
});
