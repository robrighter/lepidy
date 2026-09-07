import { parseToken } from "@/src/domain/mcp-oauth";
import { oauthEnvironment, oauthError, resolveWorkspaceBySlug } from "@/src/shell/oauth-server";

/**
 * RFC 7009 revocation.
 *
 * The answer is 200 whatever happens, including for a token that never
 * existed. The endpoint is unauthenticated, so reporting whether something was
 * revoked would turn it into an oracle for guessing tokens.
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
  const token = form.get("token");
  const parsed = typeof token === "string" ? parseToken(token) : null;
  if (typeof token === "string" && parsed !== null) {
    const workspace = await resolveWorkspaceBySlug(env, parsed.workspaceSlug);
    if (workspace !== null) {
      await workspace.stub.revokeOauthToken({ token, now: Date.now() });
    }
  }
  return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
}
