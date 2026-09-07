"use server";

import type { CustomEmojiRow } from "@/src/cloudflare/workspace-rooms";
import { isFailure, shellErrorReason, viewerWorkspace } from "@/src/shell/viewer-workspace";

/**
 * One action for both things somebody can do to the emoji registry, driven from
 * a real `<form action>` rather than a click handler.
 *
 * Two properties come out of that shape and neither is decorative:
 *
 * A submission made before React has hydrated is still carried out, because the
 * browser posts the form itself and React replays it. A handler-based form loses
 * that submission and reloads the page with what was typed thrown away, which is
 * a defect this codebase has already paid for twice.
 *
 * And the result carries the list it produced, so the component advances from
 * the answer rather than waiting on a re-render. The action deliberately does
 * not revalidate: a revalidation landing after the client has applied the result
 * re-seeds the component with the props the server held *before* the write, so
 * the change disappears again.
 *
 * The failure case carries the list too whenever it is known, so a refusal
 * leaves on screen exactly what is really stored.
 */
export type EmojiResult = {
  ok: boolean;
  reason?: string;
  emoji?: readonly CustomEmojiRow[];
};

export async function emojiAdminAction(
  previous: EmojiResult | null,
  form: FormData,
): Promise<EmojiResult> {
  const field = (name: string): string => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  const keepList = { emoji: previous?.emoji };

  const workspace = await viewerWorkspace(field("csrfToken"));
  if (isFailure(workspace)) return { ok: false, reason: workspace.reason, ...keepList };

  try {
    if (field("intent") === "delete") {
      await workspace.stub.deleteCustomEmoji({
        actor: workspace.actor,
        name: field("name"),
        now: Date.now(),
      });
    } else {
      await workspace.stub.createCustomEmoji({
        actor: workspace.actor,
        name: field("name"),
        aliasEmoji: field("aliasEmoji"),
        now: Date.now(),
      });
    }
  } catch (error) {
    // The list is re-read even after a refusal, so what stays on screen is what
    // is actually stored rather than what the client happened to be holding.
    const listed = await workspace.stub.listCustomEmoji({ actor: workspace.actor });
    return { ok: false, reason: shellErrorReason(error), emoji: listed.emoji };
  }

  const listed = await workspace.stub.listCustomEmoji({ actor: workspace.actor });
  return { ok: true, emoji: listed.emoji };
}
