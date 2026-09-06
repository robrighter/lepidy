"use server";

import type { AgentSummary } from "@/src/cloudflare/workspace";
import { parseIdempotencyKey } from "@/src/domain/idempotency-key";
import { isFailure, shellErrorReason, viewerWorkspace } from "@/src/shell/viewer-workspace";

/**
 * The action hands back the directory it produced, so what somebody sees after
 * creating an agent does not depend on revalidation timing.
 */
export type AgentsResult =
  | { ok: true; agents: readonly AgentSummary[] }
  | { ok: false; reason: string };

export async function createAgentAction(input: {
  csrfToken?: string;
  handle: string;
  displayName?: string;
  description?: string;
  idempotencyKey: string;
}): Promise<AgentsResult> {
  const key = parseIdempotencyKey(input.idempotencyKey);
  if (key === null) return { ok: false, reason: "invalid request key" };
  const workspace = await viewerWorkspace(input.csrfToken);
  if (isFailure(workspace)) return workspace;
  try {
    await workspace.stub.createAgent({
      actor: workspace.actor,
      idempotencyKey: key,
      handle: input.handle,
      displayName: input.displayName ?? null,
      description: input.description ?? null,
      now: Date.now(),
    });
    const listed = await workspace.stub.listAgents({ actor: workspace.actor });
    return { ok: true, agents: listed.agents };
  } catch (error) {
    return { ok: false, reason: shellErrorReason(error) };
  }
}

export async function setAgentBriefAction(input: {
  csrfToken?: string;
  agentId: string;
  prompt: string;
}): Promise<AgentsResult> {
  const workspace = await viewerWorkspace(input.csrfToken);
  if (isFailure(workspace)) return workspace;
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
