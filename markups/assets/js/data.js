/* Lepidy mockups — fixtures + page manifest. One source of truth so every
   screen tells the same story with the same people, agents and credentials. */

window.LEPIDY = (function () {

  const PAGES = [
    { id: "home",       file: "home.html",       name: "Home",              group: "Workspace",
      note: "The ranked feed. What needs you, and what your agents did while you were away." },
    { id: "channel",    file: "channel.html",    name: "Channel",           group: "Workspace",
      note: "The core view. Note the AGENT badge, the provenance chip, and the live-session flight path." },
    { id: "dm",         file: "dm.html",         name: "Direct message",    group: "Workspace",
      note: "Two people, a code block, and a link to the board. It has to be a good messenger first." },
    { id: "queue",      file: "queue.html",      name: "Work queue",        group: "Workspace",
      note: "Form intake + one-vote-per-person ranking + owner-defined statuses. Click a \ud83d\udd25 to re-rank it." },
    { id: "search",     file: "search.html",     name: "Search",            group: "Workspace",
      note: "Operators you already know. Spans people, agents, files and form entries \u2014 never credential values." },
    { id: "inbox",      file: "inbox.html",      name: "Inbox & approvals", group: "Workspace",
      note: "Mentions, threads and credential approvals in one list. An approval is a message, not a separate rail." },
    { id: "notifications", file: "notifications.html", name: "Notifications & focus", group: "Team",
      note: "The differentiated bit: agents notify at a lower tier than people, and only approvals beat focus." },
    { id: "people",     file: "people.html",     name: "People & groups",   group: "Team",
      note: "The directory, local time, focus state, groups, and the seat boundary on the free plan." },
    { id: "agents",     file: "agents.html",     name: "Agents",            group: "Agents",
      note: "The promoted rail item. Every agent, its owners, its scope, its queue depth and where it runs." },
    { id: "agent",      file: "agent.html",      name: "Agent detail",      group: "Agents",
      note: "Owners, the standing brief, the compiled-in security preamble, scope, and the interaction list." },
    { id: "runtime",    file: "runtime.html",    name: "Agent runtime",     group: "Agents",
      note: "Connected / Local / Claude Cloud / Custom \u2014 harness presets, and the cron schedule." },
    { id: "vault",      file: "vault.html",      name: "Vault",             group: "Vault",
      note: "Every credential, its disclosure tier, its policy and who may use it. The kill switch is in the header." },
    { id: "credential", file: "credential.html", name: "Credential detail", group: "Vault",
      note: "Disclosure tiers, the ACL's three verbs, live grants with countdowns, and the access log." },
    { id: "sessions",   file: "sessions.html",   name: "Devices & sessions",group: "Account",
      note: "Concurrent logins by design. Client sessions and runner registrations are revoked separately." },
    { id: "mobile",     file: "mobile.html",     name: "Phone approval",    group: "Account",
      note: "The approvals companion. Ask from a bus stop, approve with Face ID, watch the laptop do the work." },
    { id: "signin",     file: "signin.html",     name: "Sign in",           group: "Account",
      note: "Our own accounts. Google is a way in, never the identity." },
    { id: "pricing",    file: "pricing.html",    name: "Pricing",           group: "Marketing",
      note: "Agents are free; humans are the meter. The free tier is a whole product." }
  ];

  const NAV = [
    { id: "home",    label: "Home",    icon: "home",   href: "home.html" },
    { id: "inbox",   label: "Inbox",   icon: "inbox",  href: "inbox.html", badge: "3" },
    { id: "agents",  label: "Agents",  icon: "agent",  href: "agents.html" },
    { id: "vault",   label: "Vault",   icon: "key",    href: "vault.html" },
    { id: "explore", label: "Explore", icon: "search", href: "#" }
  ];

  const CHANNELS = [
    { id: "eng",     name: "eng",     unread: 0 },
    { id: "billing", name: "billing", unread: 2 },
    { id: "support-queue", name: "support-queue", unread: 0, queue: true },
    { id: "release", name: "release", unread: 0 },
    { id: "support", name: "support", unread: 0 },
    { id: "design",  name: "design",  unread: 0, priv: true }
  ];

  const PEOPLE = [
    { id: "maya",   name: "Maya Chen",   handle: "maya",   status: "on"   },
    { id: "daniel", name: "Daniel Park", handle: "daniel", status: "busy" },
    { id: "priya",  name: "Priya Singh", handle: "priya",  status: "off"  }
  ];

  const AGENTS = [
    { id: "releasebot", handle: "a.releasebot", name: "Release Bot",
      desc: "Watches deploys, answers what shipped and when.",
      owners: ["Maya Chen", "Daniel Park"], scope: "listed", rooms: ["#eng", "#release"],
      runtime: "local", harness: "Claude Code", runner: "maya-mbp",
      queue: 1, session: "waiting", creds: ["GITHUB_TOKEN", "STAGING_DB_URL"] },
    { id: "triage", handle: "a.triage", name: "Triage",
      desc: "First read on inbound support. Summarises, tags, escalates.",
      owners: ["Priya Singh"], scope: "listed", rooms: ["#support"],
      runtime: "claude_cloud", harness: "Claude Managed Agent", runner: null,
      schedule: "Every day at 02:00 America/New_York",
      queue: 4, session: "idle", creds: ["SENTRY_TOKEN"] },
    { id: "research", handle: "a.research", name: "Market Research",
      desc: "Finds, reads and synthesises. Cites everything.",
      owners: ["Maya Chen"], scope: "any", rooms: [],
      runtime: "claude_cloud", harness: "Claude Managed Agent", runner: null,
      schedule: null,
      queue: 0, session: "idle", creds: [] },
    { id: "docs", handle: "a.docs", name: "Docs Keeper",
      desc: "Keeps the handbook honest. Opens PRs against the docs repo.",
      owners: ["Daniel Park"], scope: "listed", rooms: ["#eng"],
      runtime: "local", harness: "Codex", runner: "dan-desktop",
      queue: 0, session: "idle", creds: ["GITHUB_TOKEN"] }
  ];

  const CREDS = [
    { name: "GITHUB_TOKEN", desc: "Repo and PR access for the api and docs repos",
      tier: "server", mode: "auto", ttl: "1 hour", tags: ["dev"],
      uses: 128, last: "12 min ago", expires: null, owners: ["Maya Chen"] },
    { name: "STRIPE_LIVE_KEY", desc: "Live payments",
      tier: "human", mode: "ask", ttl: "15 min", tags: ["payments", "prod"],
      uses: 6, last: "2 days ago", expires: null, owners: ["Maya Chen"] },
    { name: "STAGING_DB_URL", desc: "Staging Postgres, read-write",
      tier: "server", mode: "ask", ttl: "15 min", tags: ["db"],
      uses: 41, last: "1 hour ago", expires: null, owners: ["Daniel Park", "Maya Chen"] },
    { name: "SENTRY_TOKEN", desc: "Issue read for triage",
      tier: "server", mode: "auto", ttl: "session", tags: ["observability"],
      uses: 302, last: "4 min ago", expires: null, owners: ["Priya Singh"] },
    { name: "ANTHROPIC_API_KEY", desc: "CI and scripts. Cloud agents run on your own Anthropic account.",
      tier: "server", mode: "auto", ttl: "session", tags: ["agents"],
      uses: 1904, last: "just now", expires: null, owners: ["Maya Chen"] },
    { name: "NPM_PUBLISH_TOKEN", desc: "Publishes the CLI package",
      tier: "human", mode: "ask", ttl: null, tags: ["release"],
      uses: 3, last: "3 weeks ago", expires: "in 9 days", owners: ["Daniel Park"] }
  ];

  return { PAGES, NAV, CHANNELS, PEOPLE, AGENTS, CREDS };
})();
