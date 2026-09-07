"use server";

import type { AgentSummary } from "@/src/cloudflare/workspace";
import { parseIdempotencyKey } from "@/src/domain/idempotency-key";
import { isFailure, shellErrorReason, viewerWorkspace } from "@/src/shell/viewer-workspace";

/**
 * Creating an agent, driven from a real `<form action>` rather than a click
 * handler, so a submission made before React has hydrated is carried out rather
 * than turned into a page reload with the typed handle thrown away.
 *
 * The result carries the directory it produced, so the component advances from
 * the answer instead of waiting on a re-render, and the action deliberately does
 * not revalidate: a revalidation landing after the client has applied the result
 * re-seeds the component with the props the server held before the write.
 */
export type AgentsResult = {
  ok: boolean;
  reason?: string;
  agents?: readonly AgentSummary[];
};

export async function createAgentAction(
  previous: AgentsResult | null,
  form: FormData,
): Promise<AgentsResult> {
  const field = (name: string): string => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  const keepList = { agents: previous?.agents };

  // The key comes from the browser so a resubmitted form is the same request
  // rather than a second agent; a missing or malformed one is refused rather
  // than replaced, because inventing a key here would defeat the point of it.
  const key = parseIdempotencyKey(field("idempotencyKey"));
  if (key === null) return { ok: false, reason: "invalid request key", ...keepList };

  const workspace = await viewerWorkspace(field("csrfToken"));
  if (isFailure(workspace)) return { ok: false, reason: workspace.reason, ...keepList };
  try {
    await workspace.stub.createAgent({
      actor: workspace.actor,
      idempotencyKey: key,
      handle: field("handle"),
      displayName: null,
      description: field("description") || null,
      now: Date.now(),
    });
  } catch (error) {
    const listed = await workspace.stub.listAgents({ actor: workspace.actor });
    return { ok: false, reason: shellErrorReason(error), agents: listed.agents };
  }
  const listed = await workspace.stub.listAgents({ actor: workspace.actor });
  return { ok: true, agents: listed.agents };
}

/** Not form-driven yet: the agent detail page that would call it is R05/C07 surface work. */
export async function setAgentBriefAction(input: {
  csrfToken?: string;
  agentId: string;
  prompt: string;
}): Promise<AgentsResult> {
  const workspace = await viewerWorkspace(input.csrfToken);
  if (isFailure(workspace)) return { ok: false, reason: workspace.reason };
  try {
    await workspace.stub.setAgentBrief({
      actor: workspace.actor,
      agentId: input.agentId,
      prompt: input.prompt,
      now: Date.now(),
    });
    const listed = await workspace.stub.listAgents({ actor: workspace.actor });
    return { ok: true, agents: listed.agents };
  } catch (error) {
    return { ok: false, reason: shellErrorReason(error) };
  }
}
