import { shellState } from "@/src/shell/shell-context";

export default async function ProfilePage() {
  const state = await shellState();
  if (state.status !== "ready") return null;
  const { viewer } = state.snapshot;

  return (
    <>
      <section className="panel">
        <h2>Profile</h2>
        <ul className="list">
          <li><a href="#">Display name<span className="tag">{viewer.displayName}</span></a></li>
          <li><a href="#">Handle<span className="tag">@{viewer.handle}</span></a></li>
          <li><a href="#">Role<span className="tag">{viewer.role}</span></a></li>
          <li><a href="#">Workspace<span className="tag">{state.workspace.name}</span></a></li>
          <li><a href="#">Plan<span className="tag">{state.workspace.plan}</span></a></li>
          <li><a href="#">Residency<span className="tag">{state.workspace.jurisdiction}</span></a></li>
        </ul>
      </section>

      <section className="panel">
        <h2>Workspace</h2>
        <ul className="list">
          <li>
            <a href="/emoji">Custom emoji<span className="tag">admin</span></a>
          </li>
        </ul>
      </section>

      <section className="panel" id="preferences">
        <h2>Preferences</h2>
        <p>
          The theme control sits in the top bar and follows your system setting until you choose
          otherwise. Your choice is stored in this browser only.
        </p>
      </section>

      <section className="empty-state">
        <h2>Editing your profile is not built yet</h2>
        <p>Status, timezone, working hours and hovercards belong to the people directory.</p>
        <span className="next-step">Profile editing and the directory arrive with C07.</span>
      </section>
    </>
  );
}
