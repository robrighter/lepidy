import Link from "next/link";
import { headers } from "next/headers";

import { RuntimeScreen } from "@/components/shell/runtime-config";
import { originFromHeaders } from "@/src/domain/mcp-oauth";
import { agentRuntime } from "@/src/shell/runtime-context";
import { readCsrfToken } from "@/src/shell/session-cookies";

/**
 * One agent's runtime, on its own route.
 *
 * Separate from the agent's overview deliberately: this is the page where a
 * person decides who may cause a process to start on their computer, and it
 * deserves an address they can be sent to rather than a tab that loses its
 * place. Everything on it is owner-only, and the read that fills it refuses
 * anybody else.
 */
export default async function AgentRuntimePage({ params }: { params: Promise<{ agent: string }> }) {
  const { agent: agentId } = await params;
  const list = await headers();
  const host = list.get("host");
  const origin =
    host === null || host.length === 0
      ? "https://lepidy.app"
      : originFromHeaders(host, list.get("x-forwarded-proto"), `https://${host}`);
  const state = await agentRuntime(decodeURIComponent(agentId), origin);

  if (state.status !== "ready") {
    return (
      <section className="empty-state">
        <h2>Runtime not available</h2>
        <p>
          {state.status === "unavailable"
            ? state.reason
            : "Sign in to configure how an agent runs."}
        </p>
        <span className="next-step">
          Only an owner of the agent can see or change this. Nothing was shown because authority could not
          be confirmed.
        </span>
      </section>
    );
  }

  const csrfToken = (await readCsrfToken()) ?? "";

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h1 className="runtime-title">@{state.runtime.handle}</h1>
          <Link href={`/agents/${encodeURIComponent(state.runtime.agentId)}`} className="via">
            Back to the agent
          </Link>
        </div>
        <p className="runtime-status-line">
          {state.runtime.agentStatus === "active"
            ? "Active."
            : `This agent is ${state.runtime.agentStatus}. Nothing starts for it, whatever is configured below.`}
        </p>
      </section>

      <RuntimeScreen
        initial={state.runtime}
        csrfToken={csrfToken}
        origin={state.origin ?? origin}
        workspaceSlug={state.workspaceSlug}
        deviceLabel={state.deviceLabel}
      />
    </>
  );
}
