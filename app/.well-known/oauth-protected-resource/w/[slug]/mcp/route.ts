import { protectedResourceMetadata } from "@/src/domain/mcp-oauth";
import { oauthEnvironment, oauthJson, requestOrigin, resolveWorkspaceBySlug } from "@/src/shell/oauth-server";

/**
 * RFC 9728 protected resource metadata, for one workspace.
 *
 * The address is the workspace's own resource URI with the well-known segment
 * inserted before its path, which is how a client that has been handed a 401
 * finds out where to authenticate.
 */
export async function GET(request: Request, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  const env = await oauthEnvironment();
  // A workspace that does not exist, and one this deployment cannot reach, are
  // reported the same way: there is nothing here to authenticate against.
  if (env === null || (await resolveWorkspaceBySlug(env, slug)) === null) {
    return new Response(null, { status: 404 });
  }
  return oauthJson(protectedResourceMetadata(requestOrigin(request), slug));
}
