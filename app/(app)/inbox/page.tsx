import { ApprovalInbox } from "@/components/shell/approval-inbox";
import { NotificationPermission } from "@/components/shell/notification-permission";
import { ActivityFeed } from "@/components/shell/activity-feed";
import { workspaceApprovals } from "@/src/shell/approvals-context";
import { workspaceActivity } from "@/src/shell/activity-context";
import { readCsrfToken } from "@/src/shell/session-cookies";
import Link from "next/link";
import { configureNotificationsAction } from "./activity-actions";
import { shellState } from "@/src/shell/shell-context";

function minuteValue(value: number | null): string {
  if (value === null) return "";
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

export default async function Page({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const unreadOnly = (await searchParams).view !== "all";
  const [state, activityState, csrfToken, shell] = await Promise.all([
    workspaceApprovals(), workspaceActivity(unreadOnly), readCsrfToken(), shellState(),
  ]);
  const selectedChannelId = shell.status === "ready" ? shell.snapshot.channels[0]?.id ?? "" : "";
  const selectedNotifyLevel = activityState.status === "ready"
    ? activityState.preferences.channels.find((entry) => entry.channelId === selectedChannelId)?.level ?? "mentions"
    : "mentions";

  if (state.status === "unavailable") {
    return (
      <section className="empty-state">
        <h2>Your inbox is unavailable</h2>
        <p>{state.reason}</p>
        <span className="next-step">Nothing was shown because authority could not be confirmed.</span>
      </section>
    );
  }

  return (
    <>
      <section className="panel">
        <h2>Inbox</h2>
        <p>
          Credential requests arrive here and as a direct message from @a.vault, so they can be
          answered wherever you already are. Mentions, thread replies, direct messages and keyword
          alerts use the same visibility and read-state rules.
        </p>
        <nav className="activity-tabs" aria-label="Inbox view">
          <Link aria-current={unreadOnly ? "page" : undefined} href="/inbox?view=unread">Unread</Link>
          <Link aria-current={!unreadOnly ? "page" : undefined} href="/inbox?view=all">All</Link>
          {activityState.status === "ready" ? <span>{activityState.activity.unread.total} unread · {activityState.activity.unread.mentions} mentions · {activityState.activity.unread.threads} threads · {activityState.activity.unread.dms} DMs</span> : null}
        </nav>
      </section>
      <section className="panel">
        <ApprovalInbox
          approvals={state.status === "ready" ? state.approvals : []}
          csrfToken={csrfToken ?? ""}
          hasPasskey={state.status === "ready" && state.hasPasskey}
        />
      </section>
      <section className="panel" aria-labelledby="activity-heading">
        <h2 id="activity-heading">Messages for you</h2>
        {activityState.status === "unavailable" ? <div className="notice warn">{activityState.reason}</div> :
          <ActivityFeed items={activityState.status === "ready" ? activityState.activity.items : []} csrfToken={csrfToken ?? ""} />}
      </section>
      {activityState.status === "ready" && shell.status === "ready" ? <section className="panel" aria-labelledby="notification-settings-heading">
        <h2 id="notification-settings-heading">Notification settings</h2>
        <p>Agent messages are quieter by default. Approvals remain visible through their dedicated urgent path.</p>
        <NotificationPermission csrfToken={csrfToken ?? ""} />
        <form action={configureNotificationsAction} className="settings-form">
          <input type="hidden" name="csrfToken" value={csrfToken ?? ""} />
          <label>Room
            <select name="channelId" defaultValue={selectedChannelId}>
              <option value="">No room change</option>
              {shell.snapshot.channels.map((channel) => <option key={channel.id} value={channel.id}>#{channel.slug ?? channel.name ?? channel.id}</option>)}
            </select>
          </label>
          <label>Room notifications
            <select name="notifyLevel" defaultValue={selectedNotifyLevel}>
              <option value="everything">Everything</option>
              <option value="mentions">Mentions and threads</option>
              <option value="nothing">Inbox only, no badge</option>
              <option value="mute">Mute</option>
            </select>
          </label>
          <label>Keyword alerts <input name="keywords" defaultValue={activityState.preferences.keywords.join(", ")} placeholder="incident, launch" /></label>
          <label>DND starts (UTC) <input name="dndStart" type="time" defaultValue={minuteValue(activityState.preferences.dndStartMinute)} /></label>
          <label>DND ends (UTC) <input name="dndEnd" type="time" defaultValue={minuteValue(activityState.preferences.dndEndMinute)} /></label>
          <button className="button" type="submit">Save notification settings</button>
        </form>
      </section> : null}
    </>
  );
}
