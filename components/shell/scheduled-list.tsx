"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { cancelScheduledAction } from "@/app/(app)/c/[channel]/draft-actions";
import type { ScheduledMessageRow } from "@/src/cloudflare/workspace-rooms";
import { browserCsrfToken } from "@/src/shell/browser-csrf";

export function ScheduledList({ scheduled }: { scheduled: readonly ScheduledMessageRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <ul className="scheduled-list">
      {scheduled.map((entry) => (
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
                  else router.refresh();
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
