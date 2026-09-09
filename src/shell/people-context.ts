import { getCloudflareContext } from "@opennextjs/cloudflare";
import { cookies } from "next/headers";
import { cache } from "react";

import type { PeopleDirectory, Workspace } from "../cloudflare/workspace";
import { AuthorizationService } from "../control/authorization";
import { AdministrationService, type AdministrationSnapshot } from "../control/administration";
import { buildMentionCards, type MentionCard } from "../domain/people";
import { SESSION_COOKIE, type ShellEnvironment } from "./resolve-shell-source";
import { resolveViewerWorkspace, shellErrorReason } from "./workspace-shell-source";

export type DirectoryState =
  | {
      status: "ready";
      viewerMemberId: string;
      authorizationEpoch: number;
      workspaceRowId: string;
      durableObjectId: string;
      directory: PeopleDirectory;
    }
  | { status: "signed_out" }
  | { status: "unavailable"; reason: string };

export type PeopleState =
  | { status: "ready"; viewerMemberId: string; directory: PeopleDirectory; administration: AdministrationSnapshot | null }
  | { status: "signed_out" }
  | { status: "unavailable"; reason: string };

/**
 * The tenant-local directory as the signed-in viewer is allowed to see it.
 *
 * Separate from {@link workspacePeople} because a room only needs the
 * directory to draw hovercards, and should not pay for the control-plane
 * administration read that an administrator's People screen needs.
 */
export const workspaceDirectory = cache(async (): Promise<DirectoryState> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  if (!token) return { status: "signed_out" };
  let env: ShellEnvironment = {};
  try {
    env = (await getCloudflareContext({ async: true })).env as ShellEnvironment;
  } catch {
    return { status: "unavailable", reason: "This deployment has no workspace storage configured." };
  }
  if (!env.CONTROL_DB || !env.WORKSPACE) return { status: "signed_out" };
  const authorization = new AuthorizationService(env.CONTROL_DB, env.WORKSPACE);
  const resolved = await resolveViewerWorkspace({
    db: env.CONTROL_DB,
    workspaces: env.WORKSPACE,
    authenticateSession: (value) => authorization.authenticateBrowserSession(value),
  }, token);
  if (resolved.status !== "ok") return resolved;
  try {
    const stub = env.WORKSPACE.get(env.WORKSPACE.idFromString(resolved.row.durable_object_id));
    const actor = { memberId: resolved.row.member_id, authorizationEpoch: resolved.row.authorization_epoch };
    const directory = await stub.listPeople({ actor });
    return {
      status: "ready",
      viewerMemberId: actor.memberId,
      authorizationEpoch: actor.authorizationEpoch,
      workspaceRowId: resolved.row.id,
      durableObjectId: resolved.row.durable_object_id,
      directory,
    };
  } catch (error) {
    return { status: "unavailable", reason: shellErrorReason(error) };
  }
});

export const workspacePeople = cache(async (): Promise<PeopleState> => {
  const state = await workspaceDirectory();
  if (state.status !== "ready") return state;
  let env: ShellEnvironment = {};
  try {
    env = (await getCloudflareContext({ async: true })).env as ShellEnvironment;
  } catch {
    return { status: "unavailable", reason: "This deployment has no workspace storage configured." };
  }
  if (!env.CONTROL_DB || !env.WORKSPACE) return { status: "signed_out" };
  const viewer = state.directory.people.find((member) => member.id === state.viewerMemberId);
  try {
    const administration = viewer?.role === "owner" || viewer?.role === "admin"
      ? await new AdministrationService(env.CONTROL_DB, env.WORKSPACE).listAdministration(state.workspaceRowId, state.viewerMemberId)
      : null;
    return { status: "ready", viewerMemberId: state.viewerMemberId, directory: state.directory, administration };
  } catch (error) {
    return { status: "unavailable", reason: shellErrorReason(error) };
  }
});

/**
 * Hovercards for whatever this reader may already see. A signed-out or
 * unavailable directory produces no cards, so a mention simply stays a
 * highlighted name.
 *
 * Agents are read alongside people because mentioning one hands the message to
 * every owner, and PRD §6.2 requires those owners to be named wherever the
 * agent appears — the mention pill included.
 */
export async function mentionCards(): Promise<ReadonlyMap<string, MentionCard>> {
  const state = await workspaceDirectory();
  if (state.status !== "ready") return new Map();
  let agents: Awaited<ReturnType<Workspace["listAgents"]>>["agents"] = [];
  try {
    const env = (await getCloudflareContext({ async: true })).env as ShellEnvironment;
    if (env.WORKSPACE) {
      agents = (await env.WORKSPACE.get(env.WORKSPACE.idFromString(state.durableObjectId)).listAgents({
        actor: { memberId: state.viewerMemberId, authorizationEpoch: state.authorizationEpoch },
      })).agents;
    }
  } catch {
    // A directory without agent cards is still a useful directory.
    agents = [];
  }
  return buildMentionCards({ ...state.directory, agents }, new Date());
}
