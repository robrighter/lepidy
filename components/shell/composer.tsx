"use client";

import { CalendarClock, CloudCheck, CornerDownLeft, FileCode2, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { sendChannelMessage, type SendResult } from "@/app/(app)/c/[channel]/actions";
import {
  saveDraftAction,
  scheduleMessageAction,
} from "@/app/(app)/c/[channel]/draft-actions";
import { sendSnippetAction } from "@/app/(app)/c/[channel]/snippet-actions";
import { browserCsrfToken } from "@/src/shell/browser-csrf";
import { useHydrated } from "./use-hydrated";

/**
 * The composer, and the regressions it exists to keep fixed.
 *
 * 1. Focus stays in the box after sending. Losing it costs a keystroke every
 *    message and is the single most-reported chat bug there is.
 * 2. An unsent draft survives leaving the room and coming back, and now follows
 *    the person between devices, because a draft that only exists on the laptop
 *    is one nobody trusts.
 * 3. Enter sends, Shift+Enter adds a line. Anything else and a code block is
 *    impossible to type.
 */

const DRAFT_PREFIX = "lepidy-draft:";
/** Long enough not to write on every keystroke, short enough to survive a tab close. */
const DRAFT_SYNC_MS = 900;

export type InitialDraft = { bodyMarkdown: string; revision: number } | null;

function readLocalDraft(channelId: string): string | null {
  try {
    return localStorage.getItem(`${DRAFT_PREFIX}${channelId}`);
  } catch {
    return null;
  }
}

function writeLocalDraft(channelId: string, value: string): void {
  try {
    if (value.length === 0) localStorage.removeItem(`${DRAFT_PREFIX}${channelId}`);
    else localStorage.setItem(`${DRAFT_PREFIX}${channelId}`, value);
  } catch {
    // A browser that refuses storage still composes; it just forgets locally.
  }
}

export function Composer({
  channelId,
  channelLabel,
  canPost,
  initialDraft = null,
}: {
  channelId: string;
  channelLabel: string;
  canPost: boolean;
  initialDraft?: InitialDraft;
}) {
  const [body, setBody] = useState(initialDraft?.bodyMarkdown ?? "");
  const revisionRef = useRef(initialDraft?.revision);
  const [status, setStatus] = useState<SendResult | null>(null);
  const [sending, setSending] = useState(false);
  const [draftState, setDraftState] = useState<"idle" | "syncing" | "synced" | "conflict">("idle");
  const [draftError, setDraftError] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [sendAt, setSendAt] = useState("");
  const [snippetMode, setSnippetMode] = useState(false);
  const [snippetTitle, setSnippetTitle] = useState("");
  const [snippetLanguage, setSnippetLanguage] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  // What the server last confirmed. Comparing against this is what stops a
  // successful save — which advances the revision — from triggering the next.
  const syncedBody = useRef(initialDraft?.bodyMarkdown ?? "");
  const router = useRouter();
  const hydrated = useHydrated();

  // The server's draft is the one that followed this person here. A local draft
  // is only preferred when the server has none, which is the offline case.
  useEffect(() => {
    const local = readLocalDraft(channelId);
    const starting = initialDraft?.bodyMarkdown ?? local ?? "";
    setBody(starting);
    revisionRef.current = initialDraft?.revision;
    syncedBody.current = initialDraft?.bodyMarkdown ?? "";
    setStatus(null);
    setDraftState("idle");
    setDraftError(null);
  }, [channelId, initialDraft?.bodyMarkdown, initialDraft?.revision]);

  const update = useCallback(
    (value: string) => {
      setBody(value);
      writeLocalDraft(channelId, value);
    },
    [channelId],
  );

  // Debounced, so a draft syncs while somebody thinks rather than per keystroke.
  useEffect(() => {
    if (!canPost) return;
    if (body === syncedBody.current) return;
    setDraftState("syncing");
    const timer = setTimeout(async () => {
      const result = await saveDraftAction({
        csrfToken: browserCsrfToken(),
        channelId,
        bodyMarkdown: body,
        baseRevision: revisionRef.current,
      });
      if (!result.ok) {
        // A draft that quietly fails to sync is worse than one that says so.
        setDraftState("idle");
        setDraftError(result.reason);
        return;
      }
      setDraftError(null);
      if (result.saved.status === "conflict") {
        // Another device moved this draft on. Say so rather than overwriting it.
        setDraftState("conflict");
        return;
      }
      syncedBody.current = body;
      revisionRef.current = result.saved.draft?.revision;
      setDraftState("synced");
    }, DRAFT_SYNC_MS);
    return () => clearTimeout(timer);
  }, [body, canPost, channelId]);

  const submit = useCallback(async () => {
    const trimmed = body.trim();
    if (trimmed.length === 0 || sending) return;
    setSending(true);
    const idempotencyKey = `compose:${channelId}:${crypto.randomUUID()}`.slice(0, 128);
    let result = await sendChannelMessage({
      csrfToken: browserCsrfToken(),
      channelId,
      bodyMarkdown: trimmed,
      // Stable per attempt, so a retried submission is not a second message.
      idempotencyKey,
    });
    const broadcastAudience = result.ok
      ? null
      : /^broadcast requires confirmation for (\d+) recipients$/.exec(result.reason);
    if (broadcastAudience) {
      const recipients = Number(broadcastAudience[1]);
      const accepted = window.confirm(
        `Notify ${recipients} ${recipients === 1 ? "recipient" : "recipients"} with this broadcast?`,
      );
      if (accepted) {
        result = await sendChannelMessage({
          csrfToken: browserCsrfToken(),
          channelId,
          bodyMarkdown: trimmed,
          idempotencyKey,
          confirmedBroadcastRecipients: recipients,
        });
      } else {
        result = { ok: false, reason: "Broadcast cancelled." };
      }
    }
    setSending(false);
    setStatus(result);
    if (result.ok) {
      update("");
      // The draft is spent; clear it everywhere, not just in this browser.
      await saveDraftAction({
        csrfToken: browserCsrfToken(),
        channelId,
        bodyMarkdown: "",
      });
      revisionRef.current = undefined;
      syncedBody.current = "";
      setDraftState("idle");
      // The server action revalidated the route; ask the router to actually
      // re-render it, or the message that was just sent stays off screen.
      router.refresh();
    }
    // The caret goes back where the next word belongs, sent or not.
    input.current?.focus();
  }, [body, channelId, router, sending, update]);

  const postSnippet = useCallback(async () => {
    if (body.trim().length === 0) return;
    setSending(true);
    const result = await sendSnippetAction({
      csrfToken: browserCsrfToken(),
      channelId,
      title: snippetTitle,
      language: snippetLanguage,
      body,
      idempotencyKey: `snippet:${channelId}:${crypto.randomUUID()}`.slice(0, 128),
    });
    setSending(false);
    if (!result.ok) {
      setStatus(result);
      return;
    }
    setStatus(null);
    setSnippetMode(false);
    setSnippetTitle("");
    setSnippetLanguage("");
    update("");
    revisionRef.current = undefined;
    syncedBody.current = "";
    router.refresh();
  }, [body, channelId, router, snippetLanguage, snippetTitle, update]);

  const schedule = useCallback(async () => {
    const trimmed = body.trim();
    if (trimmed.length === 0 || sendAt === "") return;
    setSending(true);
    const result = await scheduleMessageAction({
      csrfToken: browserCsrfToken(),
      channelId,
      bodyMarkdown: trimmed,
      sendAt: new Date(sendAt).getTime(),
      idempotencyKey: `schedule:${channelId}:${crypto.randomUUID()}`.slice(0, 128),
    });
    setSending(false);
    if (!result.ok) {
      setStatus(result);
      return;
    }
    setStatus(null);
    setScheduling(false);
    setSendAt("");
    update("");
    revisionRef.current = undefined;
    syncedBody.current = "";
    router.refresh();
  }, [body, channelId, router, sendAt, update]);

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
        void (snippetMode ? postSnippet() : submit());
      }}
    >
      <label className="visually-hidden" htmlFor="composer-input">
        Message #{channelLabel}
      </label>
      {snippetMode ? (
        <div className="composer-snippet">
          <label>
            <span>Title</span>
            <input
              value={snippetTitle}
              onChange={(event) => setSnippetTitle(event.target.value)}
              placeholder="Deploy script"
            />
          </label>
          <label>
            <span>Language</span>
            <input
              value={snippetLanguage}
              onChange={(event) => setSnippetLanguage(event.target.value)}
              placeholder="sh"
            />
          </label>
        </div>
      ) : null}

      <textarea
        id="composer-input"
        ref={input}
        rows={snippetMode ? 8 : 2}
        value={body}
        // Until React has hydrated, this input's value is not connected to
        // anything: typing into it puts characters in the DOM that the first
        // render then wipes, because a controlled input is reconciled against
        // state that never saw them. Read-only says so instead of losing them.
        readOnly={!hydrated}
        placeholder={snippetMode ? "Paste the snippet here" : `Message #${channelLabel}`}
        onChange={(event) => update(event.target.value)}
        onKeyDown={(event) => {
          // Enter sends; Shift+Enter is how a code block gets typed at all. In
          // snippet mode every newline is content, so Enter never sends.
          if (event.key === "Enter" && !event.shiftKey && !snippetMode) {
            event.preventDefault();
            void submit();
          }
        }}
      />

      {scheduling ? (
        <div className="composer-schedule">
          <label htmlFor="composer-send-at">Send at</label>
          <input
            id="composer-send-at"
            type="datetime-local"
            value={sendAt}
            onChange={(event) => setSendAt(event.target.value)}
          />
          <button
            type="button"
            className="primary"
            disabled={sending || sendAt === "" || body.trim().length === 0}
            onClick={() => void schedule()}
          >
            Schedule
          </button>
          <button type="button" onClick={() => setScheduling(false)}>
            Cancel
          </button>
        </div>
      ) : null}

      <div className="composer-actions">
        <span className="composer-hint">
          <CornerDownLeft size={12} aria-hidden="true" /> to send · Shift + Enter for a new line ·
          Markdown, ``` code and /commands
        </span>
        {draftState === "synced" ? (
          <span className="draft-state" role="status">
            <CloudCheck size={12} aria-hidden="true" /> Draft saved
          </span>
        ) : null}
        <button
          type="button"
          className="schedule-toggle"
          aria-label="Post this as a snippet"
          aria-expanded={snippetMode}
          onClick={() => setSnippetMode((open) => !open)}
        >
          <FileCode2 size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="schedule-toggle"
          aria-label="Schedule this message for later"
          aria-expanded={scheduling}
          onClick={() => setScheduling((open) => !open)}
        >
          <CalendarClock size={15} aria-hidden="true" />
        </button>
        <button type="submit" className="primary" disabled={sending || body.trim().length === 0}>
          <Send size={15} aria-hidden="true" />
          {sending ? "Sending" : snippetMode ? "Post snippet" : "Send"}
        </button>
      </div>

      {draftError ? (
        <p className="composer-error" role="alert">
          Draft not synced: {draftError}
        </p>
      ) : null}
      {draftState === "conflict" ? (
        <p className="composer-error" role="alert">
          This draft was changed on another device. Reload the room to see what is stored there.
        </p>
      ) : null}
      {status && !status.ok ? (
        <p className="composer-error" role="alert">
          {status.reason}
        </p>
      ) : null}
    </form>
  );
}
