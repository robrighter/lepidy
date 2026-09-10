import { BillingReconciliationService, type BillingEvent } from "../control/billing";
import { stripeEntitlement } from "../domain/billing";

const MAX_BODY_BYTES = 256 * 1024;
const SIGNATURE_TOLERANCE_SECONDS = 300;

function response(message: string, status: number) {
  return new Response(message, { status, headers: { "cache-control": "no-store" } });
}

function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function equalHex(left: string, right: string) {
  if (left.length !== right.length || !/^[0-9a-f]+$/i.test(left) || !/^[0-9a-f]+$/i.test(right)) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export async function verifyStripeSignature(rawBody: string, header: string, secret: string, now = Date.now()): Promise<void> {
  if (!secret.startsWith("whsec_") || secret.length < 20) throw new Error("Stripe webhook unavailable");
  const parts = header.split(",").map((part) => part.split("=", 2));
  const timestamp = Number(parts.find(([key]) => key === "t")?.[1]);
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!Number.isInteger(timestamp) || Math.abs(Math.floor(now / 1000) - timestamp) > SIGNATURE_TOLERANCE_SECONDS || signatures.length === 0) {
    throw new Error("invalid Stripe signature");
  }
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = bytesToHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`))));
  if (!signatures.some((signature) => equalHex(signature, digest))) throw new Error("invalid Stripe signature");
}

type StripeInvoice = { id: string; workspaceId: string; amountDueCents: number; currency: string; status: "open" | "paid" | "void" | "uncollectible"; hostedUrl: string | null; issuedAt: number };

function parseEvent(rawBody: string): BillingEvent & { invoice?: StripeInvoice } {
  const value = JSON.parse(rawBody) as { id?: unknown; type?: unknown; created?: unknown; livemode?: unknown; data?: { object?: unknown } };
  if (value.livemode !== false) throw new Error("live billing events are refused in this environment");
  if (typeof value.id !== "string" || typeof value.type !== "string" || !Number.isInteger(value.created)) throw new Error("invalid Stripe event");
  const supported = value.type === "customer.subscription.created" || value.type === "customer.subscription.updated" || value.type === "customer.subscription.deleted";
  const object = value.data?.object as Record<string, unknown> | undefined;
  let invoice: StripeInvoice | undefined;
  if (value.type.startsWith("invoice.") && object && typeof object.id === "string") {
    const meta = object.metadata as Record<string, unknown> | undefined;
    const workspaceId = meta?.lepidy_workspace_id;
    const invoiceStatus = object.status;
    if (typeof workspaceId === "string" && (invoiceStatus === "open" || invoiceStatus === "paid" || invoiceStatus === "void" || invoiceStatus === "uncollectible") && Number.isSafeInteger(object.amount_due) && Number(object.amount_due) >= 0 && typeof object.currency === "string") {
      invoice = { id: object.id, workspaceId, amountDueCents: Number(object.amount_due), currency: object.currency, status: invoiceStatus, hostedUrl: typeof object.hosted_invoice_url === "string" ? object.hosted_invoice_url : null, issuedAt: Number(value.created) * 1000 };
    }
  }
  return {
    id: value.id,
    type: value.type,
    created: Number(value.created),
    entitlement: supported ? stripeEntitlement(value.data?.object ?? {}, Number(value.created), value.type.endsWith(".deleted")) : undefined,
    invoice,
  };
}

/** Exact raw callback route: signature verification happens before JSON becomes authority. */
export async function handleBillingGatewayRequest(env: CloudflareEnv, request: Request, now = Date.now()): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/hooks/stripe") return url.pathname.startsWith("/hooks/stripe/") ? response("Not found", 404) : null;
  if (request.method !== "POST") return response("Method not allowed", 405);
  if (!env.CONTROL_DB || !env.STRIPE_WEBHOOK_SECRET) return response("Unavailable", 503);
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) return response("Payload too large", 413);
  try {
    await verifyStripeSignature(body, request.headers.get("stripe-signature") ?? "", env.STRIPE_WEBHOOK_SECRET, now);
    const event = parseEvent(body);
    const disposition = await new BillingReconciliationService(env.CONTROL_DB, () => now).accept("stripe", event);
    if (event.invoice) await env.CONTROL_DB.prepare(`INSERT INTO billing_invoices(source, external_id, workspace_id, amount_due_cents, currency, status, hosted_url, issued_at)
      VALUES ('stripe', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source, external_id) DO UPDATE SET amount_due_cents = excluded.amount_due_cents,
      currency = excluded.currency, status = excluded.status, hosted_url = excluded.hosted_url, issued_at = excluded.issued_at`)
      .bind(event.invoice.id, event.invoice.workspaceId, event.invoice.amountDueCents, event.invoice.currency, event.invoice.status, event.invoice.hostedUrl, event.invoice.issuedAt).run();
    return Response.json({ received: true, disposition }, { headers: { "cache-control": "no-store" } });
  } catch {
    return response("Invalid signature or event", 400);
  }
}
