"use client";

import { Trash2 } from "lucide-react";
import { useActionState } from "react";

import { emojiAdminAction, type EmojiResult } from "@/app/(app)/emoji/actions";
import type { CustomEmojiRow } from "@/src/cloudflare/workspace-rooms";

/**
 * Every control here is a real form posting to a server action, so a click made
 * before the page has hydrated is carried out rather than lost. One action and
 * one piece of state serve both the create form and each row's delete, so there
 * is never a question of which answer is the newer one.
 */
export function EmojiAdmin({
  emoji,
  canAdminister,
  csrfToken,
}: {
  emoji: readonly CustomEmojiRow[];
  canAdminister: boolean;
  csrfToken: string;
}) {
  const [state, formAction, pending] = useActionState<EmojiResult | null, FormData>(
    emojiAdminAction,
    null,
  );
  // Seeded by the server, then advanced by whatever the last action returned.
  const current = state?.emoji ?? emoji;

  return (
    <>
      {canAdminister ? (
        <form className="emoji-form" action={formAction}>
          <input type="hidden" name="csrfToken" value={csrfToken} />
          <input type="hidden" name="intent" value="create" />
          <label>
            <span>Name</span>
            {/* Uncontrolled, so characters typed before hydration are still here
                when the form is submitted rather than being reconciled away
                against state that never saw them. */}
            <input name="name" defaultValue="" placeholder="shipit" />
          </label>
          <label>
            <span>Stands for</span>
            <input name="aliasEmoji" defaultValue="" placeholder="🚀" />
          </label>
          <button type="submit" className="primary" disabled={pending}>
            Name it
          </button>
          {state && !state.ok && state.reason ? (
            <p className="message-error" role="alert">
              {state.reason}
            </p>
          ) : null}
        </form>
      ) : (
        <p className="notice" role="status">
          <span>Only an admin can name or remove a custom emoji.</span>
        </p>
      )}

      {current.length === 0 ? (
        <div className="empty-state">
          <h2>No custom emoji yet</h2>
          <p>A team&apos;s emoji are how its culture is encoded. Name the first one.</p>
          <span className="next-step">Image-backed emoji arrive with file uploads in C08.</span>
        </div>
      ) : (
        <ul className="emoji-list">
          {current.map((entry) => (
            <li key={entry.name}>
              <span className="emoji-alias" aria-hidden="true">
                {entry.aliasEmoji}
              </span>
              <code>:{entry.name}:</code>
              {canAdminister ? (
                <form action={formAction}>
                  <input type="hidden" name="csrfToken" value={csrfToken} />
                  <input type="hidden" name="intent" value="delete" />
                  <input type="hidden" name="name" value={entry.name} />
                  <button type="submit" disabled={pending} aria-label={`Remove :${entry.name}:`}>
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
