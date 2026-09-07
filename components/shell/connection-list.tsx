"use client";

import { useActionState } from "react";

import { disconnectAction, type ConnectionsResult } from "@/app/(app)/connections/actions";
import type { OauthConnectionSummary } from "@/src/cloudflare/workspace";

/**
 * The viewer's MCP connections, with one form per row.
 *
 * The rows come from the server on first render and afterwards from whatever
 * the action returned, so the list shows what somebody just did without waiting
 * on a re-render. Each row is a real form posting to a server action, so a
 * disconnect clicked before the page has hydrated still happens.
 */
export function ConnectionList({
  connections,
  csrfToken,
}: {
  connections: readonly OauthConnectionSummary[];
  csrfToken: string;
}) {
  const [state, formAction, pending] = useActionState<ConnectionsResult | null, FormData>(
    disconnectAction,
    null,
  );
  const current = state?.ok === true ? state.connections : connections;

  if (current.length === 0) {
    return (
      <div className="empty-state">
        <h2>No connections yet</h2>
        <p>Connect Claude Code or another MCP client and it will appear here.</p>
      </div>
    );
  }

  return (
    <>
      {state && !state.ok ? (
        <p className="message-error" role="alert">
          {state.reason}
        </p>
      ) : null}
      <ul className="connection-list">
        {current.map((connection) => (
          <li key={connection.id}>
            <div>
              <strong>{connection.clientName ?? "An unnamed MCP client"}</strong>
              <code>{connection.scope}</code>
              <span className="connection-meta">
                {connection.lastUsedAt === null
                  ? "Never used"
                  : `Last used ${new Date(connection.lastUsedAt).toISOString().slice(0, 10)}`}
                {" · "}
                {connection.rotationCount} refresh
                {connection.rotationCount === 1 ? "" : "es"}
              </span>
            </div>
            <form action={formAction}>
              <input type="hidden" name="connectionId" value={connection.id} />
              <input type="hidden" name="csrfToken" value={csrfToken} />
              <button type="submit" disabled={pending} aria-label={`Disconnect ${connection.clientName ?? connection.clientId}`}>
                Disconnect
              </button>
            </form>
          </li>
        ))}
      </ul>
    </>
  );
}
