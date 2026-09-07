import {
  bearerChallenge,
  bearerFromHeader,
  protectedResourceMetadataUrl,
  workspaceResourceUri,
} from "@/src/domain/mcp-oauth";
import { oauthEnvironment, requestOrigin, resolveWorkspaceBySlug } from "@/src/shell/oauth-server";

/**
 * The workspace's MCP endpoint — the protected resource.
 *
 * A02 delivers the connection: discovery, the 401 challenge that tells a client
 * where to authenticate, and the token verification that turns a bearer
 * credential into a person. The tool families themselves are A03, so this
 * answers `initialize` and an empty `tools/list` and nothing more. That is
 * enough for a client to complete its whole connection sequence, which is what
 * makes the authorization work testable end to end today.
 */
export async function GET(request: Request, context: { params: Promise<{ slug: string }> }) {
  // A client that opens the stream before authenticating gets the same
  // challenge it would get from a call, which is how it discovers the
  // authorization server.
  return handle(request, context, () =>
    Response.json({ error: "this endpoint answers JSON-RPC over POST" }, { status: 405 }),
  );
}

export async function POST(request: Request, context: { params: Promise<{ slug: string }> }) {
  return handle(request, context, async (principal) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonRpcError(null, -32700, "the body is not JSON");
    }
    if (typeof body !== "object" || body === null) {
      return jsonRpcError(null, -32600, "a JSON-RPC request object is required");
    }
    const message = body as { id?: unknown; method?: unknown };
    const id = message.id ?? null;

    switch (message.method) {
      case "initialize":
        return jsonRpcResult(id, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "lepidy", version: "0.1.0" },
          // The connected person, so a client can show whose connection this is
          // without a tool call. Derived from the token and nowhere else.
          instructions: `Connected to Lepidy as @${principal.handle}. Tools arrive with A03.`,
        });
      case "notifications/initialized":
        return new Response(null, { status: 202 });
      case "tools/list":
        return jsonRpcResult(id, { tools: [] });
      default:
        return jsonRpcError(id, -32601, `unknown method ${String(message.method)}`);
    }
  });
}

type Principal = { handle: string };

async function handle(
  request: Request,
  context: { params: Promise<{ slug: string }> },
  next: (principal: Principal) => Response | Promise<Response>,
): Promise<Response> {
  const { slug } = await context.params;
  const origin = requestOrigin(request);
  const metadataUrl = protectedResourceMetadataUrl(origin, slug);

  const env = await oauthEnvironment();
  if (env === null) {
    return Response.json({ error: "unavailable" }, { status: 503 });
  }
  const workspace = await resolveWorkspaceBySlug(env, slug);
  if (workspace === null) return new Response(null, { status: 404 });

  const presented = bearerFromHeader(request.headers.get("authorization"));
  if (presented === null) {
    return unauthorized(metadataUrl);
  }

  const verified = await workspace.stub.authenticateOauthToken({
    accessToken: presented,
    // The audience is the resource URI of the endpoint this request actually
    // arrived at, not one the token or the client supplied. That is what makes
    // a token minted for another workspace useless here.
    audience: workspaceResourceUri(origin, slug),
    now: Date.now(),
  });
  if (!verified.ok) {
    return unauthorized(metadataUrl, verified.error, verified.description);
  }

  return next({ handle: verified.principal.handle });
}

function unauthorized(
  metadataUrl: string,
  error?: "invalid_token" | "insufficient_scope",
  description?: string,
): Response {
  return new Response(null, {
    status: error === "insufficient_scope" ? 403 : 401,
    headers: {
      "WWW-Authenticate": bearerChallenge({ resourceMetadataUrl: metadataUrl, error, description }),
      "Cache-Control": "no-store",
    },
  });
}

function jsonRpcResult(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result }, { headers: { "Cache-Control": "no-store" } });
}

function jsonRpcError(id: unknown, code: number, message: string): Response {
  return Response.json(
    { jsonrpc: "2.0", id, error: { code, message } },
    { headers: { "Cache-Control": "no-store" } },
  );
}
