"use server";

import type { AgentRuntimeView } from "@/src/cloudflare/workspace";
import {
  defaultDelegationExpiry,
  isLocalPresetIntent,
  isLocalStartPolicy,
  parseBudgetDollars,
} from "@/src/domain/runtime-config";
import { isFailure, shellErrorReason, viewerWorkspace, type ViewerWorkspace } from "@/src/shell/viewer-workspace";

/**
 * Everything the runtime screen writes.
 *
 * Each one is a real `<form action>` posting to a server action, so a person who
 * hits stop, or withdraws a request, before React has hydrated has that carried
 * out rather than turned into a page reload. That matters more here than
 * anywhere else in the product: the actions on this page are the ones somebody
 * reaches for when they think something is wrong with a process running on
 * their own machine.
 *
 * Every one re-resolves the viewer through `viewerWorkspace`, so the session
 * cookie and the CSRF token decide who is asking and never anything the form
 * said about it, and each returns the view it produced so the page advances
 * from the answer rather than from a revalidation that would land after the
 * client had already applied it.
 *
 * **No action here edits launch configuration.** Not a hidden one, not a
 * privileged one, not one behind a flag. The only thing this file can say to a
 * machine about its own preset is that somebody would like it looked at, and
 * that stays pending until the machine itself says otherwise.
 */

export type RuntimeResult = {
  ok: boolean;
  reason?: string;
  note?: string;
  runtime?: AgentRuntimeView;
};

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * One shape for every write on this page: authorize, apply, re-read.
 *
 * The re-read runs on the failure path too. Somebody who has just been refused
 * is the person most likely to be looking at a page that no longer matches the
 * world, and handing them a stale view along with the refusal is how a second
 * wrong action gets taken.
 */
async function mutate(
  form: FormData,
  apply: (workspace: ViewerWorkspace, agentId: string) => Promise<string | undefined>,
): Promise<RuntimeResult> {
  const agentId = field(form, "agentId");
  const workspace = await viewerWorkspace(field(form, "csrfToken"));
  if (isFailure(workspace)) return { ok: false, reason: workspace.reason };

  const read = async (): Promise<AgentRuntimeView | undefined> => {
    try {
      return await workspace.stub.describeAgentRuntime({ actor: workspace.actor, agentId, now: Date.now() });
    } catch {
      return undefined;
    }
  };
  try {
    const note = await apply(workspace, agentId);
    return { ok: true, note, runtime: await read() };
  } catch (error) {
    return { ok: false, reason: shellErrorReason(error), runtime: await read() };
  }
}

/** Choose `connected` or `local`. Cloud and custom have their own setup. */
export async function selectRuntimeAction(
  _previous: RuntimeResult | null,
  form: FormData,
): Promise<RuntimeResult> {
  const kind = field(form, "kind");
  if (kind !== "connected" && kind !== "local") {
    return { ok: false, reason: "Pick either Connected or Local session." };
  }
  return mutate(form, async (workspace, agentId) => {
    await workspace.stub.selectAgentRuntime({ actor: workspace.actor, agentId, kind, now: Date.now() });
    return kind === "local"
      ? "This agent now runs on a machine you own."
      : "This agent now runs from an owner's own MCP client.";
  });
}

/** Who may cause a process to start, and whether a mention does it at all. */
export async function setLocalPolicyAction(
  _previous: RuntimeResult | null,
  form: FormData,
): Promise<RuntimeResult> {
  const whoMayStart = field(form, "whoMayStart");
  if (!isLocalStartPolicy(whoMayStart)) return { ok: false, reason: "Pick who may start a session." };
  const startOnMention = field(form, "startOnMention") === "on";
  return mutate(form, async (workspace, agentId) => {
    await workspace.stub.setLocalRuntimePolicy({
      actor: workspace.actor,
      agentId,
      startOnMention,
      whoMayStart,
      now: Date.now(),
    });
    return "Saved.";
  });
}

/** Ask the machine to look at its own preset. An ask, never a change. */
export async function requestLocalReviewAction(
  _previous: RuntimeResult | null,
  form: FormData,
): Promise<RuntimeResult> {
  const intent = field(form, "intent");
  if (!isLocalPresetIntent(intent)) return { ok: false, reason: "That is not something a machine can be asked." };
  return mutate(form, async (workspace, agentId) => {
    await workspace.stub.requestLocalPresetChange({ actor: workspace.actor, agentId, intent, now: Date.now() });
    return "Asked. It stays pending until that machine confirms it.";
  });
}

export async function withdrawLocalReviewAction(
  _previous: RuntimeResult | null,
  form: FormData,
): Promise<RuntimeResult> {
  const requestId = field(form, "requestId");
  return mutate(form, async (workspace) => {
    await workspace.stub.withdrawLocalPresetChange({ actor: workspace.actor, requestId, now: Date.now() });
    return "Withdrawn.";
  });
}

/** Start a session by hand — the same wake a mention makes, and nothing more. */
export async function startRuntimeAction(
  _previous: RuntimeResult | null,
  form: FormData,
): Promise<RuntimeResult> {
  return mutate(form, async (workspace, agentId) => {
    const started = await workspace.stub.startLocalRuntimeNow({
      actor: workspace.actor,
      agentId,
      now: Date.now(),
    });
    return started.delivered
      ? `Told ${started.deviceId} to start a session.`
      : `${started.deviceId} is offline. It will start when the machine is back.`;
  });
}

/** Stop everything this agent has running, everywhere. */
export async function stopRuntimeAction(
  _previous: RuntimeResult | null,
  form: FormData,
): Promise<RuntimeResult> {
  return mutate(form, async (workspace, agentId) => {
    const stopped = await workspace.stub.stopAgentRuntime({
      actor: workspace.actor,
      agentId,
      reason: "stopped_from_runtime_page",
      now: Date.now(),
    });
    return stopped.sessionsStopped === 0
      ? "Nothing was running. The machine was told to stop anyway."
      : `Stopped ${stopped.sessionsStopped} ${stopped.sessionsStopped === 1 ? "session" : "sessions"}.`;
  });
}

/** One click, and it is deliberately a click rather than an automatic renewal. */
export async function reaffirmDelegationAction(
  _previous: RuntimeResult | null,
  form: FormData,
): Promise<RuntimeResult> {
  const delegationId = field(form, "delegationId");
  return mutate(form, async (workspace) => {
    const now = Date.now();
    const affirmed = await workspace.stub.reaffirmAgentDelegation({
      actor: workspace.actor,
      delegationId,
      expiresAt: defaultDelegationExpiry(now),
      now,
    });
    return `Re-affirmed. It now runs until ${new Date(affirmed.expiresAt).toISOString().slice(0, 10)}.`;
  });
}

/**
 * Raise or remove the cap on one cloud run.
 *
 * An empty field removes the cap, and the wording says so plainly, because
 * removing a session cap is one-way at the provider and a person should not
 * discover that afterwards.
 */
export async function setRunBudgetAction(
  _previous: RuntimeResult | null,
  form: FormData,
): Promise<RuntimeResult> {
  const runId = field(form, "runId");
  const raw = field(form, "budget").trim();
  const parsed = raw.length === 0 ? null : parseBudgetDollars(raw);
  if (parsed !== null && "error" in parsed) return { ok: false, reason: parsed.error };
  return mutate(form, async (workspace) => {
    await workspace.stub.updateClaudeSessionBudget({
      actor: workspace.actor,
      runId,
      nextBudgetCents: parsed === null ? null : parsed.cents,
      consumedCents: 0,
      now: Date.now(),
    });
    return parsed === null
      ? "Cap removed for this run. Removing a session cap cannot be undone."
      : "New cap applied to this run.";
  });
}

/* -------------------------------------------------------------------------- */
/* Claude Cloud                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The manual Console step, made into a form instead of pretended away.
 *
 * Anthropic has no API for registering a webhook endpoint and shows the signing
 * secret exactly once, so connecting a workspace has a step a person performs
 * by hand. This form collects what they were shown there; nothing here is an
 * Anthropic API key, and the v1 flow refuses one. The signing secret is a
 * transport secret for the raw-body verifier and is stored envelope-encrypted —
 * it is never a credential belonging to an agent or a person.
 *
 * Setup stays `pending` until both proofs land, which is the whole point: a
 * half-configured integration that looks finished fails silently at 03:00.
 */
export async function connectCloudRuntimeAction(
  _previous: RuntimeResult | null,
  form: FormData,
): Promise<RuntimeResult> {
  const budget = parseBudgetDollars(field(form, "budget"));
  if ("error" in budget) return { ok: false, reason: budget.error };
  return mutate(form, async (workspace, agentId) => {
    await workspace.stub.configureClaudeRuntime({
      actor: workspace.actor,
      agentId,
      authority: {
        issuer: field(form, "issuer"),
        audience: field(form, "audience"),
        subject: field(form, "subject"),
        organizationId: field(form, "organizationId"),
        workspaceId: field(form, "providerWorkspaceId"),
        serviceAccountId: field(form, "serviceAccountId"),
        federationRuleId: field(form, "federationRuleId"),
      },
      providerAgentId: field(form, "providerAgentId"),
      providerEnvironmentId: field(form, "providerEnvironmentId"),
      webhookSigningSecret: field(form, "webhookSigningSecret"),
      budgetCents: budget.cents,
      now: Date.now(),
    });
    return "Saved. Setup stays pending until the resources are read and a signed event arrives.";
  });
}

/** Prove the exact configured agent and environment exist, over WIF. */
export async function proveCloudResourcesAction(
  _previous: RuntimeResult | null,
  form: FormData,
): Promise<RuntimeResult> {
  return mutate(form, async (workspace, agentId) => {
    const proved = await workspace.stub.proveClaudeRuntimeResources({
      actor: workspace.actor,
      agentId,
      now: Date.now(),
    });
    return proved.status === "active"
      ? "Read both resources. Setup is complete."
      : "Read both resources. Still waiting for a signed webhook delivery.";
  });
}

/**
 * A cron expression and an IANA timezone, and the fire times read back.
 *
 * The times come from the deployment rather than from anything computed here,
 * so what the form shows is what the provider actually scheduled.
 */
export async function createCloudScheduleAction(
  _previous: RuntimeResult | null,
  form: FormData,
): Promise<RuntimeResult> {
  const budget = parseBudgetDollars(field(form, "budget"));
  if ("error" in budget) return { ok: false, reason: budget.error };
  return mutate(form, async (workspace, agentId) => {
    const schedule = await workspace.stub.createClaudeSchedule({
      actor: workspace.actor,
      agentId,
      cron: field(form, "cron"),
      timezone: field(form, "timezone"),
      budgetCents: budget.cents,
      now: Date.now(),
    });
    const upcoming = schedule.upcomingRunsAt.slice(0, 3);
    return upcoming.length === 0
      ? "Scheduled. The provider reported no upcoming times yet."
      : `Scheduled. Next: ${upcoming.join(", ")}. Firing is spread out by up to nine minutes, so read these as "about then".`;
  });
}

/** Works while a deployment is paused, which is what makes it the test button. */
export async function startManualRunAction(
  _previous: RuntimeResult | null,
  form: FormData,
): Promise<RuntimeResult> {
  const budget = parseBudgetDollars(field(form, "budget"));
  if ("error" in budget) return { ok: false, reason: budget.error };
  return mutate(form, async (workspace, agentId) => {
    await workspace.stub.startManualClaudeRun({
      actor: workspace.actor,
      agentId,
      budgetCents: budget.cents,
      now: Date.now(),
    });
    return "Started one run. It appears in the run history below.";
  });
}

/* -------------------------------------------------------------------------- */
/* Custom                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One public HTTPS endpoint and a shared signing secret.
 *
 * The endpoint is checked against the public-network rule and then sent a
 * signed test wake before anything is stored, so a URL that resolves to a
 * private address, or an endpoint that is not there, fails here rather than at
 * the first mention. The wake it will receive is metadata only — a delivery id,
 * a workspace, an agent and a queue depth — and the runtime claims and posts
 * through a delegation-scoped MCP session like every other runtime.
 */
export async function connectCustomRuntimeAction(
  _previous: RuntimeResult | null,
  form: FormData,
): Promise<RuntimeResult> {
  const secret = field(form, "signingSecret");
  if (secret.trim().length < 32) {
    return { ok: false, reason: "The signing secret needs at least 32 characters." };
  }
  return mutate(form, async (workspace, agentId) => {
    await workspace.stub.configureCustomRuntime({
      actor: workspace.actor,
      agentId,
      callbackUrl: field(form, "callbackUrl"),
      signingSecret: secret.trim(),
      now: Date.now(),
    });
    return "Connected. A signed test wake reached that endpoint.";
  });
}
