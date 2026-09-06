"use client";

import { CornerDownLeft, Send } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { sendChannelMessage, type SendResult } from "@/app/(app)/c/[channel]/actions";
import { browserCsrfToken } from "@/src/shell/browser-csrf";

/**
 * The composer, and the three regressions it exists to keep fixed.
 *
 * 1. Focus stays in the box after sending. Losing it costs a keystroke every
 *    message and is the single most-reported chat bug there is.
 * 2. An unsent draft survives leaving the room and coming back, per channel.
 * 3. Enter sends, Shift+Enter adds a line. Anything else and a code block is
 *    impossible to type.
 */

const DRAFT_PREFIX = "lepidy-draft:";

function readDraft(channelId: string): string {
  try {
    return localStorage.getItem(`${DRAFT_PREFIX}${channelId}`) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(channelId: string, value: string): void {
  try {
    if (value.length === 0) localStorage.removeItem(`${DRAFT_PREFIX}${channelId}`);
    else localStorage.setItem(`${DRAFT_PREFIX}${channelId}`, value);
  } catch {
    // A browser that refuses storage still composes; it just forgets.
  }
}

export function Composer({
  channelId,
  channelLabel,
  canPost,
}: {
  channelId: string;
  channelLabel: string;
  canPost: boolean;
}) {
  const [body, setBody] = useState("");
  const [status, setStatus] = useState<SendResult | null>(null);
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);

  // Drafts are per room, so switching rooms never loses what was typed.
  useEffect(() => {
    setBody(readDraft(channelId));
    setStatus(null);
  }, [channelId]);

  const update = useCallback(
    (value: string) => {
      setBody(value);
      writeDraft(channelId, value);
    },
    [channelId],
  );

  const submit = useCallback(async () => {
    const trimmed = body.trim();
    if (trimmed.length === 0 || sending) return;
    setSending(true);
    const result = await sendChannelMessage({
      csrfToken: browserCsrfToken(),
      channelId,
      bodyMarkdown: trimmed,
      // Stable per attempt, so a retried submission is not a second message.
      idempotencyKey: `compose:${channelId}:${crypto.randomUUID()}`.slice(0, 128),
    });
    setSending(false);
    setStatus(result);
    if (result.ok) update("");
    // The caret goes back where the next word belongs, sent or not.
    input.current?.focus();
  }, [body, channelId, sending, update]);

  if (!canPost) {
    return (
      <p className="composer-notice" role="status">
        Join #{channelLabel} to post in it.
      </p>
    );
  }

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label className="visually-hidden" htmlFor="composer-input">
        Message #{channelLabel}
      </label>
      <textarea
        id="composer-input"
        ref={input}
        rows={2}
        value={body}
        placeholder={`Message #${channelLabel}`}
        onChange={(event) => update(event.target.value)}
        onKeyDown={(event) => {
          // Enter sends; Shift+Enter is how a code block gets typed at all.
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <div className="composer-actions">
        <span className="composer-hint">
          <CornerDownLeft size={12} aria-hidden="true" /> to send · Shift + Enter for a new line ·
          Markdown and ``` code
        </span>
        <button type="submit" className="primary" disabled={sending || body.trim().length === 0}>
          <Send size={15} aria-hidden="true" />
          {sending ? "Sending" : "Send"}
        </button>
      </div>
      {status && !status.ok ? (
        <p className="composer-error" role="alert">
          {status.reason}
        </p>
      ) : null}
    </form>
  );
}
