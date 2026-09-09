import { formatMinuteOfDay } from "@/src/domain/people";
import { workspacePeople } from "@/src/shell/people-context";
import { readCsrfToken } from "@/src/shell/session-cookies";
import { shellState } from "@/src/shell/shell-context";
import { saveProfileAction } from "../people/actions";

export default async function ProfilePage({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  const [shell, people] = await Promise.all([shellState(), workspacePeople()]);
  if (shell.status !== "ready" || people.status !== "ready") return null;
  const viewer = people.directory.people.find((person) => person.id === people.viewerMemberId);
  if (!viewer) return <section className="empty-state"><h2>Profile unavailable</h2></section>;
  const notice = (await searchParams).notice;

  return (
    <>
      {notice ? <p className="notice" role="status">{notice}</p> : null}
      <section className="panel">
        <h2>Profile</h2>
        <p>Your workspace profile supplies the directory, hovercards, local time and availability context.</p>
        <p className="profile-handle">@{viewer.handle}</p>
        <form action={saveProfileAction} className="settings-form">
          <input type="hidden" name="csrfToken" value={(await readCsrfToken()) ?? ""} />
          <label>Display name<input name="displayName" defaultValue={viewer.displayName} required maxLength={80} /></label>
          <label>Handle<input value={`@${viewer.handle}`} disabled aria-describedby="handle-note" /></label>
          <small id="handle-note">Handles are immutable workspace-local addresses.</small>
          <label>Title<input name="title" defaultValue={viewer.title ?? ""} maxLength={100} /></label>
          <label>Custom status<input name="customStatus" defaultValue={viewer.customStatus ?? ""} maxLength={120} /></label>
          <label>Availability<select name="availability" defaultValue={viewer.availability}>
            <option value="auto">Follow my connection</option>
            <option value="focus">Focus</option>
            <option value="away">Away</option>
          </select></label>
          <small>Focus and Away stay set until you clear them, even while you are connected.</small>
          <label>Timezone<input name="timezone" defaultValue={viewer.timezone ?? ""} placeholder="America/New_York" /></label>
          <div className="form-row"><label>Working day starts<input name="workingStart" type="time" defaultValue={formatMinute(viewer.workingStartMinute)} /></label><label>Working day ends<input name="workingEnd" type="time" defaultValue={formatMinute(viewer.workingEndMinute)} /></label></div>
          <button className="primary-link" type="submit">Save profile</button>
        </form>
      </section>
      <section className="panel"><h2>Workspace</h2><ul className="list"><li><a href="/people">People and administration<span className="tag">{viewer.role}</span></a></li><li><a href="/emoji">Custom emoji<span className="tag">admin</span></a></li><li><a href="/connections">MCP connections<span className="tag">yours</span></a></li></ul></section>
    </>
  );
}

function formatMinute(value: number | null): string {
  return value === null ? "" : formatMinuteOfDay(value);
}
