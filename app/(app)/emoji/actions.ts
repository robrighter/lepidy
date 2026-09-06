"use server";

import type { CustomEmojiRow } from "@/src/cloudflare/workspace-rooms";
import { isFailure, shellErrorReason, viewerWorkspace } from "@/src/shell/viewer-workspace";

/**
 * The action hands back the list it produced, and deliberately does not
 * revalidate the path.
 *
 * Waiting for the framework to re-render after a mutation makes what somebody
 * sees depend on revalidation timing. Worse, a revalidation that lands after the
 * client has already applied the result re-seeds the component with the props
 * the server had *before* the write, so the change disappears again. Returning
 * the new list and leaving the page alone removes both problems; a fresh
 * navigation reads from the server as usual.
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
    return { ok: true, emoji: listed.emoji };
  } catch (error) {
    return { ok: false, reason: shellErrorReason(error) };
  }
}
