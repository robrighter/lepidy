"use client";

import { useState, useTransition } from "react";

import { cancelScheduledAction } from "@/app/(app)/c/[channel]/draft-actions";
import type { ScheduledMessageRow } from "@/src/cloudflare/workspace-rooms";
import { browserCsrfToken } from "@/src/shell/browser-csrf";

export function ScheduledList({ scheduled }: { scheduled: readonly ScheduledMessageRow[] }) {
  // Seeded by the server, then advanced by what the action returns.
  const [current, setCurrent] = useState(scheduled);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (current.length === 0) {
    return (
      <p className="notice" role="status">
        <span>Nothing scheduled. Messages you schedule for later will wait here.</span>
      </p>
    );
  }

  return (
    <ul className="scheduled-list">
      {current.map((entry) => (
        <li key={entry.id} data-status={entry.status}>
          <div>
            <p className="scheduled-when">
              <time dateTime={new Date(entry.sendAt).toISOString()}>
                {new Date(entry.sendAt).toISOString().replace("T", " ").slice(0, 16)}
              </time>
              <span className="tag">{entry.status}</span>
            </p>
            <p className="scheduled-body">{entry.bodyMarkdown}</p>
            {entry.failureReason ? (
              // A scheduled send that was refused says why, rather than
              // disappearing and leaving somebody to wonder.
              <p className="scheduled-reason">It was not sent: {entry.failureReason}.</p>
            ) : null}
          </div>
          {entry.status === "scheduled" ? (
            <button
              type="button"
              aria-label={`Cancel the message scheduled for ${new Date(entry.sendAt).toISOString()}`}
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await cancelScheduledAction({
                    csrfToken: browserCsrfToken(),
                    id: entry.id,
                  });
                  if (!result.ok) setError(result.reason);
                  else {
                    setCurrent(
                      result.scheduled.filter(
                        (entry) => entry.status === "scheduled" || entry.status === "failed",
                      ),
                    );
                  }
                })
              }
            >
              Cancel
            </button>
          ) : null}
          {error ? (
            <p className="message-error" role="alert">
              {error}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
