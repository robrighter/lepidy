import { ConnectionList } from "@/components/shell/connection-list";
import { viewerConnections } from "@/src/shell/connections-context";
import { readCsrfToken } from "@/src/shell/session-cookies";

export default async function ConnectionsPage() {
  const state = await viewerConnections();

  if (state.status === "unavailable") {
    return (
      <section className="empty-state">
        <h2>Connections are unavailable</h2>
        <p>{state.reason}</p>
        <span className="next-step">Nothing was shown because authority could not be confirmed.</span>
      </section>
    );
  }

  return (
    <>
      <section className="panel">
        <h2>MCP connections</h2>
        <p>
          Each connection is one MCP client acting as you. It holds no authority of its own: it can
          reach exactly what you can reach, and ending it here stops it at its next request.
        </p>
      </section>
      <section className="panel">
        <ConnectionList
          connections={state.connections}
          csrfToken={(await readCsrfToken()) ?? ""}
        />
      </section>
    </>
  );
}
