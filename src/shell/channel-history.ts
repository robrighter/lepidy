import { AuthorizationService } from "../control/authorization";
import type { MessagePage } from "../cloudflare/workspace-rooms";
import { type ShellEnvironment } from "./resolve-shell-source";
import { resolveViewerWorkspace, shellErrorReason } from "./workspace-shell-source";

export type ChannelHistoryState =
  | { status: "ready"; page: MessagePage }
  | { status: "not_found" }
  | { status: "unavailable"; reason: string };

/**
 * Read one room's history for the signed-in viewer.
 *
 * Authorization is not repeated here: the workspace object refuses a room this
 * member cannot see, and reports it as missing rather than forbidden, so this
 * surface can pass that answer through without leaking whether the room exists.
 */
export async function loadChannelHistory(
  env: ShellEnvironment,
  sessionToken: string | null,
  channelId: string,
  options: { cursor?: string | null; limit?: number } = {},
): Promise<ChannelHistoryState> {
  if (!env.CONTROL_DB || !env.WORKSPACE || !sessionToken) return { status: "not_found" };

  const authorization = new AuthorizationService(env.CONTROL_DB, env.WORKSPACE);
  const resolved = await resolveViewerWorkspace(
    {
      db: env.CONTROL_DB,
      workspaces: env.WORKSPACE,
      authenticateSession: (token) => authorization.authenticateBrowserSession(token),
    },
    sessionToken,
  );
  if (resolved.status === "signed_out") return { status: "not_found" };
  if (resolved.status === "unavailable") return { status: "unavailable", reason: resolved.reason };

  const { row } = resolved;
  try {
    const stub = env.WORKSPACE.get(env.WORKSPACE.idFromString(row.durable_object_id));
    const page = await stub.readChannelHistory({
      actor: { memberId: row.member_id, authorizationEpoch: row.authorization_epoch },
      channelId,
      cursor: options.cursor ?? null,
      limit: options.limit,
    });
    return { status: "ready", page };
  } catch (error) {
    const reason = shellErrorReason(error);
    if (reason.includes("channel not found")) return { status: "not_found" };
    return { status: "unavailable", reason };
  }
}
