import Link from "next/link";
import type { NotificationActivityItem } from "@/src/cloudflare/workspace";
import { markNotificationAction } from "@/app/(app)/inbox/activity-actions";

const LABELS = { mention: "Mention", thread_reply: "Thread reply", dm: "Direct message", keyword: "Keyword", channel: "Channel" } as const;

export function ActivityFeed({ items, csrfToken, ranked = false }: {
  items: readonly NotificationActivityItem[];
  csrfToken: string;
  ranked?: boolean;
}) {
  const visible = ranked ? [...items].sort((a, b) => b.rank - a.rank || b.createdAt - a.createdAt) : items;
  if (visible.length === 0) return <div className="empty-state"><h2>You’re caught up</h2><p>New mentions, thread replies, direct messages and keyword alerts will appear here.</p></div>;
  return <ol className="activity-feed">
    {visible.map((item) => <li key={item.id} className={item.readAt === null ? "activity-card unread" : "activity-card"}>
      <div className="activity-card-head">
        <span className="tag">{LABELS[item.kind]}</span>
        <span>{item.authorKind === "agent" ? "Agent" : "Person"} · {new Date(item.createdAt).toLocaleString()}</span>
      </div>
      <strong>{item.authorLabel}</strong> in <Link href={`/c/${encodeURIComponent(item.channelLabel)}`}>#{item.channelLabel}</Link>
      <p>{item.bodyMarkdown}</p>
      <div className="activity-actions">
        <Link className="button secondary" href={`/c/${encodeURIComponent(item.channelLabel)}${item.threadRootId ? `?thread=${encodeURIComponent(item.threadRootId)}` : ""}`}>Open conversation</Link>
        <form action={markNotificationAction}>
          <input type="hidden" name="csrfToken" value={csrfToken} />
          <input type="hidden" name="notificationId" value={item.id} />
          <input type="hidden" name="unread" value={item.readAt === null ? "false" : "true"} />
          <button className="button secondary" type="submit">Mark {item.readAt === null ? "read" : "unread"}</button>
        </form>
      </div>
    </li>)}
  </ol>;
}
