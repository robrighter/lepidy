import {
  Activity,
  AtSign,
  Bell,
  Bot,
  ChevronDown,
  Hash,
  Home,
  Inbox,
  KeyRound,
  MessageCircle,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Users,
} from "lucide-react";
import { DesktopTitlebar } from "@/components/desktop-titlebar";

const channels = ["general", "engineering", "releases"];

export default function FoundationPage() {
  return (
    <>
      <DesktopTitlebar />
      <main className="app-shell">
      <aside className="rail" aria-label="Workspace navigation">
        <div className="brand">
          <img src="/mark.svg" alt="" width="34" height="34" />
          <span>Lepidy</span>
          <ChevronDown size={16} aria-hidden="true" />
        </div>

        <button className="search-button" type="button">
          <Search size={16} />
          <span>Search</span>
          <kbd>⌘ K</kbd>
        </button>

        <nav>
          <a className="nav-item active" href="#home"><Home size={18} />Home</a>
          <a className="nav-item" href="#inbox"><Inbox size={18} />Inbox<span className="badge">4</span></a>
          <a className="nav-item" href="#activity"><Activity size={18} />Agent activity</a>
          <a className="nav-item" href="#vault"><KeyRound size={18} />Vault</a>
        </nav>

        <div className="nav-group">
          <div className="nav-label"><span>Channels</span><Plus size={15} /></div>
          {channels.map((channel) => (
            <a className="nav-item small" href={`#${channel}`} key={channel}>
              <Hash size={16} />{channel}
            </a>
          ))}
        </div>

        <div className="nav-group">
          <div className="nav-label"><span>Direct messages</span><Plus size={15} /></div>
          <a className="nav-item small" href="#maya"><span className="avatar coral">MP</span>Maya Patel<span className="presence" /></a>
          <a className="nav-item small" href="#releasebot"><span className="avatar agent"><Bot size={13} /></span>releasebot<span className="agent-chip">agent</span></a>
        </div>

        <div className="rail-footer">
          <span className="avatar violet">MP</span>
          <div><strong>Maya Patel</strong><span>Available</span></div>
          <Settings size={17} />
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <h1>Home</h1>
            <span>Friday, 5 September</span>
          </div>
          <div className="top-actions">
            <button className="icon-button" type="button" aria-label="Notifications"><Bell size={18} /></button>
            <button className="access-button" type="button"><ShieldCheck size={16} />Agent access: on</button>
          </div>
        </header>

        <div className="content">
          <section className="welcome-card">
            <div className="welcome-copy">
              <span className="eyebrow">Your workspace, in motion</span>
              <h2>Good morning, Maya.</h2>
              <p>Two agents worked overnight. One is waiting on you.</p>
            </div>
            <div className="orbit" aria-hidden="true"><img src="/mark.svg" alt="" /></div>
            <div className="stats">
              <div><strong>1</strong><span>Approval waiting</span></div>
              <div><strong>3</strong><span>Mentions</span></div>
              <div><strong>2</strong><span>Agent sessions</span></div>
              <div><strong>18</strong><span>Credential uses</span></div>
            </div>
          </section>

          <div className="columns">
            <section>
              <div className="section-heading"><h2>Needs you</h2><button type="button">View inbox</button></div>
              <div className="panel rows">
                <article className="row">
                  <span className="row-icon violet-soft"><KeyRound size={18} /></span>
                  <div className="row-copy"><strong><code>PROD_DB_URL</code><span className="pill amber">Approval</span></strong><span>@a.releasebot wants to run the payments backfill · 4:38 left</span></div>
                  <button className="primary" type="button">Review</button>
                </article>
                <article className="row">
                  <span className="row-icon coral-soft"><AtSign size={18} /></span>
                  <div className="row-copy"><strong>Daniel Park mentioned you</strong><span>#engineering · “Can you sign off the rollout plan?”</span></div>
                  <span className="time">9:15</span>
                </article>
                <article className="row">
                  <span className="row-icon blue-soft"><MessageCircle size={18} /></span>
                  <div className="row-copy"><strong>New thread reply</strong><span>Priya replied in #releases · 12 minutes ago</span></div>
                  <MoreHorizontal size={18} className="muted" />
                </article>
              </div>

              <div className="section-heading spaced"><h2>Catch up</h2><button type="button">All channels</button></div>
              <div className="panel rows compact">
                <article className="row"><Hash size={18} className="muted" /><div className="row-copy"><strong>engineering <span className="badge inline">2</span></strong><span>Failed-charge retry rollout</span></div><Users size={17} className="muted" /></article>
                <article className="row"><Hash size={18} className="muted" /><div className="row-copy"><strong>releases</strong><span>@a.releasebot posted a deploy summary</span></div><span className="time">06:02</span></article>
              </div>
            </section>

            <section>
              <div className="section-heading"><h2>Agent activity</h2><button type="button">All agents</button></div>
              <article className="panel live-card">
                <div className="live-head">
                  <span className="avatar agent large"><Bot size={18} /></span>
                  <div><strong>@a.releasebot <span className="pill live">Live</span></strong><span>Claude Code on maya-mbp · 6m</span></div>
                  <button type="button" className="secondary">Stop</button>
                </div>
                <div className="flight-path"><span /><span /><span /><span /></div>
                <p>Answering Daniel in #engineering. Used <code>STAGING_DB_URL</code> once.</p>
              </article>

              <article className="panel overnight">
                <div className="mini-heading"><strong>Overnight</strong><span>3 sessions</span></div>
                <div className="agent-row"><span className="avatar agent"><Bot size={14} /></span><div><strong>@a.triage</strong><span>Cleared 11 support mentions</span></div><span className="badge gray">4 waiting</span></div>
                <div className="agent-row"><span className="avatar agent peach"><Bot size={14} /></span><div><strong>@a.docs</strong><span>Opened 2 handbook PRs</span></div><span className="status-dot" /></div>
              </article>
            </section>
          </div>
        </div>
      </section>
      </main>
    </>
  );
}
