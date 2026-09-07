import { cache } from "react";

import type { OauthConnectionSummary } from "../cloudflare/workspace";
import { viewerWorkspace, isFailure, shellErrorReason } from "./viewer-workspace";
import { readCsrfToken } from "./session-cookies";

export type ConnectionsState =
  | { status: "ready"; connections: readonly OauthConnectionSummary[]; workspaceSlug: string }
  | { status: "unavailable"; reason: string };

/**
 * The viewer's own MCP connections.
 *
 * Memoised per request like the other readers, so a page and its layout do not
 * ask the workspace object the same question twice.
 */
export const viewerConnections = cache(async (): Promise<ConnectionsState> => {
  const workspace = await viewerWorkspace((await readCsrfToken()) ?? undefined);
  if (isFailure(workspace)) return { status: "unavailable", reason: workspace.reason };
  try {
    const listed = await workspace.stub.listOauthConnections({ actor: workspace.actor });
    return {
      status: "ready",
      connections: listed.connections,
      workspaceSlug: workspace.workspaceSlug,
    };
  } catch (error) {
    return { status: "unavailable", reason: shellErrorReason(error) };
  }
});
