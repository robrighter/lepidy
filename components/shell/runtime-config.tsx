"use client";

import { Cloud, Laptop, Send, Terminal } from "lucide-react";
import { useActionState } from "react";

import {
  connectCloudRuntimeAction,
  connectCustomRuntimeAction,
  createCloudScheduleAction,
  proveCloudResourcesAction,
  reaffirmDelegationAction,
  requestLocalReviewAction,
  selectRuntimeAction,
  setLocalPolicyAction,
  setRunBudgetAction,
  startManualRunAction,
  startRuntimeAction,
  stopRuntimeAction,
  withdrawLocalReviewAction,
  type RuntimeResult,
} from "@/app/(app)/agents/[agent]/runtime/actions";
import type { AgentRuntimeView } from "@/src/cloudflare/workspace";
import {
  describeRun,
  expiryPhrase,
  formatMoney,
  LOCAL_PRESET_INTENTS,
  localPresetIntentLabel,
  type RuntimeKind,
} from "@/src/domain/runtime-config";

/**
 * The runtime screen.
 *
 * The whole page is one client component because every part of it moves
 * together: choosing a runtime changes which panel is real, and every write
 * returns the view it produced so the panels below re-render from the answer
 * rather than from a stale render. Each form is a genuine `<form action>`, so a
 * stop pressed before hydration is carried out rather than lost — which is the
 * property that matters most on the one page in this product whose buttons
 * reach a process on somebody's own computer.
 *
 * The one thing this file cannot do, anywhere, is edit launch configuration.
 * There is no input for a program, an argument, a working directory, an
 * environment value or a limit, because those live on the machine and the only
 * remote authority over them is asking for them to be looked at (D05a).
 */

const RUNTIME_CHOICES: readonly {
  kind: RuntimeKind;
  title: string;
  attended: string;
  blurb: string;
  Icon: typeof Terminal;
}[] = [
  {
    kind: "connected",
    title: "Connected",
    attended: "A person is at the keyboard",
    blurb: "Works while an owner has Claude Code — or any MCP client — open. Its authority is that person's own, re-checked on every call.",
    Icon: Terminal,
  },
  {
    kind: "local",
    title: "Local session",
    attended: "Nobody is at the keyboard",
    blurb: "A mention starts a harness on a machine you run, in a directory you chose, with your repos and your toolchain.",
    Icon: Laptop,
  },
  {
    kind: "claude_cloud",
    title: "Claude Cloud",
    attended: "Nobody is at the keyboard",
    blurb: "Anthropic runs it, inside your own organization. The only runtime that can keep a schedule with every laptop shut.",
    Icon: Cloud,
  },
  {
    kind: "custom",
    title: "Custom",
    attended: "Nobody is at the keyboard",
    blurb: "Your webhook, your loop. Lepidy supplies the queue, the identity and the credentials.",
    Icon: Send,
  },
];

export function RuntimeScreen({
  initial,
  csrfToken,
  origin,
  workspaceSlug,
  deviceLabel,
}: {
  initial: AgentRuntimeView;
  csrfToken: string;
  origin: string;
  workspaceSlug: string;
  /** What the machine's owner called it, when the control plane knows. */
  deviceLabel: string | null;
}) {
  const [state, selectRuntime, selecting] = useActionState<RuntimeResult | null, FormData>(
    selectRuntimeAction,
    null,
  );
  const runtime = state?.runtime ?? initial;

  return (
    <>
      <section className="panel">
        <h2>How this agent runs</h2>
        <p className="runtime-lede">
          The question is not where the model runs. It is whether a person is at the keyboard, because
          that decides where the agent&rsquo;s authority comes from. Lepidy never runs the loop.
        </p>

        <form action={selectRuntime} className="runtime-choices">
          <input type="hidden" name="csrfToken" value={csrfToken} />
          <input type="hidden" name="agentId" value={runtime.agentId} />
          <fieldset>
            <legend className="visually-hidden">Runtime</legend>
            {RUNTIME_CHOICES.map((choice) => {
              const selectable = choice.kind === "connected" || choice.kind === "local";
              const current = runtime.kind === choice.kind;
              return (
                <label
                  key={choice.kind}
                  className="runtime-choice"
                  data-current={current ? "yes" : "no"}
                  data-selectable={selectable ? "yes" : "no"}
                >
                  <input
                    type="radio"
                    name="kind"
                    value={choice.kind}
                    defaultChecked={current}
                    disabled={!selectable}
                  />
                  <span className="runtime-choice-body">
                    <span className="runtime-choice-title">
                      <choice.Icon size={15} aria-hidden="true" />
                      {choice.title}
                    </span>
                    <span className="runtime-attended">{choice.attended}</span>
                    <span className="runtime-choice-blurb">{choice.blurb}</span>
                    {selectable ? null : (
                      <span className="runtime-choice-note">
                        {current ? "Configured below." : "Set this up in its own panel below."}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </fieldset>
          <button type="submit" className="primary" disabled={selecting}>
            Use this runtime
          </button>
          <ResultLine result={state} />
        </form>
      </section>

      <Delegation runtime={runtime} csrfToken={csrfToken} />

      {runtime.kind === "connected" ? <ConnectedPanel origin={origin} workspaceSlug={workspaceSlug} /> : null}
      {runtime.kind === "local" ? (
        <LocalPanel runtime={runtime} csrfToken={csrfToken} deviceLabel={deviceLabel} />
      ) : null}
      {runtime.kind === "claude_cloud" || runtime.cloud !== null ? (
        <CloudPanel runtime={runtime} csrfToken={csrfToken} origin={origin} />
      ) : null}
      {runtime.kind === "custom" || runtime.custom !== null ? (
        <CustomPanel runtime={runtime} csrfToken={csrfToken} />
      ) : null}

      {runtime.kind === "claude_cloud" || runtime.kind === "custom" ? null : (
        <UnconfiguredProviders runtime={runtime} csrfToken={csrfToken} origin={origin} />
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* The sentence                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The delegation, restated in English.
 *
 * A permission nobody can restate is a permission nobody is supervising, so it
 * is the loudest thing on the page rather than a row in a table of fields. An
 * unattended runtime with no delegation is not "unconfigured": it is an agent
 * that cannot act, and it says so in those words.
 */
function Delegation({ runtime, csrfToken }: { runtime: AgentRuntimeView; csrfToken: string }) {
  const [state, reaffirm, pending] = useActionState<RuntimeResult | null, FormData>(
    reaffirmDelegationAction,
    null,
  );
  const delegation = state?.runtime?.delegation ?? runtime.delegation;
  const attended = runtime.kind === "connected";

  if (attended) {
    return (
      <section className="panel runtime-authority" aria-labelledby="runtime-authority-heading">
        <h2 id="runtime-authority-heading">Where its authority comes from</h2>
        <p className="runtime-sentence">Runs as whichever owner has an MCP client open, and only while they do.</p>
        <p className="runtime-authority-note">
          No delegation is needed, because nothing acts unless a person is there. Every call is checked
          against that person&rsquo;s own access at the moment it is made.
        </p>
      </section>
    );
  }

  if (delegation === null) {
    return (
      <section className="panel runtime-authority" data-tone="alert" aria-labelledby="runtime-authority-heading">
        <h2 id="runtime-authority-heading">Where its authority comes from</h2>
        <p className="runtime-sentence">Nowhere yet. This agent has no live delegation, so it cannot act.</p>
        <p className="runtime-authority-note">
          An unattended agent runs under a delegation: an owner, the rooms it may work in, the credentials
          it may ask for, an expiry and a spend cap. It can never exceed what that owner can do themselves,
          and it collapses the moment they lose access.
        </p>
      </section>
    );
  }

  const remaining = expiryPhrase(delegation.expiresAt, Date.now());
  const expiringSoon = delegation.expiresAt - Date.now() < 7 * 86_400_000;

  return (
    <section
      className="panel runtime-authority"
      data-tone={expiringSoon ? "warn" : "ok"}
      aria-labelledby="runtime-authority-heading"
    >
      <h2 id="runtime-authority-heading">Where its authority comes from</h2>
      <p className="runtime-sentence">{delegation.sentence}</p>
      <p className="runtime-authority-note">
        {remaining === "expired" ? "This has expired." : `${remaining}.`} It is re-resolved on every call:
        if @{delegation.ownerHandle} loses a room, the agent loses it the same turn. Ask-every-time
        credentials still ask — an unattended agent gets a card marked unattended, and it waits.
      </p>
      <form action={reaffirm} className="runtime-inline-form">
        <input type="hidden" name="csrfToken" value={csrfToken} />
        <input type="hidden" name="agentId" value={runtime.agentId} />
        <input type="hidden" name="delegationId" value={delegation.id} />
        <button type="submit" disabled={pending}>
          Re-affirm for another 30 days
        </button>
      </form>
      <ResultLine result={state} />
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Connected                                                                   */
/* -------------------------------------------------------------------------- */

function ConnectedPanel({ origin, workspaceSlug }: { origin: string; workspaceSlug: string }) {
  return (
    <section className="panel">
      <h2>Nothing to configure</h2>
      <p>
        This agent works whenever an owner has an MCP client connected to Lepidy. Point one at this
        workspace and it can read the agent&rsquo;s queue and post under its identity.
      </p>
      <pre className="runtime-command">
        <code>{`claude mcp add lepidy ${origin}/w/${workspaceSlug}/mcp`}</code>
      </pre>
      <p className="runtime-note">
        Close the client and the agent stops. That is the trade: no machine to keep awake, no delegation
        to expire, and no work while nobody is there.
      </p>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Local                                                                       */
/* -------------------------------------------------------------------------- */

function LocalPanel({
  runtime,
  csrfToken,
  deviceLabel,
}: {
  runtime: AgentRuntimeView;
  csrfToken: string;
  deviceLabel: string | null;
}) {
  const [policyState, savePolicy, savingPolicy] = useActionState<RuntimeResult | null, FormData>(
    setLocalPolicyAction,
    null,
  );
  const [controlState, control, controlling] = useActionState<RuntimeResult | null, FormData>(
    startRuntimeAction,
    null,
  );
  const [stopState, stop, stopping] = useActionState<RuntimeResult | null, FormData>(stopRuntimeAction, null);
  const current = stopState?.runtime ?? controlState?.runtime ?? policyState?.runtime ?? runtime;
  const local = current.local;
  const device = local.device;
  // The name somebody gave the machine, and the id the product acts on. Shown
  // together rather than one instead of the other: a name is how a person finds
  // the right laptop, and the id is what a wake is addressed to.
  const machine = deviceLabel ?? device?.deviceId ?? "that machine";

  return (
    <>
      {device === null ? (
        <section className="panel runtime-warning" role="status">
          <h2>No machine answers for @{current.handle} yet</h2>
          <p>
            A runner opts in per agent, on the machine, once — in the Lepidy desktop app or with{" "}
            <code>lepidy-agentd register</code> on that computer. Until then nothing starts, and a mention
            waits in the queue.
          </p>
          <p className="runtime-note">
            It cannot be done from here, and that is the point: a wake carries an agent id and nothing
            else, so a compromised server could not make a machine run something it does not already
            permit.
          </p>
        </section>
      ) : (
        <section className="panel">
          <div className="panel-head">
            <h2>Where it runs</h2>
            <span className={device.connected ? "tag runtime-online" : "tag runtime-offline"}>
              {device.connected ? "online" : "offline"}
            </span>
          </div>
          <dl className="vault-facts">
            <dt>Machine</dt>
            <dd>
              <strong>{machine}</strong> <code>{device.deviceId}</code>
              {device.lastSeenAt === null ? null : (
                <span className="via">
                  {" "}
                  · last seen{" "}
                  <time dateTime={new Date(device.lastSeenAt).toISOString()}>
                    {new Date(device.lastSeenAt).toISOString()}
                  </time>
                </span>
              )}
            </dd>
            <dt>Local preset</dt>
            <dd>
              <code>{device.presetId}</code> <span className="via">· revision {device.presetRevision}</span>
            </dd>
            <dt>Launch configuration</dt>
            <dd className="runtime-hidden-config">
              Stored only on {machine} · unavailable to remote clients
            </dd>
            <dt>Waiting</dt>
            <dd>
              {local.waiting} {local.waiting === 1 ? "item" : "items"}
              {local.needsAttention > 0 ? (
                <>
                  {" "}
                  · <strong className="runtime-attention">{local.needsAttention} needs attention</strong>
                </>
              ) : null}
            </dd>
          </dl>
          <p className="runtime-note">
            The executable, arguments, working directory, environment mapping and limits are created and
            edited only on that computer, behind an operating-system verification gesture. Lepidy can name
            a preset this machine already holds; it can never send or edit a command, path, argument,
            environment value, permission mode or resource limit.
          </p>

          <div className="runtime-controls">
            <form action={control}>
              <input type="hidden" name="csrfToken" value={csrfToken} />
              <input type="hidden" name="agentId" value={current.agentId} />
              <button type="submit" disabled={controlling}>
                Start a session now
              </button>
            </form>
            <form action={stop}>
              <input type="hidden" name="csrfToken" value={csrfToken} />
              <input type="hidden" name="agentId" value={current.agentId} />
              <button type="submit" className="danger" disabled={stopping}>
                Stop everything
              </button>
            </form>
          </div>
          <ResultLine result={controlState} />
          <ResultLine result={stopState} />
        </section>
      )}

      {local.needsAttention > 0 ? (
        <section className="panel runtime-warning" role="status">
          <h2>
            {local.needsAttention} {local.needsAttention === 1 ? "item is" : "items are"} waiting on a person
          </h2>
          <p>
            A run stopped without finishing what it had claimed — usually a harness blocked by its own
            permission posture. That is a decision waiting to be made, not a failure to retry, so the work
            sits where an owner will find it rather than being run again to be blocked again.
          </p>
        </section>
      ) : null}

      <LocalReviewRequests
        runtime={current}
        csrfToken={csrfToken}
        requests={local.presetRequests}
        machine={machine}
      />

      <section className="panel">
        <h2>Who may start a session</h2>
        <p className="runtime-note">
          This decides who can cause a process to run on <strong>{machine}</strong>.
          It does not decide what runs, and it cannot loosen anything the machine already refuses.
        </p>
        <form action={savePolicy} className="runtime-form">
          <input type="hidden" name="csrfToken" value={csrfToken} />
          <input type="hidden" name="agentId" value={current.agentId} />
          <label className="runtime-switch">
            <input type="checkbox" name="startOnMention" defaultChecked={local.startOnMention} />
            <span>
              <strong>Start on mention</strong>
              <em>Off means the agent only works when an owner starts it by hand. Mentions still queue.</em>
            </span>
          </label>
          <label className="runtime-field">
            <span>Who may start it</span>
            <select name="whoMayStart" defaultValue={local.whoMayStart}>
              <option value="scope">Anyone in the agent&rsquo;s rooms</option>
              <option value="owners">Owners only</option>
            </select>
          </label>
          <button type="submit" className="primary" disabled={savingPolicy}>
            Save
          </button>
        </form>
        <ResultLine result={policyState} />
      </section>

      <LocalSessions runtime={current} />

      <section className="panel runtime-risk">
        <h2>What this actually allows</h2>
        <p>
          A mention starts a real process on a real machine, under the full authority of the operating-system
          user running the runner. Lepidy bounds <em>when</em> a session starts, <em>where</em>, and{" "}
          <em>which credentials</em> it can obtain. It does not sandbox what the harness does once it is
          running — that is the harness&rsquo;s permission mode and the operating system. Point a runner at
          a container or a VM if you need a tighter box.
        </p>
      </section>
    </>
  );
}

/**
 * The pending asks, and why they stay pending.
 *
 * This is the honest shape of remote authority over a local preset: an owner
 * can ask, and then wait. Nothing here clears itself on a timer or on an
 * optimistic guess — the row moves to confirmed only when that machine signs a
 * registration carrying a higher preset revision, which is the only evidence
 * available here that somebody was actually standing at that computer.
 */
function LocalReviewRequests({
  runtime,
  csrfToken,
  requests,
  machine,
}: {
  runtime: AgentRuntimeView;
  csrfToken: string;
  requests: AgentRuntimeView["local"]["presetRequests"];
  machine: string;
}) {
  const [askState, ask, asking] = useActionState<RuntimeResult | null, FormData>(
    requestLocalReviewAction,
    null,
  );
  const [withdrawState, withdraw, withdrawing] = useActionState<RuntimeResult | null, FormData>(
    withdrawLocalReviewAction,
    null,
  );
  const live = withdrawState?.runtime?.local.presetRequests ?? askState?.runtime?.local.presetRequests ?? requests;
  const outstanding = live.filter((request) => request.state === "pending");
  const settled = live.filter((request) => request.state === "confirmed").slice(0, 5);

  return (
    <section className="panel" aria-labelledby="runtime-review-heading">
      <h2 id="runtime-review-heading">Changes only that machine can make</h2>
      <p className="runtime-note">
        Ask, and then wait. A request stays pending here until <strong>{machine}</strong> reports a preset
        revision higher than the one it had when you asked — which happens after somebody at that computer
        completes the operating-system verification the change needs.
      </p>

      {outstanding.length === 0 ? (
        <p className="vault-empty">Nothing is pending on that machine.</p>
      ) : (
        <ul className="runtime-requests">
          {outstanding.map((request) => (
            <li key={request.id} data-state="pending">
              <div>
                <strong>{localPresetIntentLabel(request.intent)}</strong>
                <p>
                  Asked by @{request.requestedByHandle} at revision {request.revisionAtRequest}.{" "}
                  <span className="runtime-attention">Pending on the machine.</span>
                </p>
              </div>
              <form action={withdraw}>
                <input type="hidden" name="csrfToken" value={csrfToken} />
                <input type="hidden" name="agentId" value={runtime.agentId} />
                <input type="hidden" name="requestId" value={request.id} />
                <button type="submit" disabled={withdrawing}>
                  Withdraw
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}

      <form action={ask} className="runtime-form">
        <input type="hidden" name="csrfToken" value={csrfToken} />
        <input type="hidden" name="agentId" value={runtime.agentId} />
        <label className="runtime-field">
          <span>Ask that machine to</span>
          <select name="intent" defaultValue={LOCAL_PRESET_INTENTS[0]}>
            {LOCAL_PRESET_INTENTS.map((intent) => (
              <option key={intent} value={intent}>
                {localPresetIntentLabel(intent)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={asking}>
          Send the request
        </button>
      </form>
      <ResultLine result={askState} />
      <ResultLine result={withdrawState} />

      {settled.length === 0 ? null : (
        <>
          <h3 className="runtime-subhead">Confirmed by the machine</h3>
          <ul className="runtime-requests">
            {settled.map((request) => (
              <li key={request.id} data-state="confirmed">
                <div>
                  <strong>{localPresetIntentLabel(request.intent)}</strong>
                  <p>
                    Confirmed at revision {request.resolvedRevision ?? "—"}
                    {request.resolvedAt === null ? null : (
                      <>
                        {" "}
                        on{" "}
                        <time dateTime={new Date(request.resolvedAt).toISOString()}>
                          {new Date(request.resolvedAt).toISOString()}
                        </time>
                      </>
                    )}
                    .
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function LocalSessions({ runtime }: { runtime: AgentRuntimeView }) {
  if (runtime.sessions.length === 0) {
    return (
      <section className="panel">
        <h2>Recent sessions</h2>
        <p className="vault-empty">No session has started yet.</p>
      </section>
    );
  }
  return (
    <section className="panel">
      <h2>Recent sessions</h2>
      <div className="table-scroll">
        <table className="vault-table">
          <caption className="visually-hidden">Harness sessions started for this agent</caption>
          <thead>
            <tr>
              <th scope="col">Started</th>
              <th scope="col">Machine</th>
              <th scope="col">Preset</th>
              <th scope="col">Ended</th>
              <th scope="col">How</th>
            </tr>
          </thead>
          <tbody>
            {runtime.sessions.map((session) => (
              <tr key={session.sessionId} data-live={session.live ? "yes" : "no"}>
                <td data-label="Started">
                  <time dateTime={new Date(session.startedAt).toISOString()}>
                    {new Date(session.startedAt).toISOString()}
                  </time>
                </td>
                <td data-label="Machine">
                  <code>{session.deviceId}</code>
                </td>
                <td data-label="Preset">revision {session.presetRevision}</td>
                <td data-label="Ended">
                  {session.live ? (
                    <span className="tag runtime-online">live now</span>
                  ) : session.endedAt === null ? (
                    "expired"
                  ) : (
                    <time dateTime={new Date(session.endedAt).toISOString()}>
                      {new Date(session.endedAt).toISOString()}
                    </time>
                  )}
                </td>
                <td data-label="How">{session.endedReason ?? (session.live ? "working" : "ran to its ceiling")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="runtime-note">
        A session is kept and reused across mentions, because starting a harness is the expensive part. It
        ends at the delegation&rsquo;s expiry, the eight-hour ceiling, or whenever somebody stops it.
      </p>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Claude Cloud                                                                */
/* -------------------------------------------------------------------------- */

function CloudPanel({
  runtime,
  csrfToken,
  origin,
}: {
  runtime: AgentRuntimeView;
  csrfToken: string;
  origin: string;
}) {
  const [connectState, connect, connecting] = useActionState<RuntimeResult | null, FormData>(
    connectCloudRuntimeAction,
    null,
  );
  const [proveState, prove, proving] = useActionState<RuntimeResult | null, FormData>(
    proveCloudResourcesAction,
    null,
  );
  const [scheduleState, schedule, scheduling] = useActionState<RuntimeResult | null, FormData>(
    createCloudScheduleAction,
    null,
  );
  const [runState, runNow, runningNow] = useActionState<RuntimeResult | null, FormData>(
    startManualRunAction,
    null,
  );
  const current =
    runState?.runtime ?? scheduleState?.runtime ?? proveState?.runtime ?? connectState?.runtime ?? runtime;
  const cloud = current.cloud;

  return (
    <>
      <section className="panel">
        <h2>Connection</h2>
        <p className="runtime-note">
          This agent runs in your Anthropic organization, not ours. Lepidy holds the identity, the queue,
          the scope and the credentials; Anthropic holds the compute and the bill. Authorization is
          Workload Identity Federation from one exact Lepidy subject — no Anthropic API key is accepted
          here, personal or otherwise.
        </p>

        {cloud === null ? null : (
          <>
            <dl className="vault-facts">
              <dt>Setup</dt>
              <dd>
                <span className={current.providerStatus === "active" ? "tag runtime-online" : "tag runtime-pending"}>
                  {current.providerStatus === "active" ? "complete" : (current.providerStatus ?? "pending")}
                </span>
              </dd>
              <dt>Resources read</dt>
              <dd>{cloud.resourceProvedAt === null ? "not yet" : new Date(cloud.resourceProvedAt).toISOString()}</dd>
              <dt>Signed event received</dt>
              <dd>{cloud.webhookProvedAt === null ? "not yet" : new Date(cloud.webhookProvedAt).toISOString()}</dd>
              <dt>Managed agent</dt>
              <dd>
                <code>{cloud.providerAgentId ?? "—"}</code>
              </dd>
              <dt>Environment</dt>
              <dd>
                <code>{cloud.providerEnvironmentId ?? "—"}</code>
              </dd>
              <dt>Federation subject</dt>
              <dd>
                <code>{cloud.wifSubject ?? "—"}</code>
              </dd>
              <dt>Cap per run</dt>
              <dd>{cloud.budgetCents === null ? "—" : formatMoney(cloud.budgetCents)}</dd>
              {cloud.wifFailures > 0 ? (
                <>
                  <dt>Recent authorization failures</dt>
                  <dd className="runtime-attention">{cloud.wifFailures}</dd>
                </>
              ) : null}
            </dl>
            <form action={prove} className="runtime-inline-form">
              <input type="hidden" name="csrfToken" value={csrfToken} />
              <input type="hidden" name="agentId" value={current.agentId} />
              <button type="submit" disabled={proving}>
                Check the connection now
              </button>
            </form>
            <ResultLine result={proveState} />
          </>
        )}

        <h3 className="runtime-subhead">The step we cannot do for you</h3>
        <p className="runtime-note">
          Add this endpoint in the Anthropic Console under Webhooks, subscribe to the <code>session.*</code>,{" "}
          <code>deployment.*</code> and <code>deployment_run.*</code> events, and paste the signing secret
          below — it is shown there exactly once. Events emitted while a type was unsubscribed are never
          backfilled, so the subscription list is part of setup rather than something to add later.
        </p>
        <pre className="runtime-command">
          <code>{`${origin}/hooks/anthropic`}</code>
        </pre>

        <form action={connect} className="runtime-form runtime-form-grid">
          <input type="hidden" name="csrfToken" value={csrfToken} />
          <input type="hidden" name="agentId" value={current.agentId} />
          <label className="runtime-field">
            <span>Organization id</span>
            <input name="organizationId" defaultValue={cloud?.organizationId ?? ""} placeholder="org_…" />
          </label>
          <label className="runtime-field">
            <span>Anthropic workspace id</span>
            <input name="providerWorkspaceId" defaultValue={cloud?.providerWorkspaceId ?? ""} placeholder="wrkspc_…" />
          </label>
          <label className="runtime-field">
            <span>Managed agent id</span>
            <input name="providerAgentId" defaultValue={cloud?.providerAgentId ?? ""} placeholder="agent_…" />
          </label>
          <label className="runtime-field">
            <span>Environment id</span>
            <input name="providerEnvironmentId" defaultValue={cloud?.providerEnvironmentId ?? ""} placeholder="env_…" />
          </label>
          <label className="runtime-field">
            <span>Federation issuer</span>
            <input name="issuer" type="url" defaultValue="https://lepidy.app" placeholder="https://…" />
          </label>
          <label className="runtime-field">
            <span>Federation audience</span>
            <input name="audience" defaultValue={cloud?.wifAudience ?? ""} placeholder="https://api.anthropic.com" />
          </label>
          <label className="runtime-field">
            <span>Federation subject</span>
            <input name="subject" defaultValue={cloud?.wifSubject ?? ""} placeholder="exact, no wildcards" />
            <em>Wildcards are refused. This names one integration and nothing wider.</em>
          </label>
          <label className="runtime-field">
            <span>Service account id</span>
            <input name="serviceAccountId" placeholder="svcacct_…" />
          </label>
          <label className="runtime-field">
            <span>Federation rule id</span>
            <input name="federationRuleId" placeholder="fedrule_…" />
          </label>
          <label className="runtime-field">
            <span>Webhook signing secret</span>
            <input name="webhookSigningSecret" type="password" placeholder="whsec_…" autoComplete="off" />
            <em>A transport secret for verifying deliveries. Never an agent or account credential.</em>
          </label>
          <label className="runtime-field">
            <span>Cap per run</span>
            <input
              name="budget"
              inputMode="decimal"
              defaultValue={cloud?.budgetCents === undefined || cloud?.budgetCents === null ? "5.00" : (cloud.budgetCents / 100).toFixed(2)}
            />
            <em>Dollars. A hard, platform-enforced ceiling — the run stops at it.</em>
          </label>
          <button type="submit" className="primary" disabled={connecting}>
            Save the connection
          </button>
        </form>
        <ResultLine result={connectState} />
      </section>

      <section className="panel">
        <h2>When it runs</h2>
        <p className="runtime-note">
          A mention starts a session with the mention as its opening message. A schedule fires one on its
          own, which is the thing no laptop can do. Firing is spread out by up to nine minutes to level
          load, so a schedule is never a deadline — and daylight saving is matched literally, so a time
          that does not exist on the spring-forward day is skipped and one that happens twice fires twice.
          Avoid 01:00–03:00 local, or use UTC.
        </p>
        <form action={schedule} className="runtime-form runtime-form-grid">
          <input type="hidden" name="csrfToken" value={csrfToken} />
          <input type="hidden" name="agentId" value={current.agentId} />
          <label className="runtime-field">
            <span>Cron</span>
            <input name="cron" defaultValue="0 4 * * *" placeholder="0 4 * * *" />
            <em>Five POSIX fields.</em>
          </label>
          <label className="runtime-field">
            <span>Time zone</span>
            <input name="timezone" defaultValue="UTC" placeholder="America/New_York" />
          </label>
          <label className="runtime-field">
            <span>Cap per scheduled run</span>
            <input name="budget" inputMode="decimal" defaultValue="5.00" />
          </label>
          <button type="submit" disabled={scheduling}>
            Save the schedule
          </button>
        </form>
        <ResultLine result={scheduleState} />

        <form action={runNow} className="runtime-form runtime-form-inline">
          <input type="hidden" name="csrfToken" value={csrfToken} />
          <input type="hidden" name="agentId" value={current.agentId} />
          <label className="runtime-field">
            <span>Cap for this run</span>
            <input name="budget" inputMode="decimal" defaultValue="5.00" />
          </label>
          <button type="submit" disabled={runningNow}>
            Run it now
          </button>
          <p className="runtime-note">
            Works even while a deployment is paused, which makes it the way to test a schedule before
            trusting it. A deployment&rsquo;s budget applies from the next fired session, never to one
            already running.
          </p>
        </form>
        <ResultLine result={runState} />
      </section>

      <RunHistory runtime={current} csrfToken={csrfToken} />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Custom                                                                      */
/* -------------------------------------------------------------------------- */

function CustomPanel({ runtime, csrfToken }: { runtime: AgentRuntimeView; csrfToken: string }) {
  const [state, connect, connecting] = useActionState<RuntimeResult | null, FormData>(
    connectCustomRuntimeAction,
    null,
  );
  const current = state?.runtime ?? runtime;
  const custom = current.custom;

  return (
    <section className="panel">
      <h2>Your webhook</h2>
      <p className="runtime-note">
        One public HTTPS endpoint and a shared signing secret. The wake it receives is metadata only — a
        delivery id, a workspace, an agent and a queue depth — and your runtime claims and posts through a
        delegation-scoped MCP session like every other runtime. An address that resolves to a private
        network is refused, and a redirect is never followed.
      </p>

      {custom === null ? null : (
        <>
          <dl className="vault-facts">
            <dt>Endpoint</dt>
            <dd>
              <code>{custom.callbackUrl}</code>
            </dd>
            <dt>Status</dt>
            <dd>
              <span className={current.providerStatus === "active" ? "tag runtime-online" : "tag runtime-pending"}>
                {current.providerStatus ?? "pending"}
              </span>
            </dd>
          </dl>
          {custom.deliveries.length === 0 ? null : (
            <div className="table-scroll">
              <table className="vault-table">
                <caption className="visually-hidden">Recent wake deliveries</caption>
                <thead>
                  <tr>
                    <th scope="col">Queued</th>
                    <th scope="col">State</th>
                    <th scope="col">Attempts</th>
                    <th scope="col">Last error</th>
                  </tr>
                </thead>
                <tbody>
                  {custom.deliveries.map((delivery) => (
                    <tr key={delivery.deliveryId}>
                      <td data-label="Queued">
                        <time dateTime={new Date(delivery.createdAt).toISOString()}>
                          {new Date(delivery.createdAt).toISOString()}
                        </time>
                      </td>
                      <td data-label="State">
                        <span className={delivery.state === "dead" ? "tag runtime-failed" : "tag"}>
                          {delivery.state === "dead" ? "gave up" : delivery.state}
                        </span>
                      </td>
                      <td data-label="Attempts">{delivery.attempts}</td>
                      <td data-label="Last error">{delivery.lastError ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <form action={connect} className="runtime-form runtime-form-grid">
        <input type="hidden" name="csrfToken" value={csrfToken} />
        <input type="hidden" name="agentId" value={current.agentId} />
        <label className="runtime-field">
          <span>Endpoint</span>
          <input name="callbackUrl" type="url" defaultValue={custom?.callbackUrl ?? ""} placeholder="https://hooks.example.com/lepidy" />
        </label>
        <label className="runtime-field">
          <span>Signing secret</span>
          <input name="signingSecret" type="password" autoComplete="off" placeholder="at least 32 characters" />
          <em>Shared with your endpoint so it can verify the wake came from here. Stored encrypted.</em>
        </label>
        <button type="submit" className="primary" disabled={connecting}>
          Connect and send a test wake
        </button>
        <p className="runtime-note">
          Saving sends one signed test wake straight away. If it does not arrive with a 2xx, nothing is
          stored — a half-configured endpoint that fails at the first mention is worse than a refusal now.
        </p>
      </form>
      <ResultLine result={state} />
    </section>
  );
}

/**
 * The two runtimes that need a provider before they are a choice.
 *
 * Shown as their own setup panels rather than as radio buttons that silently do
 * nothing, because a runtime is not selected until the thing it points at has
 * been proved to exist.
 */
function UnconfiguredProviders({
  runtime,
  csrfToken,
  origin,
}: {
  runtime: AgentRuntimeView;
  csrfToken: string;
  origin: string;
}) {
  return (
    <details className="runtime-details">
      <summary>Set up Claude Cloud or a custom webhook instead</summary>
      <CloudPanel runtime={runtime} csrfToken={csrfToken} origin={origin} />
      <CustomPanel runtime={runtime} csrfToken={csrfToken} />
    </details>
  );
}

/* -------------------------------------------------------------------------- */
/* Run history                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Every attempt, including the ones that never started.
 *
 * A scheduled run that failed before it created a session still writes a row,
 * because a nightly job that quietly stopped working has to be noticed the next
 * morning rather than the next quarter. The failure reason is in plain words,
 * not a state name.
 */
function RunHistory({ runtime, csrfToken }: { runtime: AgentRuntimeView; csrfToken: string }) {
  const [state, setBudget, saving] = useActionState<RuntimeResult | null, FormData>(setRunBudgetAction, null);
  const runs = state?.runtime?.runs ?? runtime.runs;

  if (runs.length === 0) {
    return (
      <section className="panel">
        <h2>Run history</h2>
        <p className="vault-empty">Nothing has run yet.</p>
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>Run history</h2>
      <div className="table-scroll">
        <table className="vault-table">
          <caption className="visually-hidden">Every run attempted for this agent</caption>
          <thead>
            <tr>
              <th scope="col">Started</th>
              <th scope="col">Because</th>
              <th scope="col">Result</th>
              <th scope="col">Cap</th>
              <th scope="col">
                <span className="visually-hidden">Change the cap</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => {
              const described = describeRun(run);
              return (
                <tr key={run.id} data-tone={described.tone}>
                  <td data-label="Started">
                    <time dateTime={new Date(run.createdAt).toISOString()}>
                      {new Date(run.createdAt).toISOString()}
                    </time>
                  </td>
                  <td data-label="Because">{runReason(run.kind)}</td>
                  <td data-label="Result">
                    <span className={`tag runtime-${described.tone}`}>{described.label}</span>
                  </td>
                  <td data-label="Cap">{run.budgetCents === null ? "none" : formatMoney(run.budgetCents)}</td>
                  <td>
                    {run.hasProviderSession ? (
                      <form action={setBudget} className="runtime-budget-form">
                        <input type="hidden" name="csrfToken" value={csrfToken} />
                        <input type="hidden" name="agentId" value={runtime.agentId} />
                        <input type="hidden" name="runId" value={run.id} />
                        <label>
                          <span className="visually-hidden">New cap in dollars for this run</span>
                          <input name="budget" inputMode="decimal" placeholder="new cap" size={7} />
                        </label>
                        <button type="submit" disabled={saving}>
                          Apply
                        </button>
                      </form>
                    ) : (
                      <span className="via">no session</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="runtime-note">
        A run that stops at its cap says so in the room and can be resumed by replacing the cap with one
        above what it has already spent. Leaving the field empty removes the cap, which cannot be undone
        for that run.
      </p>
      <ResultLine result={state} />
    </section>
  );
}

function runReason(kind: AgentRuntimeView["runs"][number]["kind"]): string {
  switch (kind) {
    case "mention":
      return "Somebody mentioned it";
    case "scheduled":
      return "Schedule";
    case "manual":
      return "Started by hand";
  }
}

/* -------------------------------------------------------------------------- */

function ResultLine({ result }: { result: RuntimeResult | null }) {
  if (result === null) return null;
  const message = result.ok ? result.note : result.reason;
  if (!message) return null;
  return (
    <p className={result.ok ? "runtime-result" : "message-error"} role="status">
      {message}
    </p>
  );
}
