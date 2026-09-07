"use server";

import type { OauthConnectionSummary } from "@/src/cloudflare/workspace";
import { isFailure, shellErrorReason, viewerWorkspace } from "@/src/shell/viewer-workspace";

export type ConnectionsResult =
  | { ok: true; connections: readonly OauthConnectionSummary[] }
  | { ok: false; reason: string };

/**
 * End one of the caller's own connections.
 *
 * The action hands back the list it produced and deliberately does not
 * revalidate: a revalidation landing after the client has applied the result
 * re-seeds the component with the props the server held before the write.
 * Submitted through a form action, so a click before hydration still works.
 */
export async function disconnectAction(
  _previous: ConnectionsResult | null,
  form: FormData,
): Promise<ConnectionsResult> {
  const connectionId = form.get("connectionId");
  const csrfToken = form.get("csrfToken");
  if (typeof connectionId !== "string" || connectionId.length === 0) {
    return { ok: false, reason: "That connection could not be identified." };
  }

  const workspace = await viewerWorkspace(typeof csrfToken === "string" ? csrfToken : undefined);
  if (isFailure(workspace)) return workspace;
  try {
    await workspace.stub.revokeOauthConnection({
      actor: workspace.actor,
      connectionId,
      now: Date.now(),
    });
    const listed = await workspace.stub.listOauthConnections({ actor: workspace.actor });
    return { ok: true, connections: listed.connections };
  } catch (error) {
    return { ok: false, reason: shellErrorReason(error) };
  }
}
