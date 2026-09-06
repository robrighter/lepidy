import { Hash, Lock, Sparkles } from "lucide-react";
import Link from "next/link";

import { shellState } from "@/src/shell/shell-context";
import { channelHref, channelLabel } from "@/src/shell/shell-model";

export default async function HomePage() {
  const state = await shellState();
  if (state.status !== "ready") return null;
  const { snapshot, workspace } = state;

  return (
    <>
      <section className="panel">
        <h2>{workspace.name}</h2>
        <p>
          Signed in as <strong>{snapshot.viewer.displayName}</strong> (@{snapshot.viewer.handle}) ·{" "}
          {snapshot.viewer.role} · {workspace.plan} plan ·{" "}
          {snapshot.storageMode === "local_host" ? "content on your designated host" : "content in the cloud"}
        </p>
      </section>

      <section className="panel">
        <h2>Channels</h2>
        {snapshot.channels.length === 0 ? (
          <div className="empty-state">
            <h2>No channels yet</h2>
            <p>Nothing has been created in this workspace, or nothing here is visible to you.</p>
            <span className="next-step">Creating and reading channels arrives with C02.</span>
          </div>
        ) : (
          <ul className="list">
            {snapshot.channels.map((channel) => (
              <li key={channel.id}>
                <Link href={channelHref(channel)}>
                  {channel.kind === "public" ? <Hash size={15} /> : <Lock size={15} />}
                  {channelLabel(channel)}
                  {channel.kind === "public" ? null : <span className="tag">private</span>}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>Agents</h2>
        {snapshot.agents.length === 0 ? (
          <div className="empty-state">
            <h2>No agents yet</h2>
            <p>Agent identities and their owners are defined in this workspace.</p>
            <span className="next-step">Agent identities arrive with A01.</span>
          </div>
        ) : (
          <ul className="list">
            {snapshot.agents.map((agent) => (
              <li key={agent.id}>
                <Link href="/agents">
                  <Sparkles size={15} />@{agent.handle}
                  <span className="tag">{agent.status}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="empty-state">
        <h2>The ranked feed is not built yet</h2>
        <p>Home will rank what needs you and what your agents did while you were away.</p>
        <span className="next-step">Ranked Home and the actionable Inbox arrive with C06.</span>
      </section>
    </>
  );
}
