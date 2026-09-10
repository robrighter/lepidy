"use client";

import { Bookmark, Forward, Pencil, Pin, SmilePlus, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  deleteMessageAction,
  editMessageAction,
  forwardMessageAction,
  togglePinAction,
  toggleReactionAction,
  toggleSavedAction,
  type ActionResult,
} from "@/app/(app)/c/[channel]/message-actions";
import type { MessageRow } from "@/src/cloudflare/workspace-rooms";
import { browserCsrfToken } from "@/src/shell/browser-csrf";

export type ForwardTarget = { id: string; label: string };

/** A small, fixed set. The full picker arrives with custom emoji in C05c. */
const QUICK_REACTIONS = ["\u{1F44D}", "\u{1F440}", "\u{1F525}", "\u{1F389}"] as const;

export function MessageActions({
  message,
  canAct,
  isOwnMessage,
  forwardTargets,
  viewerMemberId,
  rankingEmoji,
}: {
  message: MessageRow;
  canAct: boolean;
  isOwnMessage: boolean;
  forwardTargets: readonly ForwardTarget[];
  viewerMemberId: string;
  rankingEmoji?: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.bodyMarkdown);
  const [forwarding, setForwarding] = useState(false);

  function apply(work: () => Promise<ActionResult>) {
    setError(null);
    startTransition(async () => {
      const result = await work();
      if (!result.ok) setError(result.reason);
      else router.refresh();
    });
  }

  const reactedWith = (emoji: string) =>
    message.reactions.some(
      (reaction) => reaction.emoji === emoji && reaction.memberIds.includes(viewerMemberId),
    );
  const availableReactions = rankingEmoji
    ? [rankingEmoji, ...QUICK_REACTIONS.filter((emoji) => emoji !== rankingEmoji)]
    : QUICK_REACTIONS;

  if (editing) {
    return (
      <form
        className="message-edit"
        onSubmit={(event) => {
          event.preventDefault();
          apply(async () => {
            const result = await editMessageAction({
              csrfToken: browserCsrfToken(),
              messageId: message.id,
              bodyMarkdown: draft,
            });
            if (result.ok) setEditing(false);
            return result;
          });
        }}
      >
        <label className="visually-hidden" htmlFor={`edit-${message.id}`}>
          Edit message
        </label>
        <textarea
          id={`edit-${message.id}`}
          rows={3}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="message-edit-actions">
          <button type="submit" className="primary" disabled={pending}>
            Save
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setDraft(message.bodyMarkdown);
              setError(null);
            }}
          >
            Cancel
          </button>
        </div>
        {error ? (
          <p className="message-error" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    );
  }

  return (
    <div className="message-actions">
      {canAct ? (
        <div className="quick-reactions" role="group" aria-label="React">
          {availableReactions.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={reactedWith(emoji) ? `Remove ${emoji} reaction` : `React with ${emoji}`}
              aria-pressed={reactedWith(emoji)}
              disabled={pending}
              onClick={() =>
                apply(() =>
                  toggleReactionAction({
                    csrfToken: browserCsrfToken(),
                    messageId: message.id,
                    emoji,
                    reacted: reactedWith(emoji),
                  }),
                )
              }
            >
              <span aria-hidden="true">{emoji}</span>
            </button>
          ))}
          <SmilePlus size={13} aria-hidden="true" className="muted" />
        </div>
      ) : null}

      <button
        type="button"
        aria-label={message.isSaved ? "Remove from saved" : "Save this message"}
        aria-pressed={message.isSaved ?? false}
        disabled={pending}
        onClick={() =>
          apply(() =>
            toggleSavedAction({
              csrfToken: browserCsrfToken(),
              messageId: message.id,
              saved: message.isSaved ?? false,
            }),
          )
        }
      >
        <Bookmark size={14} aria-hidden="true" />
        {message.isSaved ? "Saved" : "Save"}
      </button>

      {canAct ? (
        <button
          type="button"
          aria-label={message.isPinned ? "Unpin from this channel" : "Pin to this channel"}
          aria-pressed={message.isPinned ?? false}
          disabled={pending}
          onClick={() =>
            apply(() =>
              togglePinAction({
                csrfToken: browserCsrfToken(),
                messageId: message.id,
                pinned: message.isPinned ?? false,
              }),
            )
          }
        >
          <Pin size={14} aria-hidden="true" />
          {message.isPinned ? "Pinned" : "Pin"}
        </button>
      ) : null}

      {forwardTargets.length > 0 ? (
        <button type="button" aria-label="Forward this message" onClick={() => setForwarding((open) => !open)}>
          <Forward size={14} aria-hidden="true" />
          Forward
        </button>
      ) : null}

      {isOwnMessage ? (
        <>
          <button type="button" aria-label="Edit this message" onClick={() => setEditing(true)}>
            <Pencil size={14} aria-hidden="true" />
            Edit
          </button>
          <button
            type="button"
            aria-label="Delete this message"
            disabled={pending}
            onClick={() =>
              apply(() =>
                deleteMessageAction({ csrfToken: browserCsrfToken(), messageId: message.id }),
              )
            }
          >
            <Trash2 size={14} aria-hidden="true" />
            Delete
          </button>
        </>
      ) : null}

      {forwarding ? (
        <div className="forward-picker" role="group" aria-label="Forward to a channel">
          {forwardTargets.map((target) => (
            <button
              key={target.id}
              type="button"
              disabled={pending}
              onClick={() =>
                apply(async () => {
                  const result = await forwardMessageAction({
                    csrfToken: browserCsrfToken(),
                    messageId: message.id,
                    targetChannelId: target.id,
                    idempotencyKey: `forward:${message.id}:${crypto.randomUUID()}`.slice(0, 128),
                  });
                  if (result.ok) setForwarding(false);
                  return result;
                })
              }
            >
              #{target.label}
            </button>
          ))}
          <button type="button" aria-label="Cancel forwarding" onClick={() => setForwarding(false)}>
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {error ? (
        <p className="message-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
