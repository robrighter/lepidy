"use client";

import { Trash2 } from "lucide-react";
import { useState, useTransition } from "react";

import { createEmojiAction, deleteEmojiAction } from "@/app/(app)/emoji/actions";
import type { CustomEmojiRow } from "@/src/cloudflare/workspace-rooms";
import { browserCsrfToken } from "@/src/shell/browser-csrf";
import { useHydrated } from "./use-hydrated";

export function EmojiAdmin({
  emoji,
  canAdminister,
}: {
  emoji: readonly CustomEmojiRow[];
  canAdminister: boolean;
}) {
  // Seeded by the server, then advanced by whatever each action returns, so the
  // list never waits on a re-render to show what somebody just did.
  const [current, setCurrent] = useState(emoji);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [alias, setAlias] = useState("");
  const hydrated = useHydrated();

  return (
    <>
      {canAdminister ? (
        <form
          className="emoji-form"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            startTransition(async () => {
              const result = await createEmojiAction({
                csrfToken: browserCsrfToken(),
                name,
                aliasEmoji: alias,
              });
              if (!result.ok) {
                setError(result.reason);
                return;
              }
              setCurrent(result.emoji);
              setName("");
              setAlias("");
            });
          }}
        >
          <label>
            <span>Name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="shipit" />
          </label>
          <label>
            <span>Stands for</span>
            <input value={alias} onChange={(event) => setAlias(event.target.value)} placeholder="🚀" />
          </label>
          <button type="submit" className="primary" disabled={pending || !hydrated}>
            Name it
          </button>
          {error ? (
            <p className="message-error" role="alert">
              {error}
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
                <button
                  type="button"
                  aria-label={`Remove :${entry.name}:`}
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => {
                      const result = await deleteEmojiAction({
                        csrfToken: browserCsrfToken(),
                        name: entry.name,
                      });
                      if (!result.ok) setError(result.reason);
                      else setCurrent(result.emoji);
                    })
                  }
                >
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
