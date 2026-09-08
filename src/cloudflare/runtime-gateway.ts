import {
  decryptTransportSecret,
  unwrapAnthropicWebhook,
  type AnthropicThinEvent,
} from "../domain/cloud-custom-runtime";

type WebhookRoute = {
  durable_object_id: string;
  secret_envelope: string;
  transport_context: string;
  organization_id: string;
  provider_workspace_id: string;
};

function refusal(message: string, status: number): Response {
  return new Response(message, { status, headers: { "cache-control": "no-store" } });
}

/**
 * Own the one exact provider callback before Next can normalize or redirect it.
 * Unverified JSON is used only to select a candidate envelope; no tenant work
 * happens before the SDK authenticates the original request bytes.
 */
export async function handleRuntimeGatewayRequest(env: CloudflareEnv, request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/hooks/anthropic") {
    return url.pathname.startsWith("/hooks/anthropic/") ? refusal("Not found", 404) : null;
  }
  if (request.method !== "POST") return refusal("Method not allowed", 405);
  if (!env.CONTROL_DB || !env.WORKSPACE || !env.TRANSPORT_SECRET_KEY) return refusal("Unavailable", 503);

  let rawBody: string;
  let candidate: AnthropicThinEvent;
  try {
    rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > 16_384) return refusal("Payload too large", 413);
    candidate = JSON.parse(rawBody) as AnthropicThinEvent;
    if (!candidate?.data || typeof candidate.data.organization_id !== "string" || typeof candidate.data.workspace_id !== "string") {
      return refusal("Invalid event", 400);
    }
  } catch {
    return refusal("Invalid event", 400);
  }

  const route = await env.CONTROL_DB.prepare(
    `SELECT durable_object_id, secret_envelope, transport_context, organization_id, provider_workspace_id
     FROM runtime_webhook_routes WHERE organization_id = ? AND provider_workspace_id = ?
       AND status IN ('pending', 'active')`,
  ).bind(candidate.data.organization_id, candidate.data.workspace_id).first<WebhookRoute>();
  if (!route) return refusal("Invalid signature", 400);

  try {
    const secret = await decryptTransportSecret(route.secret_envelope, env.TRANSPORT_SECRET_KEY, route.transport_context);
    const event = unwrapAnthropicWebhook({ rawBody, headers: request.headers, signingSecret: secret,
      organizationId: route.organization_id, workspaceId: route.provider_workspace_id });
    const stub = env.WORKSPACE.get(env.WORKSPACE.idFromString(route.durable_object_id));
    await stub.acceptAnthropicWebhook({ event, now: Date.now() });
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  } catch {
    return refusal("Invalid signature", 400);
  }
}
