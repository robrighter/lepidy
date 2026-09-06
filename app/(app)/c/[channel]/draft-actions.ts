"use server";

import { revalidatePath } from "next/cache";

import type { DraftSaveResult } from "@/src/cloudflare/workspace";
import type { ScheduledMessageRow } from "@/src/cloudflare/workspace-rooms";
import { parseIdempotencyKey } from "@/src/domain/idempotency-key";
import { isFailure, shellErrorReason, viewerWorkspace } from "@/src/shell/viewer-workspace";

export type DraftResult = { ok: true; saved: DraftSaveResult } | { ok: false; reason: string };
export type ScheduleResult = { ok: true; id: string; sendAt: number } | { ok: false; reason: string };
export type CancelResult =
  | { ok: true; scheduled: readonly ScheduledMessageRow[] }
  | { ok: false; reason: string };

/**
 * Drafts follow a person between devices, so they are stored server-side. The
 * caller sends the revision it was editing from; the object refuses rather than
 * overwriting work another device did in the meantime.
 */
export async function saveDraftAction(input: {
  csrfToken?: string;
  channelId: string;
  threadRootId?: string | null;
  bodyMarkdown: string;
  baseRevision?: number;
}): Promise<DraftResult> {
  const workspace = await viewerWorkspace(input.csrfToken);
  if (isFailure(workspace)) return workspace;
  try {
    const saved = await workspace.stub.saveDraft({
      actor: workspace.actor,
      channelId: input.channelId,
      threadRootId: input.threadRootId ?? null,
      bodyMarkdown: input.bodyMarkdown,
      baseRevision: input.baseRevision,
      now: Date.now(),
    });
    return { ok: true, saved };
  } catch (error) {
    return { ok: false, reason: shellErrorReason(error) };
  }
}

export async function scheduleMessageAction(input: {
  csrfToken?: string;
  channelId: string;
  bodyMarkdown: string;
  sendAt: number;
  idempotencyKey: string;
}): Promise<ScheduleResult> {
  const key = parseIdempotencyKey(input.idempotencyKey);
  if (key === null) return { ok: false, reason: "invalid request key" };
  const workspace = await viewerWorkspace(input.csrfToken);
  if (isFailure(workspace)) return workspace;
  try {
    const scheduled = await workspace.stub.scheduleMessage({
      actor: workspace.actor,
      idempotencyKey: key,
      channelId: input.channelId,
      bodyMarkdown: input.bodyMarkdown,
      sendAt: input.sendAt,
      now: Date.now(),
    });
    revalidatePath("/scheduled");
    return { ok: true, id: scheduled.id, sendAt: scheduled.sendAt };
  } catch (error) {
    return { ok: false, reason: shellErrorReason(error) };
  }
}

export async function cancelScheduledAction(input: {
  csrfToken?: string;
  id: string;
}): Promise<CancelResult> {
  const workspace = await viewerWorkspace(input.csrfToken);
  if (isFailure(workspace)) return workspace;
  try {
    await workspace.stub.cancelScheduledMessage({
      actor: workspace.actor,
      id: input.id,
      now: Date.now(),
    });
    // The action hands back the list it produced rather than leaving what the
    // person sees to depend on revalidation timing.
    const listed = await workspace.stub.listScheduledMessages({ actor: workspace.actor });
    revalidatePath("/scheduled");
    return { ok: true, scheduled: listed.scheduled };
  } catch (error) {
    return { ok: false, reason: shellErrorReason(error) };
  }
}
