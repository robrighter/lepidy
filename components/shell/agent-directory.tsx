"use client";

import { ShieldCheck, Sparkles } from "lucide-react";
import { useState, useTransition } from "react";

import { createAgentAction } from "@/app/(app)/agents/actions";
import type { AgentSummary } from "@/src/cloudflare/workspace";
import { SECURITY_PREAMBLE } from "@/src/domain/agent-preamble";
import { browserCsrfToken } from "@/src/shell/browser-csrf";
import { AgentAvatar } from "./avatar";
import { useHydrated } from "./use-hydrated";

export function AgentDirectory({ agents }: { agents: readonly AgentSummary[] }) {
  const [current, setCurrent] = useState(agents);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [handle, setHandle] = useState("");
  const [description, setDescription] = useState("");
  const hydrated = useHydrated();

  return (
    <>
      <form
        className="agent-form"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          startTransition(async () => {
            const result = await createAgentAction({
              csrfToken: browserCsrfToken(),
              handle,
              description,
              idempotencyKey: `agent:${crypto.randomUUID()}`.slice(0, 128),
            });
            if (!result.ok) {
              setError(result.reason);
              return;
            }
            setCurrent(result.agents);
            setHandle("");
            setDescription("");
          });
        }}
      >
        <label>
          <span>Handle</span>
          <input
            value={handle}
            readOnly={!hydrated}
            onChange={(event) => setHandle(event.target.value)}
            placeholder="releasebot"
          />
          <em>Agents always live in the a. namespace.</em>
        </label>
        <label>
          <span>What it does</span>
          <input
            value={description}
            readOnly={!hydrated}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Watches deploys."
          />
        </label>
        <button type="submit" className="primary" disabled={pending || !hydrated}>
          Create agent
        </button>
        {error ? (
          <p className="message-error" role="alert">
            {error}
          </p>
        ) : null}
      </form>

      {current.length === 0 ? (
        <div className="empty-state">
          <h2>No agents yet</h2>
          <p>An agent is a named member of this workspace, owned by a person and addressable by handle.</p>
          <span className="next-step">Connecting one to a runtime arrives with A02 and A03.</span>
        </div>
      ) : (
        <ul className="agent-list">
          {current.map((agent) => (
            <li key={agent.id}>
              <AgentAvatar size={34} />
              <div>
                <p className="agent-name">
                  <strong>@{agent.handle}</strong>
                  <span className="tag">{agent.status}</span>
                  {agent.isOwner ? <span className="tag">you own this</span> : null}
                </p>
                {agent.description ? <p className="agent-description">{agent.description}</p> : null}
                <p className="agent-meta">
                  {agent.scopeMode === "any"
                    ? "Every room its owners can reach"
                    : `${agent.scopeChannelCount} ${agent.scopeChannelCount === 1 ? "room" : "rooms"}`}
                  {agent.queueDepth !== null ? ` · ${agent.queueDepth} waiting` : ""}
                  {` · ${agent.ownerIds.length} ${agent.ownerIds.length === 1 ? "owner" : "owners"}`}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}

      <details className="preamble">
        <summary>
          <ShieldCheck size={14} aria-hidden="true" /> The security preamble every agent is given
        </summary>
        <p className="preamble-note">
          Compiled into the application. It is not editable from inside the product, by anyone, and it
          sits above every brief an owner writes.
        </p>
        <pre>
          <code>{SECURITY_PREAMBLE}</code>
        </pre>
      </details>
    </>
  );
}

export function AgentsHeading() {
  return (
    <h2>
      <Sparkles size={15} aria-hidden="true" /> Agents
    </h2>
  );
}
