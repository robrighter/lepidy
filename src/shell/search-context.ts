import { getCloudflareContext } from "@opennextjs/cloudflare";
import { cookies } from "next/headers";

import type { SavedSearch, WorkspaceSearchPage } from "../cloudflare/workspace";
import { AuthorizationService } from "../control/authorization";
import { SESSION_COOKIE, type ShellEnvironment } from "./resolve-shell-source";
import { resolveViewerWorkspace, shellErrorReason } from "./workspace-shell-source";

export type WorkspaceSearchState =
  | { status: "ready"; page: WorkspaceSearchPage; saved: readonly SavedSearch[] }
  | { status: "signed_out" }
  | { status: "unavailable"; reason: string };

/** Search and saved queries resolved from the signed-in viewer, never a caller-supplied member. */
export async function workspaceSearch(query: string, cursor?: string): Promise<WorkspaceSearchState> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  if (!token) return { status: "signed_out" };
  let env: ShellEnvironment = {};
  try {
    env = (await getCloudflareContext({ async: true })).env as ShellEnvironment;
  } catch {
    return { status: "signed_out" };
  }
  if (!env.CONTROL_DB || !env.WORKSPACE) return { status: "signed_out" };
  const authorization = new AuthorizationService(env.CONTROL_DB, env.WORKSPACE);
  const resolved = await resolveViewerWorkspace(
    { db: env.CONTROL_DB, workspaces: env.WORKSPACE, authenticateSession: (value) => authorization.authenticateBrowserSession(value) },
    token,
  );
  if (resolved.status === "signed_out") return { status: "signed_out" };
  if (resolved.status === "unavailable") return { status: "unavailable", reason: resolved.reason };
  const stub = env.WORKSPACE.get(env.WORKSPACE.idFromString(resolved.row.durable_object_id));
  const actor = { memberId: resolved.row.member_id, authorizationEpoch: resolved.row.authorization_epoch };
  try {
    const [page, saved] = await Promise.all([
      stub.searchWorkspace({ actor, query, cursor, limit: 20 }),
      stub.listSavedSearches({ actor }),
    ]);
    return { status: "ready", page, saved: saved.searches };
  } catch (error) {
    return { status: "unavailable", reason: shellErrorReason(error) };
  }
}
