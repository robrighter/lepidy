import { AgentDirectory } from "@/components/shell/agent-directory";
import { workspaceAgents } from "@/src/shell/agents-context";

export default async function AgentsPage() {
  const state = await workspaceAgents();

  if (state.status === "unavailable") {
    return (
      <section className="empty-state">
        <h2>Agents are unavailable</h2>
        <p>{state.reason}</p>
        <span className="next-step">Nothing was shown because authority could not be confirmed.</span>
      </section>
    );
  }

  return (
    <>
      <section className="panel">
        <h2>Agents</h2>
        <p>
          Named, addressable, owned by a person, with a standing brief and a scope you can read on
          one page. An agent has no login of its own and can never act as anybody.
        </p>
      </section>
      <section className="panel">
        <AgentDirectory agents={state.status === "ready" ? state.agents : []} />
      </section>
    </>
  );
}
