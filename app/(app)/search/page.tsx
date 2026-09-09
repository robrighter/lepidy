import { Bookmark, File, KeyRound, MessageSquare, Search, X } from "lucide-react";
import Link from "next/link";

import type { WorkspaceSearchHit } from "@/src/cloudflare/workspace";
import { readCsrfToken } from "@/src/shell/session-cookies";
import { workspaceSearch } from "@/src/shell/search-context";
import { deleteSearchAction, saveSearchAction } from "./actions";

type Params = { q?: string; cursor?: string; notice?: string };

export default async function SearchPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const query = (params.q ?? "").slice(0, 500);
  const [state, csrfToken] = await Promise.all([workspaceSearch(query, params.cursor), readCsrfToken()]);

  if (state.status !== "ready") return (
    <section className="empty-state"><h2>Search is unavailable</h2><p>{state.status === "unavailable" ? state.reason : "Sign in to search this workspace."}</p></section>
  );

  return (
    <div className="search-workspace">
      <section className="search-hero">
        <span className="search-kicker">Workspace retrieval</span>
        <h2>Find the thread behind the work.</h2>
        <p>Messages, file metadata, and credential labels—filtered to what you can see now.</p>
        <form className="search-line" action="/search" method="get" role="search">
          <Search size={20} aria-hidden="true" />
          <label className="visually-hidden" htmlFor="workspace-search">Search workspace</label>
          <input id="workspace-search" name="q" type="search" defaultValue={query} placeholder="Try launch notes, from:@maya, or has:file" autoComplete="off" spellCheck={false} />
          {query ? <Link href="/search" aria-label="Clear search"><X size={17} /></Link> : null}
          <button type="submit">Search</button>
        </form>
        <div className="search-operators" aria-label="Search operators">
          <span>Refine with</span><code>from:</code><code>in:</code><code>before:</code><code>after:</code><code>has:file</code><code>has:link</code><code>has:code</code><code>is:thread</code>
        </div>
      </section>

      {params.notice ? <p className="notice" role="status">{params.notice}</p> : null}
      {state.page.query.errors.length > 0 ? (
        <p className="notice warn" role="alert">{state.page.query.errors.join(" ")}</p>
      ) : null}

      <div className="search-layout">
        <section className="search-results">
          <header className="search-section-head"><div><span>Results</span><h3>{query ? `For “${query}”` : "Start with a word or operator"}</h3></div><strong>{state.page.hits.length}</strong></header>
          {query && state.page.hits.length === 0 && state.page.query.errors.length === 0 ? (
            <section className="search-empty"><Search size={24} /><h3>No visible matches</h3><p>Try a broader term or remove an operator.</p></section>
          ) : (
            <ol className="search-ledger">{state.page.hits.map((hit) => <SearchResult key={`${hit.kind}-${hit.id}`} hit={hit} />)}</ol>
          )}
          {state.page.nextCursor ? (
            <Link className="search-next" href={`/search?${new URLSearchParams({ q: query, cursor: state.page.nextCursor })}`}>Next page</Link>
          ) : null}
        </section>

        <aside className="search-tools" aria-label="Saved searches">
          <header><Bookmark size={17} /><div><h3>Saved searches</h3><p>Your private retrieval shortcuts.</p></div></header>
          {state.saved.length === 0 ? <p className="search-tools-empty">No saved searches yet.</p> : (
            <ul>{state.saved.map((saved) => <li key={saved.id}>
              <Link href={`/search?${new URLSearchParams({ q: saved.query })}`}><strong>{saved.name}</strong><code>{saved.query}</code></Link>
              <form action={deleteSearchAction}><input type="hidden" name="csrfToken" value={csrfToken ?? ""} /><input type="hidden" name="searchId" value={saved.id} /><input type="hidden" name="query" value={query} /><button type="submit" aria-label={`Remove ${saved.name}`}><X size={14} /></button></form>
            </li>)}</ul>
          )}
          <form className="save-search-form" action={saveSearchAction}>
            <input type="hidden" name="csrfToken" value={csrfToken ?? ""} />
            <input type="hidden" name="idempotencyKey" value={crypto.randomUUID()} />
            <input type="hidden" name="query" value={query} />
            <label>Name this search<input name="name" maxLength={80} placeholder="Launch links" required /></label>
            <button type="submit" disabled={!query}>Save current search</button>
          </form>
          <p className="search-safety"><KeyRound size={14} />Credential names and descriptions can match. Secret values never enter search.</p>
        </aside>
      </div>
    </div>
  );
}

function SearchResult({ hit }: { hit: WorkspaceSearchHit }) {
  const common = { message: { icon: MessageSquare, label: "Message" }, file: { icon: File, label: "File" }, credential: { icon: KeyRound, label: "Credential" } }[hit.kind];
  const Icon = common.icon;
  const href = hit.kind === "message" ? `/c/${encodeURIComponent(hit.channelLabel)}#message-${hit.id}` : hit.kind === "file" ? `/files/${hit.id}` : `/vault/${hit.id}`;
  const title = hit.kind === "message" ? hit.authorDisplayName : hit.kind === "file" ? hit.fileName : hit.name;
  const detail = hit.kind === "message" ? hit.bodyMarkdown : hit.kind === "file" ? hit.mediaType : hit.description;
  const provenance = hit.kind === "credential" ? "Vault metadata" : `#${hit.channelLabel}`;
  return <li><Link href={href}><span className={`search-result-icon ${hit.kind}`}><Icon size={17} /></span><span className="search-result-copy"><span className="search-result-meta"><b>{common.label}</b><span>{provenance}</span><time dateTime={new Date(hit.createdAt).toISOString()}>{formatDate(hit.createdAt)}</time></span><strong>{title}</strong><span className="search-result-detail">{detail}</span></span></Link></li>;
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(timestamp);
}
