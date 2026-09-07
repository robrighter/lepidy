import { parseClientRegistration } from "@/src/domain/mcp-oauth";
import { oauthEnvironment, oauthError, oauthJson, registerOauthClient } from "@/src/shell/oauth-server";

/**
 * RFC 7591 dynamic client registration.
 *
 * Open, as MCP requires: a client registers before anybody has signed in, so
 * there is nobody to authorise the registration. That is safe only because a
 * client id authorises nothing — every decision that matters is taken later, by
 * a signed-in person at the consent screen and by PKCE at redemption.
 */
export async function POST(request: Request) {
  const env = await oauthEnvironment();
  if (env === null) {
    return oauthError("temporarily_unavailable", "this deployment has no control plane configured", 503);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return oauthError("invalid_client_metadata", "a JSON body is required");
  }

  const parsed = parseClientRegistration(body);
  if (!parsed.ok) return oauthError(parsed.error, parsed.description);

  const client = await registerOauthClient(env, {
    clientName: parsed.registration.clientName,
    redirectUris: parsed.registration.redirectUris,
    now: Date.now(),
  });

  return oauthJson(
    {
      client_id: client.clientId,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_id_issued_at: Math.floor(client.createdAt / 1000),
    },
    201,
  );
}
