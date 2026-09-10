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

function parseEvent(rawBody: string): BillingEvent {
  const value = JSON.parse(rawBody) as { id?: unknown; type?: unknown; created?: unknown; livemode?: unknown; data?: { object?: unknown } };
  if (value.livemode !== false) throw new Error("live billing events are refused in this environment");
  if (typeof value.id !== "string" || typeof value.type !== "string" || !Number.isInteger(value.created)) throw new Error("invalid Stripe event");
  const supported = value.type === "customer.subscription.created" || value.type === "customer.subscription.updated" || value.type === "customer.subscription.deleted";
  return {
    id: value.id,
    type: value.type,
    created: Number(value.created),
    entitlement: supported ? stripeEntitlement(value.data?.object ?? {}, Number(value.created), value.type.endsWith(".deleted")) : undefined,
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
    const disposition = await new BillingReconciliationService(env.CONTROL_DB, () => now).accept("stripe", parseEvent(body));
    return Response.json({ received: true, disposition }, { headers: { "cache-control": "no-store" } });
  } catch {
    return response("Invalid signature or event", 400);
  }
}
