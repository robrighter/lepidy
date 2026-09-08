import { getCloudflareContext } from "@opennextjs/cloudflare";
import { cookies } from "next/headers";
import { cache } from "react";

import { AuthorizationService } from "../control/authorization";
import type { NotificationActivity, NotificationPreferencesSnapshot } from "../cloudflare/workspace";
import { SESSION_COOKIE, type ShellEnvironment } from "./resolve-shell-source";
import { resolveViewerWorkspace, shellErrorReason } from "./workspace-shell-source";

export type ActivityState =
  | { status: "ready"; activity: NotificationActivity; preferences: NotificationPreferencesSnapshot }
  | { status: "signed_out" }
  | { status: "unavailable"; reason: string };

export const workspaceActivity = cache(async (unreadOnly = false): Promise<ActivityState> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  if (!token) return { status: "signed_out" };
  let env: ShellEnvironment = {};
  try {
    env = (await getCloudflareContext({ async: true })).env as ShellEnvironment;
  } catch {
    env = {};
  }
  if (!env.CONTROL_DB || !env.WORKSPACE) return { status: "signed_out" };
  const authorization = new AuthorizationService(env.CONTROL_DB, env.WORKSPACE);
  const resolved = await resolveViewerWorkspace({
    db: env.CONTROL_DB,
    workspaces: env.WORKSPACE,
    authenticateSession: (value) => authorization.authenticateBrowserSession(value),
  }, token);
  if (resolved.status === "signed_out") return { status: "signed_out" };
  if (resolved.status === "unavailable") return { status: "unavailable", reason: resolved.reason };
  try {
    const stub = env.WORKSPACE.get(env.WORKSPACE.idFromString(resolved.row.durable_object_id));
    const actor = { memberId: resolved.row.member_id, authorizationEpoch: resolved.row.authorization_epoch };
    const [activity, preferences] = await Promise.all([
      stub.listNotificationActivity({ actor, unreadOnly }), stub.notificationPreferences({ actor }),
    ]);
    return { status: "ready", activity, preferences };
  } catch (error) {
    return { status: "unavailable", reason: shellErrorReason(error) };
  }
});
