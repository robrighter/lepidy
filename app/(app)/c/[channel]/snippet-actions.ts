"use server";

import { revalidatePath } from "next/cache";

import { parseIdempotencyKey } from "@/src/domain/idempotency-key";
import { isFailure, shellErrorReason, viewerWorkspace } from "@/src/shell/viewer-workspace";

export type SnippetResult = { ok: true; messageId: string } | { ok: false; reason: string };

export async function sendSnippetAction(input: {
  csrfToken?: string;
  channelId: string;
  title?: string;
  language?: string;
  body: string;
  idempotencyKey: string;
}): Promise<SnippetResult> {
  const key = parseIdempotencyKey(input.idempotencyKey);
  if (key === null) return { ok: false, reason: "invalid request key" };
  const workspace = await viewerWorkspace(input.csrfToken);
  if (isFailure(workspace)) return workspace;
  try {
    const sent = await workspace.stub.sendSnippet({
      actor: workspace.actor,
      idempotencyKey: key,
      channelId: input.channelId,
      title: input.title ?? null,
      language: input.language ?? null,
      body: input.body,
      now: Date.now(),
    });
    revalidatePath("/c/[channel]", "page");
    return { ok: true, messageId: sent.messageId };
  } catch (error) {
    return { ok: false, reason: shellErrorReason(error) };
  }
}
