"use server";

import { revalidatePath } from "next/cache";

import type { CustomEmojiRow } from "@/src/cloudflare/workspace-rooms";
import { isFailure, shellErrorReason, viewerWorkspace } from "@/src/shell/viewer-workspace";

/**
 * The action hands back the list it produced.
 *
 * Waiting for the framework to re-render the page after a mutation makes what
 * the person sees depend on revalidation timing. Returning the new list makes
 * the change they just made appear because they made it.
 */
export type EmojiResult =
  | { ok: true; emoji: readonly CustomEmojiRow[] }
  | { ok: false; reason: string };

/**
 * Naming an emoji is workspace administration. The object refuses anybody who
 * is not an admin; this only carries the request and the CSRF token to it.
 */
export async function createEmojiAction(input: {
  csrfToken?: string;
  name: string;
  aliasEmoji: string;
}): Promise<EmojiResult> {
  const workspace = await viewerWorkspace(input.csrfToken);
  if (isFailure(workspace)) return workspace;
  try {
    await workspace.stub.createCustomEmoji({
      actor: workspace.actor,
      name: input.name,
      aliasEmoji: input.aliasEmoji,
      now: Date.now(),
    });
    const listed = await workspace.stub.listCustomEmoji({ actor: workspace.actor });
    revalidatePath("/emoji");
    return { ok: true, emoji: listed.emoji };
  } catch (error) {
    return { ok: false, reason: shellErrorReason(error) };
  }
}

export async function deleteEmojiAction(input: {
  csrfToken?: string;
  name: string;
}): Promise<EmojiResult> {
  const workspace = await viewerWorkspace(input.csrfToken);
  if (isFailure(workspace)) return workspace;
  try {
    await workspace.stub.deleteCustomEmoji({
      actor: workspace.actor,
      name: input.name,
      now: Date.now(),
    });
    const listed = await workspace.stub.listCustomEmoji({ actor: workspace.actor });
    revalidatePath("/emoji");
    return { ok: true, emoji: listed.emoji };
  } catch (error) {
    return { ok: false, reason: shellErrorReason(error) };
  }
}
