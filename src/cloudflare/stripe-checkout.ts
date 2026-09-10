import type { PendingBillingRequest } from "../control/billing-management";

export type StripeCheckoutConfig = { secretKey?: string; teamPriceId?: string; extraSeatPriceId?: string; storagePackPriceId?: string };

export async function createStripeCheckout(input: { config: StripeCheckoutConfig; request: PendingBillingRequest; workspaceId: string; origin: string; fetcher?: typeof fetch }): Promise<{ id: string; url: string }> {
  const { secretKey, teamPriceId, extraSeatPriceId, storagePackPriceId } = input.config;
  if (!secretKey?.startsWith("sk_test_") || !teamPriceId?.startsWith("price_")) throw new Error("secure checkout is not configured for this deployment");
  const body = new URLSearchParams({
    mode: "subscription", success_url: `${input.origin}/billing?notice=${encodeURIComponent("Checkout received. Access updates after payment confirmation.")}`,
    cancel_url: `${input.origin}/billing?notice=${encodeURIComponent("Checkout canceled; nothing changed.")}`, client_reference_id: input.workspaceId,
    "metadata[lepidy_billing_request_id]": input.request.id, "subscription_data[metadata][lepidy_workspace_id]": input.workspaceId,
    "subscription_data[metadata][lepidy_plan]": input.request.plan, "subscription_data[metadata][lepidy_seats]": String(input.request.seats),
    "subscription_data[metadata][lepidy_storage_pack_gb]": String(input.request.storagePacks * 100),
  });
  let index = 0;
  if (input.request.plan === "team") { body.set(`line_items[${index}][price]`, teamPriceId); body.set(`line_items[${index}][quantity]`, "1"); index += 1; }
  if (input.request.seats > 5) {
    if (!extraSeatPriceId?.startsWith("price_")) throw new Error("extra-seat checkout is not configured");
    body.set(`line_items[${index}][price]`, extraSeatPriceId); body.set(`line_items[${index}][quantity]`, String(input.request.seats - 5)); index += 1;
  }
  if (input.request.storagePacks > 0) {
    if (!storagePackPriceId?.startsWith("price_")) throw new Error("storage checkout is not configured");
    body.set(`line_items[${index}][price]`, storagePackPriceId); body.set(`line_items[${index}][quantity]`, String(input.request.storagePacks));
  }
  const response = await (input.fetcher ?? fetch)("https://api.stripe.com/v1/checkout/sessions", { method: "POST", headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/x-www-form-urlencoded" }, body });
  const value = await response.json() as { id?: string; url?: string; error?: { message?: string } };
  if (!response.ok || !value.id?.startsWith("cs_test_") || !value.url?.startsWith("https://checkout.stripe.com/")) throw new Error(value.error?.message ?? "secure checkout could not be started");
  return { id: value.id, url: value.url };
}
