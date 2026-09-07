import { parseToken } from "@/src/domain/mcp-oauth";
import {
  oauthEnvironment,
  oauthError,
  oauthJson,
  readOauthClient,
  resolveWorkspaceBySlug,
  touchOauthClient,
} from "@/src/shell/oauth-server";

/**
 * The token endpoint, for both grants we support.
 *
 * There is no session here and no workspace in the path: the presented code or
 * refresh token is what says which tenant this is about, which is the whole
 * point of putting the workspace in the token's prefix. The object then has to
 * recognise the hash, so the prefix routes and never authorises.
 */
export async function POST(request: Request) {
  const env = await oauthEnvironment();
  if (env === null) {
    return oauthError("temporarily_unavailable", "this deployment has no control plane configured", 503);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return oauthError("invalid_request", "a form-encoded body is required");
  }
  const field = (name: string): string | null => {
    const value = form.get(name);
    return typeof value === "string" && value.length > 0 ? value : null;
  };

  const grantType = field("grant_type");
  const clientId = field("client_id");
  if (clientId === null) return oauthError("invalid_client", "client_id is required");

  const client = await readOauthClient(env, clientId);
  if (client === null) return oauthError("invalid_client", "unknown client", 401);

  const presented = grantType === "refresh_token" ? field("refresh_token") : field("code");
  const parsed = parseToken(presented);
  if (presented === null || parsed === null) {
    return oauthError("invalid_grant", "the grant is missing or malformed");
  }

  const workspace = await resolveWorkspaceBySlug(env, parsed.workspaceSlug);
  // The token names a workspace this deployment does not serve. Answered as a
  // bad grant rather than a missing workspace, so the endpoint does not become
  // a way to ask which workspaces exist.
  if (workspace === null) return oauthError("invalid_grant", "the grant is not valid here");

  const now = Date.now();
  if (grantType === "authorization_code") {
    const result = await workspace.stub.exchangeOauthCode({
      workspaceSlug: workspace.slug,
      code: presented,
      clientId,
      clientName: client.clientName,
      redirectUri: field("redirect_uri"),
      codeVerifier: field("code_verifier"),
      resource: field("resource"),
      now,
    });
    if (!result.ok) return oauthError(result.error, result.description);
    await touchOauthClient(env, clientId, now);
    return tokenResponse(result.grant);
  }

  if (grantType === "refresh_token") {
    const result = await workspace.stub.refreshOauthTokens({
      workspaceSlug: workspace.slug,
      refreshToken: presented,
      clientId,
      now,
    });
    if (!result.ok) return oauthError(result.error, result.description);
    await touchOauthClient(env, clientId, now);
    return tokenResponse(result.grant);
  }

  return oauthError("unsupported_grant_type", "only authorization_code and refresh_token are supported");
}

function tokenResponse(grant: {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  scope: string;
}): Response {
  return oauthJson({
    access_token: grant.accessToken,
    token_type: "Bearer",
    expires_in: grant.expiresInSeconds,
    // Rotation is unconditional, so a client that does not store the new
    // refresh token loses the connection at its next attempt rather than
    // quietly continuing with a token we consider spent.
    refresh_token: grant.refreshToken,
    scope: grant.scope,
  });
}
