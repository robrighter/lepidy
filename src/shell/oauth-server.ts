import { getCloudflareContext } from "@opennextjs/cloudflare";

import type { Workspace } from "../cloudflare/workspace";
import { isRegistrableRedirectUri, originFromHeaders, randomSecret } from "../domain/mcp-oauth";
import type { ShellEnvironment } from "./resolve-shell-source";

/**
 * The server-side half of the MCP authorization server that is not the workspace
 * object: resolving which tenant a request is about, and the client registry.
 *
 * Every OAuth endpoint is reached without a session — a client registers before
 * anybody signs in, and a token request carries only the code — so none of this
 * can lean on the cookie-based path the rest of the app uses. What identifies
 * the tenant is the workspace named in the URL, and nothing else.
 */

export type OauthEnvironment = {
  db: D1Database;
  workspaces: NonNullable<ShellEnvironment["WORKSPACE"]>;
};

export async function oauthEnvironment(): Promise<OauthEnvironment | null> {
  let env: ShellEnvironment = {};
  try {
    env = (await getCloudflareContext({ async: true })).env as ShellEnvironment;
  } catch {
    return null;
  }
  if (!env.CONTROL_DB || !env.WORKSPACE) return null;
  return { db: env.CONTROL_DB, workspaces: env.WORKSPACE };
}

export type ResolvedWorkspace = { slug: string; stub: DurableObjectStub<Workspace> };

/**
 * Find a workspace by the slug in the URL.
 *
 * A workspace that is not serving — provisioning, quarantined, being deleted —
 * is reported as missing rather than as unavailable, because an OAuth client
 * that cannot connect learns nothing useful from the difference and an
 * enumerating stranger would.
 */
export async function resolveWorkspaceBySlug(
  env: OauthEnvironment,
  slug: string,
): Promise<ResolvedWorkspace | null> {
  const row = await env.db
    .prepare("SELECT slug, durable_object_id, status FROM workspaces WHERE slug = ?")
    .bind(slug)
    .first<{ slug: string; durable_object_id: string; status: string }>();
  if (row === null || row.status !== "active") return null;
  return {
    slug: row.slug,
    stub: env.workspaces.get(env.workspaces.idFromString(row.durable_object_id)),
  };
}

export type RegisteredClient = {
  clientId: string;
  clientName: string | null;
  redirectUris: readonly string[];
  createdAt: number;
};

export async function registerOauthClient(
  env: OauthEnvironment,
  input: { clientName: string | null; redirectUris: readonly string[]; now: number },
): Promise<RegisteredClient> {
  // A client id is a label, not a credential, so it is random for uniqueness
  // rather than for secrecy — and it is still random, because a guessable one
  // would let anybody impersonate a registration in a consent screen.
  const clientId = `lpd_client_${randomSecret(16)}`;
  await env.db
    .prepare(
      `INSERT INTO oauth_clients(client_id, client_name, redirect_uris_json, token_endpoint_auth_method, created_at)
       VALUES (?, ?, ?, 'none', ?)`,
    )
    .bind(clientId, input.clientName, JSON.stringify(input.redirectUris), input.now)
    .run();
  return {
    clientId,
    clientName: input.clientName,
    redirectUris: input.redirectUris,
    createdAt: input.now,
  };
}

export async function readOauthClient(
  env: OauthEnvironment,
  clientId: string,
): Promise<RegisteredClient | null> {
  const row = await env.db
    .prepare(
      "SELECT client_id, client_name, redirect_uris_json, created_at FROM oauth_clients WHERE client_id = ?",
    )
    .bind(clientId)
    .first<{
      client_id: string;
      client_name: string | null;
      redirect_uris_json: string;
      created_at: number;
    }>();
  if (row === null) return null;

  // Stored JSON is re-checked on the way out. A registration written by an
  // older release, or by hand, must not widen what a redirect may be now.
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.redirect_uris_json);
  } catch {
    return null;
  }
  const redirectUris = Array.isArray(parsed) ? parsed.filter(isRegistrableRedirectUri) : [];
  if (redirectUris.length === 0) return null;

  return {
    clientId: row.client_id,
    clientName: row.client_name,
    redirectUris,
    createdAt: row.created_at,
  };
}

export async function touchOauthClient(env: OauthEnvironment, clientId: string, now: number): Promise<void> {
  await env.db
    .prepare("UPDATE oauth_clients SET last_used_at = ? WHERE client_id = ?")
    .bind(now, clientId)
    .run();
}

export { originFromHeaders };

/** The origin this request was addressed at; see `originFromHeaders`. */
export function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  return originFromHeaders(
    request.headers.get("host"),
    request.headers.get("x-forwarded-proto"),
    url.origin,
  );
}

/** An OAuth error body, in the shape RFC 6749 §5.2 requires. */
export function oauthError(
  error: string,
  description: string,
  status = 400,
  extraHeaders: Record<string, string> = {},
): Response {
  return Response.json(
    { error, error_description: description },
    { status, headers: { "Cache-Control": "no-store", ...extraHeaders } },
  );
}

export function oauthJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
