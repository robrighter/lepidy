import Link from "next/link";

import { switchAgentVaultOffAction } from "@/app/(app)/vault/actions";
import { VaultStepUpSwitch, VaultSwitchOffForm } from "@/components/shell/vault-step-up";
import { ActivityLog, LiveGrants } from "@/components/shell/vault-tables";
import { SECURITY_PREAMBLE } from "@/src/domain/agent-preamble";
import { workspaceApprovals } from "@/src/shell/approvals-context";
import { readCsrfToken } from "@/src/shell/session-cookies";
import { agentDetail } from "@/src/shell/vault-context";

export default async function AgentPage({ params }: { params: Promise<{ agent: string }> }) {
  const { agent: agentId } = await params;
  const state = await agentDetail(decodeURIComponent(agentId));

  if (state.status !== "ready") {
    return (
      <section className="empty-state">
        <h2>Agent not available</h2>
        <p>{state.status === "unavailable" ? state.reason : "Sign in to see this workspace's agents."}</p>
        <span className="next-step">An archived agent is not listed.</span>
      </section>
    );
  }

  const { agent, grants, activity } = state;
  const csrfToken = (await readCsrfToken()) ?? "";
  const passkeys = await workspaceApprovals();
  const hasPasskey = passkeys.status === "ready" && passkeys.hasPasskey;

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>@{agent.handle}</h2>
          <span className="agent-links">
            <Link href={`/agents/${encodeURIComponent(agent.id)}/runtime`} className="primary-link">
              How it runs
            </Link>
            <Link href="/agents" className="via">
              Back to agents
            </Link>
          </span>
        </div>
        <p>{agent.description || "No standing brief yet."}</p>
        <dl className="vault-facts">
          <dt>Owned by</dt>
          <dd>{agent.ownerHandles.map((handle) => `@${handle}`).join(", ") || "nobody"}</dd>
          <dt>Status</dt>
          <dd>{agent.status}</dd>
          <dt>Scope</dt>
          <dd>
            {agent.scopeMode === "any"
              ? "every room it is mentioned in"
              : `${agent.scopeChannelCount} ${agent.scopeChannelCount === 1 ? "room" : "rooms"}`}
          </dd>
          <dt>Vault access</dt>
          <dd>{agent.vaultAccessOff ? "switched off" : "on, under each credential's own policy"}</dd>
        </dl>
        <div className="vault-switch">
          {agent.vaultAccessOff ? (
            <>
              <p className="vault-frozen">
                This agent cannot use any credential. It is still active and can keep working; only its access to the
                vault was taken away.
              </p>
              <VaultStepUpSwitch
                action="vault.agent_on"
                subjectId={agent.id}
                label="Switch its vault access on"
                hasPasskey={hasPasskey}
              />
            </>
          ) : (
            <VaultSwitchOffForm
              action={switchAgentVaultOffAction}
              csrfToken={csrfToken}
              fields={{ agentId: agent.id }}
              label="Switch its vault access off"
            />
          )}
        </div>
      </section>

      <section className="panel">
        <h2>What it may never do</h2>
        <p>Compiled into the product and prepended to every session. Its owners cannot edit or remove it.</p>
        <pre className="preamble">{SECURITY_PREAMBLE}</pre>
      </section>

      <section className="panel">
        <h2>Credentials it holds now</h2>
        <LiveGrants
          grants={grants}
          csrfToken={csrfToken}
          scope={{ agentId: agent.id }}
          emptyLabel="It is not holding any credential."
        />
      </section>

      <section className="panel">
        <h2>What it has asked for</h2>
        <p>The person it operates for and the person who approved are recorded separately.</p>
        <ActivityLog activity={activity} />
      </section>
    </>
  );
}
