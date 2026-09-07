import { authorizationServerMetadata } from "@/src/domain/mcp-oauth";
import { oauthJson, requestOrigin } from "@/src/shell/oauth-server";

/**
 * RFC 8414 authorization server metadata.
 *
 * One authorization server for the deployment, issuing tokens for many
 * protected resources — one per workspace — which is why this document is not
 * workspace-scoped and the protected-resource document is.
 */
export async function GET(request: Request) {
  return oauthJson(authorizationServerMetadata(requestOrigin(request)));
}
