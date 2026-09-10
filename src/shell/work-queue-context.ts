import { getCloudflareContext } from "@opennextjs/cloudflare";
import { cookies } from "next/headers";
import { cache } from "react";

import type { WorkQueueSnapshot } from "../cloudflare/workspace";
import { AuthorizationService } from "../control/authorization";
import { SESSION_COOKIE, type ShellEnvironment } from "./resolve-shell-source";
import { resolveViewerWorkspace } from "./workspace-shell-source";

export type WorkQueueState =
  | { status: "ready"; snapshot: WorkQueueSnapshot }
  | { status: "not_ranked" }
  | { status: "unavailable"; reason: string };

export const workQueue = cache(async (
  channelId: string,
  statusId: string | null = null,
  limit = 100,
): Promise<WorkQueueState> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  if (!token) return { status: "unavailable", reason: "Sign in to view this queue." };
  let env: ShellEnvironment = {};
  try { env = (await getCloudflareContext({ async: true })).env as ShellEnvironment; } catch { env = {}; }
  if (!env.CONTROL_DB || !env.WORKSPACE) return { status: "unavailable", reason: "Queue storage is unavailable." };
  const authorization = new AuthorizationService(env.CONTROL_DB, env.WORKSPACE);
  const resolved = await resolveViewerWorkspace({
    db: env.CONTROL_DB,
    workspaces: env.WORKSPACE,
    authenticateSession: (value) => authorization.authenticateBrowserSession(value),
  }, token);
  if (resolved.status !== "ok") return { status: "unavailable", reason: "Sign in to view this queue." };
  try {
    const stub = env.WORKSPACE.get(env.WORKSPACE.idFromString(resolved.row.durable_object_id));
    const snapshot = await stub.readWorkQueue({
      actor: { memberId: resolved.row.member_id, authorizationEpoch: resolved.row.authorization_epoch },
      channelId, statusId, limit,
    });
    return { status: "ready", snapshot };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "queue unavailable";
    return reason.includes("not ranked") ? { status: "not_ranked" } : { status: "unavailable", reason };
  }
});
