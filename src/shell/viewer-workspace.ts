import { getCloudflareContext } from "@opennextjs/cloudflare";
import { cookies } from "next/headers";

import { AuthorizationService } from "../control/authorization";
import type { Actor, Workspace } from "../cloudflare/workspace";
import { SESSION_COOKIE, type ShellEnvironment } from "./resolve-shell-source";
import { resolveViewerWorkspace, shellErrorReason } from "./workspace-shell-source";

export type ViewerWorkspace = {
  stub: DurableObjectStub<Workspace>;
  actor: Actor;
  workspaceId: string;
  /** What routes an MCP token to this tenant, so a page can show its address. */
  workspaceSlug: string;
};

export type ActionFailure = { ok: false; reason: string };

/**
 * Resolve the signed-in viewer's workspace for a mutating action.
 *
 * The actor comes from the session cookie and the CSRF token from the request
 * body, never from anything the caller says about who they are. Every action
 * that changes something goes through here so there is one place that decides
 * what "signed in" means.
 */
export async function viewerWorkspace(
  csrfToken: string | undefined,
): Promise<ViewerWorkspace | ActionFailure> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  if (!token) return { ok: false, reason: "Sign in to do that." };

  let env: ShellEnvironment = {};
  try {
    env = (await getCloudflareContext({ async: true })).env as ShellEnvironment;
  } catch {
    env = {};
  }
  if (!env.CONTROL_DB || !env.WORKSPACE) {
    return { ok: false, reason: "This deployment has no workspace storage configured." };
  }

  const authorization = new AuthorizationService(env.CONTROL_DB, env.WORKSPACE);
  const resolved = await resolveViewerWorkspace(
    {
      db: env.CONTROL_DB,
      workspaces: env.WORKSPACE,
      // An empty string can never match a stored CSRF hash, so a request with
      // no token is refused rather than treated as unchecked.
      authenticateSession: (value) => authorization.authenticateBrowserSession(value, csrfToken ?? ""),
    },
    token,
  );
  if (resolved.status !== "ok") return { ok: false, reason: "Sign in to do that." };

  return {
    stub: env.WORKSPACE.get(env.WORKSPACE.idFromString(resolved.row.durable_object_id)),
    actor: {
      memberId: resolved.row.member_id,
      authorizationEpoch: resolved.row.authorization_epoch,
    },
    workspaceId: resolved.row.id,
    workspaceSlug: resolved.row.slug,
  };
}

export function isFailure(value: ViewerWorkspace | ActionFailure): value is ActionFailure {
  return "ok" in value && value.ok === false;
}

export { shellErrorReason };
