"use server";

import { revalidatePath } from "next/cache";

import { parseIdempotencyKey } from "@/src/domain/idempotency-key";
import {
  isFailure,
  shellErrorReason,
  viewerWorkspace,
  type ViewerWorkspace,
} from "@/src/shell/viewer-workspace";

export type ActionResult = { ok: true } | { ok: false; reason: string };

/**
 * The message actions a signed-in member can take.
 *
 * Every one of these is a thin carrier. Authorization, the plan-authority check
 * and the visibility recheck all live in the workspace object; nothing here
 * decides who may do what, and nothing here trusts a channel id from the client
 * as evidence of anything.
 */
async function run(
  csrfToken: string | undefined,
  work: (workspace: ViewerWorkspace) => Promise<void>,
): Promise<ActionResult> {
  const workspace = await viewerWorkspace(csrfToken);
  if (isFailure(workspace)) return workspace;
  try {
    await work(workspace);
    revalidatePath("/c/[channel]", "page");
    revalidatePath("/saved");
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: shellErrorReason(error) };
  }
}

export async function editMessageAction(input: {
  csrfToken?: string;
  messageId: string;
  bodyMarkdown: string;
}): Promise<ActionResult> {
  return run(input.csrfToken, async (workspace) => {
    await workspace.stub.editMessage({
      actor: workspace.actor,
      messageId: input.messageId,
      bodyMarkdown: input.bodyMarkdown,
      now: Date.now(),
    });
  });
}

export async function deleteMessageAction(input: {
  csrfToken?: string;
  messageId: string;
}): Promise<ActionResult> {
  return run(input.csrfToken, async (workspace) => {
    await workspace.stub.deleteMessage({
      actor: workspace.actor,
      messageId: input.messageId,
      now: Date.now(),
    });
  });
}

export async function toggleReactionAction(input: {
  csrfToken?: string;
  messageId: string;
  emoji: string;
  reacted: boolean;
}): Promise<ActionResult> {
  return run(input.csrfToken, async (workspace) => {
    const call = input.reacted
      ? workspace.stub.unreactToMessage({
          actor: workspace.actor,
          messageId: input.messageId,
          emoji: input.emoji,
          now: Date.now(),
        })
      : workspace.stub.reactToMessage({
          actor: workspace.actor,
          messageId: input.messageId,
          emoji: input.emoji,
          now: Date.now(),
        });
    await call;
  });
}

export async function togglePinAction(input: {
  csrfToken?: string;
  messageId: string;
  pinned: boolean;
}): Promise<ActionResult> {
  return run(input.csrfToken, async (workspace) => {
    const call = input.pinned
      ? workspace.stub.unpinMessage({
          actor: workspace.actor,
          messageId: input.messageId,
          now: Date.now(),
        })
      : workspace.stub.pinMessage({
          actor: workspace.actor,
          messageId: input.messageId,
          now: Date.now(),
        });
    await call;
  });
}

export async function toggleSavedAction(input: {
  csrfToken?: string;
  messageId: string;
  saved: boolean;
}): Promise<ActionResult> {
  return run(input.csrfToken, async (workspace) => {
    const call = input.saved
      ? workspace.stub.unsaveMessage({ actor: workspace.actor, messageId: input.messageId })
      : workspace.stub.saveMessage({
          actor: workspace.actor,
          messageId: input.messageId,
          now: Date.now(),
        });
    await call;
  });
}

export async function forwardMessageAction(input: {
  csrfToken?: string;
  messageId: string;
  targetChannelId: string;
  comment?: string | null;
  idempotencyKey: string;
}): Promise<ActionResult> {
  const key = parseIdempotencyKey(input.idempotencyKey);
  if (key === null) return { ok: false, reason: "invalid request key" };
  return run(input.csrfToken, async (workspace) => {
    await workspace.stub.forwardMessage({
      actor: workspace.actor,
      idempotencyKey: key,
      messageId: input.messageId,
      targetChannelId: input.targetChannelId,
      comment: input.comment ?? null,
      now: Date.now(),
    });
  });
}
