# Lepidy — High-Level Design

**Status:** Draft for review
**Author:** Rob Righter (with Claude)
**Date:** 2026-09-05
**Companion to:** [`PRD.md`](./PRD.md) — read that first; this document assumes it
**Platform facts verified against Cloudflare docs:** 2026-09-05

---

## 1. Scope

This document decides **how Lepidy is built**, and one question dominates it: *where does a tenant's data live, and what stops it reaching another tenant?* Everything else in here follows from the answer.

**In scope:** the tenancy model, the data architecture, realtime, the request lifecycle, identity and sessions, key custody, the runner and Claude Cloud protocols, the MCP server, failure and recovery, and the performance budgets each of those has to hit.

**Out of scope, deliberately:** the UI component architecture (the mockups in `markups/` are the spec), the marketing site, and anything the PRD lists as v2.

**Where this document disagrees with the PRD, the PRD is wrong and should be corrected** — the PRD describes what we are building, and this describes what is actually possible on the platform we chose.

---

## 2. System context

### Accepted hosting decisions

- **Next.js App Router on Cloudflare Workers via OpenNext.** Preserve useful components, routing, initial server rendering, loading states, and error boundaries from `../slip-robotics-chat`. Vite is not the selected application architecture. Next.js is the presentation and transport layer; server components, actions, and route handlers call the same workspace authority rather than implementing separate business rules.
- **One isolated Durable Object per workspace, with plan-specific authority.** A Team object owns tenant content, policy, transactional mutations, search and realtime. A Solo object persists channel/authorization metadata and relays encrypted content frames to one designated computer whose local SQLite database is authoritative. See [`docs/free-local-workspace-contract.md`](./docs/free-local-workspace-contract.md).
- **D1 is the shared control plane:** accounts, sessions, membership, routing, devices, billing. **R2** holds plan-appropriate files and exports; **Queues** delivers background work; **Secrets Store** holds service signing and provider integration keys only, never a vault decryption root. **KV is restricted to non-authoritative caches**, such as immutable routing metadata and public provider metadata.
- **Lepidy does not host agent execution.** Local execution runs on customer machines; cloud execution runs in the customer's provider account. Customer-funded execution is distinct from Lepidy's storage and coordination costs.
- **Allow idle workspaces to stop accruing duration charges.** Use hibernating WebSockets. An open client or a harness working elsewhere must not require a continuously pending workspace request. The exact session-wait transport remains a prototype decision (§10.1).

These decisions supersede the earlier frontend comparison, session-cache proposal and server-decryptable vault design. Runner failover, vault owner sharing and the provider authorization mechanism remain explicit engineering decisions in §18.

```
   ┌────────────┐   ┌────────────┐   ┌────────────┐   ┌────────────┐
   │  Browser   │   │  Desktop   │   │  lepidy    │   │  Claude    │
   │  (PWA)     │   │  (Tauri)   │   │  CLI/agentd│   │  Managed   │
   └─────┬──────┘   └─────┬──────┘   └─────┬──────┘   │  Agents    │
         │ HTTPS+WS       │ HTTPS+WS       │ HTTPS+WS └─────┬──────┘
         │                │                │                │ webhook
         └────────────────┴────────┬───────┴────────────────┘ + MCP
                                   ▼
                    ┌──────────────────────────────┐
                    │   Worker (one, global)       │
                    │   routing · auth · MCP RS/AS │
                    │   webhook receiver · proxy   │
                    └──────┬─────────────────┬─────┘
                           │                 │
              ┌────────────▼──────┐   ┌──────▼─────────────────────┐
              │  D1 — CONTROL     │   │  Workspace DO — DATA PLANE │
              │  PLANE (one)      │   │  (one per workspace)       │
              │                   │   │                            │
              │  accounts         │   │  SQLite: channels, msgs,   │
              │  sessions         │   │  members, agents, queue,   │
              │  workspaces       │   │  vault ciphertext, audit,  │
              │  memberships      │   │  FTS5 index                │
              │  devices          │   │                            │
              │  billing          │   │  WebSockets (hibernating)  │
              │                   │   │  Alarms · kill switch      │
              │  never a message  │   │                            │
              │  never a secret   │   │  ≤ 10 GB, isolated         │
              └───────────────────┘   └──────┬─────────────────────┘
                                             │
                    ┌────────────┬───────────┴──────┬──────────────┐
                    ▼            ▼                  ▼              ▼
              ┌─────────┐  ┌──────────┐     ┌────────────┐  ┌───────────┐
              │   R2    │  │    KV    │     │  Secrets   │  │  Queues   │
              │  files  │  │  cache   │     │   Store    │  │  fan-out  │
              │ prefix  │  │          │     │ signing    │  │           │
              │ prefix  │  │          │     │            │  │           │
              └─────────┘  └──────────┘     └────────────┘  └───────────┘
```

Five client kinds, one Worker, and a hard split between a **control plane** that knows *who exists* and a **data plane** that holds *what they wrote*. For Solo, the content portion of that data plane runs on the designated host and the workspace object is its cloud metadata/relay peer.

---

## 3. Tenancy — the spine of this design

### 3.1 Neither reference app's model survives, and it is worth being precise about why

| | `slip-robotics-chat` | `agent-vault` | Lepidy needs |
|---|---|---|---|
| Tenants | **One.** A single workspace, one Google Workspace domain, one Postgres | **One.** One human, one laptop, one file | **Many, mutually untrusting** |
| Isolation | None needed — everyone in the database belongs to the same company | The OS user boundary | **Structural, enforced by the platform** |
| Secrets | None. It holds messages | Everything, locally, behind a password only the owner knows | **Other people's credentials, on our infrastructure** |
| Deletion | Never contemplated | `rm ~/.agent-vault` | **A legal obligation with a deadline** |
| Residency | Irrelevant | Irrelevant | **Sellable in the EU** |

Both reference apps are *single-tenant designs that happen to have users*. Lepidy is a multi-tenant service that holds credentials, and those are different products at the architecture layer even where they look identical at the UI layer.

### 3.2 The requirement that decides everything: isolation is structural, not a `WHERE` clause

The obvious port is one shared database with `workspace_id` on every table. It is what most SaaS does, it is what both reference schemas would become with one added column, and **it is not acceptable here.**

In that design, tenant isolation is a property of *every query a developer ever writes*. One missing `AND workspace_id = ?` — in a hand-written join, in a migration backfill, in an admin tool, in a query an agent generated — is a cross-tenant data leak. For a chat app that is a bad day. **For a product whose database contains the ciphertext and the policy for other people's production credentials, it is the end of the company.**

So the requirement is:

> **A query executing on behalf of workspace A must not be *able* to return workspace B's rows, regardless of how it is written.**

That rules out shared tables. It leaves database-per-tenant, and on Cloudflare there are exactly two ways to do that.

### 3.3 The Team decision: one Durable Object per workspace, SQLite-backed

**A Team workspace *is* a Durable Object.** Its SQLite database is the system of record for everything the workspace contains. There is no shared table anywhere that holds content from multiple tenants.

For a paid Team workspace this object is the complete tenant authority described below. Solo deliberately uses the split in §3.3a.

### 3.3a Solo: cloud metadata and relay, host-owned content

A Solo workspace still has one isolated workspace object. That object stores principals and channel metadata, host authority and relay protocol state. One designated desktop or laptop stores messages, reactions, attachments, search, content-bearing agent state and vault data in local SQLite. The host maintains an outbound hibernatable WebSocket; remote web, mobile, desktop, MCP and cloud-agent clients reach it through the object without an inbound port.

The relay forwards authenticated, encrypted transient frames. It does not persist content for retry: if the host is offline, a content operation returns `host_offline`. Channel navigation and host status remain available from cloud metadata. The host commits a local transaction before acknowledging a mutation and persists its request id, preserving read-after-write and idempotent retry on that authority.

D1 names the designated host and a monotonically increasing host epoch. The workspace object grants one writer lease for that epoch, so a replacement device fences the former host and delayed frames cannot write. Host transfer, lost-host recovery and resumable conversion to Team follow the [free local workspace contract](./docs/free-local-workspace-contract.md).

The alternative was one D1 database per tenant. Here is the comparison against verified platform limits, because this is the decision the whole document rests on:

| | **Workspace DO (SQLite)** | D1 per tenant |
|---|---|---|
| Isolation | Structural — separate object, separate database | Structural — separate database |
| Max tenants | **Unlimited objects per namespace** | 50,000 databases per account (paid) |
| **Dynamic addressing** | **Native — `getByName()` / `idFromString()`, no binding needed** | **Bindings are static, ~5,000 max per script** — needs the REST API or Workers for Platforms |
| Size ceiling | 10 GB per object | 10 GB per database, **cannot be raised** |
| Full-text search | **FTS5 supported, including `fts5vocab`** | FTS5 supported |
| Realtime | **Same object holds the WebSockets** | Separate system; needs a DO anyway |
| Strong consistency | Single-threaded, serialized | Single-threaded per database |
| Scheduled work | **Native per-tenant alarms** | Needs a global cron fanning out |
| Point-in-time recovery | **30-day bookmark-based restore** | Time Travel |
| Data residency | **`jurisdiction("eu")` on the namespace** | Location is account-level |
| Throughput | ~1,000 req/s soft, per object | Sequential per database |

**Three of those rows decide it.**

**Dynamic addressing.** A Worker script caps at roughly 5,000 bindings, and D1 bindings are declared statically in configuration. A D1-per-tenant design therefore cannot reach its own 50,000-database ceiling through bindings — it needs the D1 REST API on every request (an HTTP hop, not a binding) or Workers for Platforms dispatch namespaces (a much larger machine). A Durable Object namespace addresses an unlimited number of objects by name with no per-tenant configuration at all. **Tenancy stops being a deployment problem.**

**FTS5 works inside the object.** This was the strongest argument *against* putting the system of record in a DO, and it evaporated on checking: Durable Objects' SQLite supports the FTS5 module. So a workspace's search index lives inside the workspace, next to the data it indexes, and cross-channel search is a local query rather than a fan-out. Had this not been true, search alone would have forced a second store per tenant and the design would look very different.

**The sockets are already there.** Realtime needs a coordination point per workspace regardless. Putting storage and sockets in the same object simplifies ordering, but commit and delivery are not atomic. Persist replay events and pending side effects in the mutation transaction, then deliver and retry.

### 3.4 One object per workspace, not one per channel — and this is sized to the business model

The tempting refinement is a DO per *channel*: more concurrency, natural sharding. It is the wrong trade here, for three reasons.

1. **Search and unread would become fan-outs.** Both are cross-channel by definition. With one object they are ordinary SQL against one database.
2. **A message write is not one write.** It inserts the message, updates unread state, may enqueue an agent mention, may touch a queue item's rank, and must reach the sockets. In one object that is one transaction. Across objects it is a distributed transaction we would get wrong.
3. **We do not need the concurrency.** This is the load-bearing point, and it comes from the PRD rather than the platform: **the initial product ceiling is 50 human seats.** A single-threaded object with a ~1,000 req/s soft ceiling, serving at most 50 people, has roughly 20 requests per second per person of headroom. That is not a close call.

**The design is deliberately sized to the plan ladder.** State it plainly so nobody has to rediscover it: if Lepidy ever sells a 5,000-seat workspace, this decision is revisited, and the escape hatch is to split channels into child objects with the workspace object retaining membership, search and the vault. Nothing else in this document changes when that happens.

### 3.5 Addressing and routing

`idFromName()` performs a global uniqueness check that costs **100–300 ms on first access**. That is acceptable once; it is not acceptable on every request to a workspace.

So:

- A workspace is created with `newUniqueId()`, optionally under a jurisdiction.
- **The resulting ID string is stored in the control plane** on the workspace row.
- Every subsequent request resolves `slug → do_id` from D1 (or the KV cache in front of it) and uses `idFromString()`, which does no global coordination.

```
  app.lepidy.com/w/acme/channels/eng
        │
        ├─ 1. path → workspace slug
        ├─ 2. slug → { do_id, jurisdiction, plan } from KV, else D1
        ├─ 3. session cookie → user (§8)
        ├─ 4. membership check: is this user in this workspace?   ← control plane
        └─ 5. env.WORKSPACE.get(idFromString(do_id)).rpc(...)     ← data plane
```

Step 4 is the only cross-plane authorization, and it is deliberately *outside* the tenant object: the object should never have to answer "should this person be talking to me at all," because a bug in that answer inside the tenant is a bug the tenant's own data influences.

### 3.6 Residency and placement

Both fall out of the platform rather than being built:

- **`env.WORKSPACE.jurisdiction("eu").newUniqueId()`** at creation pins a workspace's object — and therefore every message and every credential ciphertext it holds — inside the EU. This is a checkbox at workspace creation and an immutable property afterwards, because moving a tenant between jurisdictions means moving its data, which is a migration and not a setting.
- **`locationHint`** at creation places a workspace near its team, which matters because a Durable Object lives in one place. A distributed team will have someone far from it; that is the accepted cost of strong consistency, and it is why the *read* path caches aggressively (§13).

### 3.7 What the control plane may never contain

An invariant, enforced by review and by a schema test:

> **D1 holds identity, routing and money. It never holds a message, a file, a credential — ciphertext or otherwise — an agent brief, or an audit entry.**

The reason is blast radius. The control plane is the one shared database in the system, so it is the one place where a missing predicate could cross tenants. Keeping it free of content means the worst a control-plane leak can do is disclose *that* a workspace exists and who is in it — never what they said or what they hold.

The membership index is the sharp edge: it necessarily maps users to workspaces, so it is a graph of who works with whom. That is real information and it is the price of being able to answer "which workspaces am I in" without asking every object in the account.

### 3.8 Blast radius, noisy neighbours, and the 10 GB ceiling

**Tenant content and object execution are separated, but account resources are still shared.** D1, Worker/account quotas, downstream services, and the bill require per-workspace rate and resource controls. Isolation is not a guarantee against all noisy-neighbour effects.

**A bad migration breaks one tenant at a time** (§5.2). This is a feature and it changes how we deploy: schema changes roll forward per-object on wake, so a defect surfaces in one workspace before it reaches the rest, and the rest can be halted.

**The ceiling is 10 GB per workspace and it cannot be raised.** For text messages that is on the order of ten million, which no 50-seat team reaches quickly — but it is finite and it is not something to discover at 9.9 GB.

- `ctx.storage.sql.databaseSize` is read on a daily alarm and reported to the control plane.
- Thresholds at 60% (internal alert) and 80% (tell the workspace admins, in the product).
- The escape hatch, unbuilt but designed for: **archive messages older than the hot window to R2 as compressed JSONL, keeping their FTS index rows and a stub in SQLite.** Search continues to find them; opening one fetches from R2. Attachments already live in R2, so this is text only.
- Indexes count toward billing per updated row, and FTS5 is an index. Message volume therefore costs more than the naive row count suggests — budgeted in §13.

### 3.9 Deleting and exporting a tenant

The thing shared-table designs are worst at, and this design is best at.

**Delete:** `storage.deleteAll()` and `storage.deleteAlarm()` on the object, delete the R2 prefix, delete the control-plane rows. The object ceases to exist. There is no sweep across a shared table, no risk of a `DELETE` predicate that is subtly wrong, and no orphaned rows to find later. **This is what makes a 30-day deletion promise something we can actually keep.**

**Export:** the object streams its own SQLite out as JSONL plus an R2 manifest, driven by an alarm so it survives the 30-second CPU limit. A workspace's entire content is one object, so "export everything" is a well-defined operation rather than a query-writing exercise.

**Recovery:** SQLite-backed Durable Objects support **point-in-time recovery to any moment in the previous 30 days** via bookmarks. That is per-tenant restore, which is the correct granularity: a customer who deletes a channel by mistake can be restored without touching anyone else. Vault ciphertext is restored with it — worth noting, because it means a restore reinstates credentials that were deliberately deleted, and that has to be visible in the audit log rather than silent.

---

## 4. Code layout

One Worker, one Durable Object class that matters, and a strict rule about which side of the plane boundary a module may import from.

```
src/
  app/                     Next.js routes, layouts, server components and actions
  components/              shared UI and client-side realtime components
  worker/                  the stateless edge — no business logic
    router.ts              host → workspace, path → handler
    auth/                  session resolution, WebAuthn, OAuth clients
    mcp/                   MCP resource server + authorization server
    hooks/anthropic.ts     the webhook route (exact-match, never redirects)
    proxy/                 the credential-attaching egress proxy (Tier 0)
  control/                 D1 only. Identity, routing, membership, billing.
    schema.ts              Drizzle (sqlite-core) — the control-plane schema
    migrations/            numbered .sql, applied at deploy
  workspace/               THE DURABLE OBJECT. All tenant data lives behind it.
    index.ts               the DO class: RPC surface, alarms, sockets
    schema/                per-tenant SQLite schema + migration chain
    chat/                  channels, messages, threads, reactions, read state
    queue/                 form rooms, ranked feeds, statuses (PRD §9.8)
    agents/                agent rows, the mention queue, sessions, delegations
    vault/                 credential CRUD, policy engine, grants, approvals
    audit/                 the hash-chained log
    search/                FTS5 index maintenance and query
  shared/                  pure functions only. No I/O, no imports from either plane.
    policy.ts              the vault decision pipeline
    visibility.ts          mention visibility, unread, status visibility
    handles.ts             the @, @g., @a. namespace rules
    rank.ts                queue ordering and tiebreaks
```

**`shared/` is where the rules that must be right live**, and it exists because of a lesson the reference app records explicitly: CI runs the unit suite and the database suite is opt-in, so **a rule living inside a write path is a rule nothing on the merge path checks.** Every predicate that decides who may read or write something is a pure function in `shared/` with a table of cases — mention visibility, unread derivation, status visibility, the policy pipeline, handle reservation, queue ranking. The DO calls them; it does not reimplement them.

**Lint rule, enforced:** nothing in `control/` may import from `workspace/`, and nothing in `workspace/` may import from `control/`. The planes talk over RPC and nothing else. This is what keeps §3.7's invariant true as the codebase grows past the point where anyone remembers why.

---

## 5. Data architecture

### 5.1 Where every entity lives

| Entity | Home | Why |
|---|---|---|
| Account, login methods, passkeys | **D1** | A person exists across workspaces |
| Session | **D1** | Read on every request; revocable now (§8) |
| Device (client + runner registrations) | **D1** | Belongs to a person, not a workspace |
| Workspace row: slug, DO id, jurisdiction, plan | **D1** | This *is* the routing table |
| Membership (user ↔ workspace, role) | **D1** | Answers "which workspaces am I in" and gates §3.5 step 4 |
| Subscription, seats, billing source | **D1** | Money is global |
| Webhook event dedupe ids | **D1** | Arrives before we know which tenant, then routed |
| Channel definitions, members and access metadata | **Workspace DO for every plan** | Remote navigation and authorization remain available |
| Team messages, threads and reactions | **Workspace DO** | Structurally isolated cloud tenant content |
| Solo messages, threads and reactions | **Designated host SQLite** | No cloud content persistence; internet access routes through relay |
| Read cursors and unread state | **Team workspace DO / Solo host SQLite, with coarse Solo aggregates in relay metadata** | Content-derived state remains with content |
| Agents, briefs, delegations, mention queue and sessions | **Team workspace DO / Solo host SQLite; identity metadata in every relay** | Content-bearing configuration follows the plan authority |
| Queue items, statuses and votes | **Team workspace DO / Solo host SQLite** | Votes are reactions; same authority |
| Credentials, policy, ACL, grants and approvals | **Team workspace DO / Solo host SQLite unless D05 changes custody** | Secret-bearing data never enters the Solo relay store |
| Audit log | **Team workspace DO / Solo host SQLite** | Hash-chained per tenant authority |
| **FTS5 index** | **Team workspace DO / Solo host SQLite** | Beside what it indexes |
| Files, attachments, avatars, exports | **R2**, `ws/<id>/…` prefix | Bytes don't belong in SQLite |
| Vault ciphertext and wrapped data keys | **Team workspace DO / Solo host SQLite** | The account vault key and recovery code remain user-held; §9 |
| Non-authoritative caches: immutable slug→DO id, public metadata | **KV** | §13 |

Membership appears in both planes, and that is deliberate rather than sloppy: **D1 answers "may this person reach this workspace at all"** (the routing gate), **the DO answers "may this person read this channel"** (the content gate). Two different questions, two different blast radii. The DO's copy is authoritative for anything inside the workspace; D1's is authoritative for the door.

### 5.2 Migrating a schema across N tenant databases

The hardest operational problem this design creates, and the one most likely to hurt.

There is no `ALTER TABLE` that reaches every tenant. Each workspace has its own SQLite, and a workspace that nobody has opened since March is a database at March's schema.

**The implemented pattern:**

```ts
export class Workspace extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      migrateWorkspaceSchema(ctx.storage);
    });
  }
}
```

`migrateWorkspaceSchema` maintains exactly one `_schema` row with `version`, `status` and the last bounded error. Each numbered migration and its compare-and-set version update run inside `storage.transactionSync`. A thrown statement therefore rolls back the entire migration. A separate transaction records the failure in `_migration_failures` and marks that object `quarantined`; subsequent wakes remain quarantined until an operator applies a reviewed recovery. The concrete chain is in `src/cloudflare/workspace-migrations.ts` and the D1 deployment migrations are in `migrations/control/`.

**Rules this imposes, all of them consequences rather than preferences:**

- **Migrations are append-only and never edited after deploy.** A tenant that already ran migration 14 will never run it again; changing it means migration 15.
- **Versions are contiguous and the singleton update is a compare-and-set.** A missing version or concurrent state change quarantines rather than guessing.
- **Every migration must be fast.** It runs inside `blockConcurrencyWhile` on a user's first request after a deploy, and that user is waiting. Anything that rewrites a large table is a *background* migration: add the column, backfill on an alarm, switch the read path when the backfill completes.
- **The read path tolerates both shapes** across a background migration. This is normal expand/contract, but here it must be written that way from the start because we cannot make the whole fleet move at once.
- **Tenants report their version.** The daily alarm sends `schema_version` to the control plane, so we can answer "how many workspaces are behind" and "which ones failed" — a question a single shared database never has to ask.
- **A failed migration quarantines one tenant.** It is caught, recorded, and the object serves a maintenance response rather than a broken one. Nothing else is affected, which is the blast-radius benefit of §3.8 arriving as an operational obligation.
- **Migrations are tested from version zero and every historical version**, plus a deliberately failing fixture that proves partial DDL rolls back and one tenant's quarantine does not affect another.

### 5.3 Search

FTS5 lives in the workspace object.

- One external-content FTS5 table over messages, mirrored by triggers, with a second table for form-entry field values so a queue is searchable by its structured answers.
- **Every FTS5 row update is a billable row write.** Message volume therefore costs roughly twice what the message table alone suggests; budgeted in §13, and the reason the index carries the fields we search rather than everything we store.
- Operators (`from:`, `in:`, `has:code`, …) parse in `shared/` into a structured query, then compile to SQL. The parser is pure and table-tested; a search operator that silently matches nothing is the kind of bug users never report and simply stop trusting.
- **Visibility is applied in the query, not after it.** Private channels the viewer isn't in, DMs they aren't party to, and items under a private status (PRD §9.8) are excluded by predicate. Filtering after ranking leaks existence through result counts.
- **The vault is not in the index.** Credential names and descriptions are; values have never been written to it and there is no code path that could. §14 makes this a test rather than a promise.

### 5.4 Files

R2, keyed `ws/<workspace_id>/<yyyy>/<mm>/<uuid>/<filename>`. The workspace id is in the key prefix, so an object's path is itself a tenancy assertion and a mis-scoped listing cannot span tenants.

Uploads are direct to R2 via a presigned URL the DO issues after checking membership and quota; the DO records the metadata row when the client confirms. Downloads are presigned, short-lived, and issued only after the same check. **Bytes never pass through the Durable Object** — a 2 MB row limit and a 30-second CPU budget are not where file transfer belongs.

---

## 6. Realtime

WebSockets terminate on the workspace object, using the **Hibernation API** so an idle workspace with fifty connected tabs costs nothing while nobody is typing.

```
client ──WS──▶ Worker ──▶ Workspace DO
                             │
                             ├─ ctx.acceptWebSocket(ws, [userId, deviceId])
                             │    tags survive hibernation; they are how the
                             │    object knows who a woken socket belongs to
                             │
                             ├─ webSocketMessage() — typing, presence, acks
                             └─ broadcast() — after every committed write
```

**One rule governs all of it: persist, then broadcast.** The SQLite write commits inside the same object that owns the sockets, so a client can never be told about a message that isn't durable, and the ordering clients observe is the ordering the database has. This is the property that made §3.3 choose one object over two systems.

What flows over it: new and edited messages, reactions (and therefore live queue re-ranking), typing, presence, read-state changes across a person's own devices, agent session state (`starting → running → waiting → idle`), approval requests and their resolutions, and kill-switch state changes.

**Fan-out is filtered per socket, not per broadcast.** A message in a private channel is sent only to sockets tagged with a member's id; an item under a private status only to sockets whose user is on its allow-list. The filter calls the same pure function the query path uses (`shared/visibility.ts`), because two implementations of a visibility rule eventually disagree and the disagreement nobody notices is the one where the socket is looser than the query.

**Reconnection is cursor-based.** A client reconnects with the last event sequence it saw; the object replays from its event table or, past the retention window, tells the client to refetch. No "you missed some messages" state and no silent gaps.

---

## 7. Request lifecycle — posting a message

The path worth tracing, because every hard part of the system is on it.

```
1.  POST /api/channels/eng/messages           Worker
2.  host → slug → { do_id } from KV           ~1ms  (D1 fallback ~5ms)
3.  cookie → session → user                   §8 — authoritative D1 read
4.  membership(user, workspace)?              D1 — the routing gate (§3.5)
5.  stub.postMessage({ user, channel, body }) RPC into the tenant
    ─────────────────────────────────────────────────────────────────
6.    isChannelMember(user, channel)?         DO — the content gate
7.    BEGIN
8.      INSERT INTO messages …
9.      UPDATE required read-state aggregates; avoid per-member fan-out
10.     INSERT INTO messages_fts …            (trigger)
11.     classify mentions → people / @g. / @a.
12.     INSERT INTO agent_mentions …          subject to the three brakes
13.     INSERT audit, replay event, pending push/wake records
14.    COMMIT
15.    broadcast() to filtered sockets         persist-then-broadcast
16.    ctx.waitUntil(queue.send(pushFanout))   push leaves the hot path
17.    if an agent was mentioned and idle:
         ctx.waitUntil(wakeRunner(agentId))    §10
    ─────────────────────────────────────────────────────────────────
18. 201 + the created message
```

Steps 7–14 are **one SQLite transaction inside one object**. Everything a message write must do atomically — the row, the unread counters, the search index, the agent queue, the audit entry — commits or doesn't, together. In a shared-database design with a separate realtime system, that is five systems and a distributed-transaction problem; here it is a `BEGIN`.

Pending records commit with the message. Steps 16 and 17 attempt delivery after commit; failures remain pending for alarm-driven retry. Delivery is off the response path, via `ctx.waitUntil`, because a push provider being slow must never make sending a message slow.

---

## 8. Identity, sessions and authorization

### 8.1 Three questions, deliberately separated

| Question | Answered by | Cost |
|---|---|---|
| **Who is this?** | Session row in D1 | Every request |
| **May they reach this workspace?** | Membership in D1 | Every request |
| **May they do this, here?** | The workspace DO | Every request, in-object |

The first two are control plane, the third is data plane, and no request skips any of them.

### 8.2 Authoritative sessions and approval gestures

The accepted origin, cookie, passkey, tenant-local author, linking and revocation rules are normative in [`docs/identity-tenant-contract.md`](./docs/identity-tenant-contract.md). Workspace URLs use `https://app.lepidy.com/w/{workspace_slug}/…`, the WebAuthn RP ID is `app.lepidy.com`, and the browser uses a host-only `__Host-lepidy_session` cookie. This keeps one account and passkey boundary across every workspace.

Resolve sessions and workspace membership from authoritative D1 reads, without KV session caching. If read replication is enabled, authorization must explicitly use the primary/fresh path. Indexed reads are inexpensive; do not trade revocation correctness for speculative savings. The former 10-second KV TTL guarantee was invalid: KV is eventually consistent and its minimum read-cache TTL is 30 seconds. [KV documentation](https://developers.cloudflare.com/kv/api/read-key-value-pairs/)

Next.js must not cache session decisions, grants, approvals, or permission-sensitive workspace responses across requests or users. Public static assets can be cached normally. Workspace content is initially fetched through authorized calls and subsequently refreshed by realtime events or explicit refetches.

Human approval and authority changes require a fresh user-verified WebAuthn gesture; subsequent device/session requests under a valid grant recheck policy and revocation without asking for another human gesture on every use. The exact step-up action matrix remains to be finalized. A browser session, runner registration, and delegation are distinct credentials.

Existing WebSockets need explicit revocation propagation and live checks on privileged operations; a successful handshake is not perpetual authorization. The cross-plane revocation and disconnected-runner lease protocol must be tested before release.

### 8.3 Login methods and the linking rule

Accounts are ours (PRD §13.1). Password verification uses **Argon2id compiled to WASM, executed in the Worker** — login is not a hot path, and Workers' SubtleCrypto offers PBKDF2, which is not what should stand in front of a vault. Google is an OAuth client only; the dance returns a verified email and we do the rest.

Verified email is required to create or add an address, but it is not sufficient to merge accounts. Linking requires a fresh authenticated session, step-up with an existing strong method, proof from the new provider and explicit confirmation. A matching verified email starts that flow; it never silently joins two accounts. The rule lives as a pure function in `shared/` with integration coverage for collisions and replay.

Workspace content uses an immutable tenant-local `member_id`, never the global D1 `account_id`. D1 gates entry; the workspace copy gates content. Membership changes are versioned, durable control operations: privilege increases wait for the object's acknowledgement, while reductions fail closed at D1 and revoke sockets, delegations and grants in the object. Account recovery increments a global security epoch and remains locked until all workspace revocations acknowledge. The full protocol and test invariants are in the identity contract.

---

## 9. The vault in a multi-tenant world

### 9.1 The key hierarchy, and where each key actually is

```
  Trusted client
       Account Vault Key (AVK), random 32 bytes
          │
          ├─ encrypts ─▶ account ECDH private wrapping key
          │                       │
          │                       └─ opens custodian-specific DEK wraps
          │                                            │
          │                                            └─ AES-256-GCM(value)
          │                                               AAD = ws ‖ cred ‖ version
          │
          ├─ device wrap ────────────────▶ enrolled device secure storage
          │
          └─ recovery wrap ──────────────▶ cloud ciphertext
                   ▲
                   └─ key derived locally from the user-held recovery code

  Lepidy cloud
       ciphertext · public keys · custodian/device/recovery wraps · salts · KDF parameters
       no AVK · no recovery code · no recovery-derived key · no plaintext
```

The AVK and account wrapping keypair are generated on the first signed native client and never cross a Lepidy transport in plaintext. Setup creates a printable recovery code, derives a recovery key locally, uploads only an encrypted AVK recovery package, and requires the user to confirm that the code was saved. Enrollment creates a device-specific wrap through an authenticated client-to-client flow. Credential DEKs are sealed separately to each explicit custodian's public wrapping key. Account password or provider recovery cannot substitute for vault recovery. The normative protocol is the [vault sharing and release contract](./docs/vault-sharing-release-contract.md).

**Rotation.** AVK rotation re-encrypts the account private wrapping key and device packages. Custodian removal creates a new credential DEK and ciphertext version because the former custodian may retain the old DEK. The server coordinates epochs and stores new ciphertext but never sees private keys, AVKs or DEKs. A stale device cannot publish an old wrap after the epoch advances.

### 9.2 Where the plaintext exists, exhaustively

The list must be short enough to state, or the design is wrong:

1. In an unlocked trusted client, for the duration of a local decrypt.
2. In the injecting child process's environment, on the user's own machine (`lepidy run`).
3. In an outbound request header on an enrolled release device, for the duration of one fetch.
4. In a signed native client, briefly, for explicit reveal and reveal-once.

**Nowhere else, and specifically:** never in a Worker, Durable Object, D1, KV, R2, Queue, remotely served browser page, server log, audit entry, FTS index, cloud broadcast, support tool, backup or MCP tool result.

### 9.3 The device-mediated egress proxy (Tier 0)

The cloud components authorize and relay; an enrolled, unlocked release device performs the credential-bearing fetch. Flow: the agent calls `proxy_request` over MCP → the workspace authority evaluates metadata policy and issues a single-use request id → an end-to-end encrypted request goes to the release device → the device rechecks the credential ACL, host allowlist, redirect policy, rate limit and request id → it unwraps locally, performs the fetch and redacts the response → an encrypted response returns through the relay → the workspace authority atomically records usage and audit metadata.

The request contains no server-selectable header value or executable input. Redirects are checked on the release device at every hop. The cloud never receives the vault key, credential plaintext or unredacted authorization headers. No online release device means `vault_device_unavailable`, including for scheduled cloud agents.

### 9.4 The approval path

The normative policy order, ACL composition, signed request tuple, delegation intersection, step-up matrix, batch digest and grant revocation rules live in the [vault authorization and approval contract](./docs/vault-authorization-contract.md). The workspace authority evaluates metadata and records decisions; an unlocked client or release device performs any cryptographic release.

Approvals are the one flow that spans a person's devices rather than a workspace's clients, and they are strongly consistent because they live in the DO:

1. A request creates an `approvals` row and broadcasts to every socket belonging to any owner of the credential.
2. Push fan-out goes through Queues to devices in the control plane (approvals are the one notification that ignores focus).
3. **First answer wins**, by a conditional update inside the object: `UPDATE approvals SET state=? WHERE id=? AND state='pending'` returning affected rows. Zero rows means somebody else already decided, and the second device is told who and what rather than being allowed to decide twice.
4. Allowing requires a fresh WebAuthn user-verified assertion (§8.2), verified in the Worker, with the assertion's freshness bound into the RPC to the object.
5. The timeout is the object's **alarm**, not a cron — the object that owns the approval owns its expiry.

### 9.5 The kill switch

A boolean in the workspace object, read on the same path as every policy decision. Because the object is single-threaded and holds both the flag and the credentials, "off" is genuinely immediate: there is no cache to invalidate and no replica to catch up. Flipping it revokes all grants in the same transaction, and broadcasts.

The CLI, the desktop app and the push notification action all reach the same object, so the three independent paths PRD §8.7 requires are three routes to one authority rather than three copies of a flag.

---

## 10. Agent runtimes

### 10.1 The runner protocol (local sessions)

The runner — desktop app or `lepidy agentd` — holds an **outbound WebSocket to its workspace object**. Outbound only: no listening port, no inbound firewall rule, nothing to expose.

```
runner ──WS──▶ Workspace DO
   │
   ├─ hello { device_id, signature, agents[], version }
   ├─ ◀── wake { agent_id }          ← carries NO command (PRD §7.8)
   ├─ session { agent_id, state }    starting → running → waiting → exited
   ├─ heartbeat every 20s
   └─ ◀── stop { agent_id }          kill switch, pause, or admin action
```

**The wake message carries an agent id and nothing else.** The runner looks up what to execute in its own local policy. This is the property that makes a compromised Lepidy unable to run code on a customer's laptop, and it is worth restating here because it is an architectural invariant, not a UI choice: *no code path anywhere may add a command to a wake message.*

**Session reuse uses local waiting plus short claims.** Parking `agent_next(wait_ms)` inside the workspace object would prevent hibernation for the duration of the request. Instead, the harness waits locally; a metadata-only WebSocket wake causes the runner to make a short claim request. A pending HTTP/RPC response is never treated as a hibernatable continuation. [Cloudflare lifecycle documentation](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)

The normative claim, lease, completion, retry, idle, disconnect and session-token rules are in the [runner and queue contract](./docs/runner-queue-contract.md). The cost shape is a hibernating runner WebSocket carrying wake notifications followed by short claim requests. D03 must demonstrate the local waiting adapter, cancellation and reconnect with the real harnesses; it may not add an always-awake object per agent.

Use WebSocket auto-responses for suitable keepalives. Avoid persisting every heartbeat; persist meaningful state transitions and periodic last-seen checkpoints. Presence freshness, lease renewal, and revocation bounds must still satisfy their explicit reliability requirements.

**The exit race** (PRD §7.8) is closed on the runner: on observing process exit it re-queries queue depth and restarts if non-zero, subject to the local cooldown. It is on the runner rather than the server so that a dropped socket cannot strand work.

### 10.2 Claude Cloud

Two directions, deliberately asymmetric:

- **Outbound** (create a session, create/edit a deployment): from the **Worker**, not the DO — again the six-connection ceiling, and these calls are slow.
- **Inbound content**: over **MCP**, as an ordinary client (§11). Nothing special.
- **Inbound lifecycle**: the webhook route.

The webhook route is `POST /hooks/anthropic`, exact-match, and **it never returns a 3xx** — a redirect auto-disables the endpoint immediately on the first attempt, and on a Worker a trailing-slash redirect is one router change away. There is a test asserting the route returns 2xx or 4xx for every input shape, and it is not optional.

Handling: verify the signature against the raw body (never a re-serialized one), dedupe on the event id in D1, then route to the tenant and **fetch the resource** — payloads are thin and carry no state worth reading.

**Delivery is lossy — three attempts, then dropped silently — so correctness comes from reconciliation, not from receipt.** Each workspace object runs a sweep on its daily alarm: for every session or deployment run it believes is open, fetch and settle. Without it a session shows "working" forever because one delivery failed at 3am, and everything looks fine until it doesn't.

### 10.3 Scheduled work belongs to the tenant, not to a cron

A global cron trigger that fanned out to every workspace would be an O(tenants) sweep on a fixed schedule — the exact shape that stops working at the size we hope to reach.

Instead **each workspace object owns its own alarm.** A DO has one alarm, so the object multiplexes: it keeps a `due_work` table and always sets the alarm to the earliest due item. Scheduled messages, grant expiry, approval timeouts, rotation nags, the reconciliation sweep, the `databaseSize` report and the digest all ride it.

Global cron triggers are then reserved for control-plane work only — billing reconciliation, sending nothing to tenants. **Scheduling scales with tenants automatically, because every tenant brings its own scheduler.**

---

## 11. MCP server

The Worker is both the OAuth 2.1 **authorization server** and the **resource server**, per PRD §12. What tenancy adds:

**Tokens are workspace-scoped.** The audience is the workspace's resource URI, and the opaque token carries a routable workspace prefix. So verification is: parse the prefix → resolve the tenant → the object validates the hash and resolves the grant. **One hop, no shared token table**, and a token that names workspace A cannot be presented to workspace B because the prefix is what routed it.

The acting user is derived from the verified token and only from there; no tool accepts a user id. Every agent and queue tool re-checks ownership and membership live inside the object on every call, so removing an owner cuts their agent off on its next call with no token to revoke.

Rate limits are per `(connection, agent)` and live in the object, which makes them strongly consistent rather than per-isolate approximations — a real improvement on the reference app, where the limiter is in-memory per function instance.

---

## 12. Consistency, failure and recovery

**Read after write:** a successful committed write followed by a read from the same workspace object sees that write or a newer update. There is no replica-lag window on that path. Storage is transactional and strongly consistent; default output gates prevent acknowledgement before pending writes are durable. These guarantees do not extend to application caches, a read racing an unfinished write, or a transaction spanning D1 and the DO. [Storage guarantees](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

Use idempotency keys for retried mutations: a lost response does not prove a write failed. Persist event sequence entries and pending push/wake records with the originating mutation. Delivery after commit is retryable, not atomic with the database. Agent queue claims, leases, and completion should be distinct from human read state; finalize that protocol before unattended execution ships.

| Failure | Behaviour | Why acceptable |
|---|---|---|
| Worker isolate dies mid-request | Client retries; the DO transaction either committed or didn't | Atomicity is in the object |
| DO evicted | Rehydrates from SQLite on next access; sockets survive hibernation | Nothing critical is memory-only |
| DO unreachable / relocating | That **one workspace** is briefly unavailable; others unaffected | Blast radius is one tenant, by construction |
| A migration fails | That tenant quarantines and serves maintenance; the fleet is halted | §5.2 |
| D1 control plane unavailable | **Everything stops** — no routing, no sessions | The one true SPOF; §12.1 |
| KV stale | Only non-authoritative metadata is affected; authorization bypasses KV | §8.2 |
| R2 unavailable | Uploads and downloads fail; chat continues | Bytes are out of band |
| Webhook delivery lost | The reconciliation sweep settles it within a day | §10.2 |
| Push provider slow | Message send is unaffected — it is behind `waitUntil` | §7 |

### 12.1 The single point of failure, named

**D1 is the one shared component**, and if it is unavailable nothing routes. Mitigations, in order of cheapness:

- The slug → DO-id mapping is **immutable**, so it caches in KV indefinitely and survives a D1 outage for anyone who has visited before.
- Authoritative session checks fail closed during a D1 outage.
- A client can display content already loaded locally; live reads and writes requiring fresh authorization fail closed. A separate offline authorization mode is not part of this design.

Accepted: a long D1 outage means new sign-ins and first-visits fail. The alternative — putting routing in a DO — moves the SPOF rather than removing it, and loses the ability to answer "which workspaces am I in" without a fan-out.

---

## 13. Performance budgets

Targets, measured at p95 from a client in the workspace's own region:

| Path | Budget | Where it goes |
|---|---|---|
| Send a message → 201 | **< 150 ms** | ~5ms routing, ~5ms auth, one RPC, one transaction |
| Message → other clients' sockets | **< 200 ms** | Same object; no cross-system hop |
| Channel history (50 messages) | **< 120 ms** | One indexed query in-object |
| Workspace search | **< 400 ms** | FTS5 local to the tenant |
| Sidebar / unread summary | **< 100 ms** | Authorized in-object query; client updated by events |
| Vault policy decision | **< 50 ms** | Pure function over in-object state |
| **Kill switch → next request denied** | **< 200 ms** | PRD success criterion; one object, no cache |
| Mention → waiting session receives work | **< 1 s** | Target to validate with the selected wait transport (§10.1) |
| Cold workspace (object asleep) | **< 800 ms** | First request pays wake + migration check |

**Write amplification must be measured.** A message can update indexes, search, audit, replay, notifications, and queue state. Compare cursor-derived unread queries with maintained aggregates before adopting an update for every recipient on every message. Preserve the existing unread semantics. Persist meaningful agent progress rather than every streamed token; avoid per-heartbeat writes. Measure FTS writes with representative content rather than assuming a fixed one-row multiplier.

### 13.1 Tenant economics and resource controls

The accepted model is Next.js, one workspace cloud authority, plan-specific content storage, and customer-funded agent execution. A Team DO owns content; a Solo DO owns metadata and relays opaque frames to host SQLite. Optimize billable idle duration and cloud writes before framework CPU or indexed authorization reads. Reliability features such as scoped tokens, durable pending work, and queue completion records remain required even when they add writes.

Illustrative monthly workload assumptions, not benchmarks or plan limits:

| Input | Quiet solo | Active small team | Busy team |
|---|---:|---:|---:|
| Rows written, including indexes/bookkeeping | 100,000 | 1 million | 10 million |
| Rows read | 1 million | 10 million | 100 million |
| Dynamic Worker requests / DO requests | 50,000 each | 500,000 each | 2 million each |
| Worker CPU per request | 10 ms | 10 ms | 10 ms |
| Billable DO hours | 5 | 50 | 200 |
| Average cloud DO database | metadata only | 1 GB | 5 GB |
| Average cloud R2 attachments | 0 GB | 10 GB | 100 GB |
| Background queue messages, under 64 KB, no retries | 5,000 | 50,000 | 200,000 |
| R2 operation-cost allowance | $0.005 | $0.05 | $0.50 |
| **Illustrative core infrastructure cost** | **$0.21** | **$2.08** | **$15.79** |

Calculation uses published marginal rates before shared allowances and account-level billing rounding: Worker requests $0.30/million and CPU $0.02/million ms; DO requests $0.15/million and duration $12.50/million GB-seconds at 0.128 GB; DO SQLite reads $0.001/million, writes $1/million, storage $0.20/GB-month; R2 standard storage $0.015/GB-month; queue delivery $0.40/million operations with three operations per message. References: [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/), [R2](https://developers.cloudflare.com/r2/pricing/), [Queues](https://developers.cloudflare.com/queues/platform/pricing/).

The $5/month Workers subscription and included allowances are account-wide, not per tenant. These estimates exclude additional control-plane usage, email, observability, builds, payment fees, support, and any Lepidy-funded inference. Background-consumer CPU and retries require measurement. They are not invoices or gross-margin guarantees. A continuously non-hibernating workspace represents about $4.15 of duration usage over 30 days alone, shared across that object's concurrent activity rather than multiplied per agent.

**Accepted commercial allowances:** Solo is free with one human; its messages and attachments use the designated computer's storage, with local disk-health warnings rather than a Lepidy cloud quota. Team is $19/month including five humans, plus $4 per human above five, with 25 GB cloud attachments plus 5 GB per additional seat. Optional 100 GB packs cost $5/month. Warn before storage limits and block new uploads rather than deleting content. Maintain the separate 10 GB Team DO capacity guard. Unlimited agent identities do not imply unlimited automated traffic; publish tested rate and concurrency limits before launch, with no automatic usage overages.

Before public launch, exercise the complete mention → harness → approval → threaded reply flow and a synthetic busy workspace. Attribute writes, active duration, requests, storage, and background work to each workspace. Use aggregated counters or sampled telemetry so cost measurement does not itself produce a write per event. Test idle connected runners, imports, long messages, and agent-heavy workloads independently of human seat count. Apply measurements to the paid-plan margin and the free-workspace subsidy before treating these estimates as forecasts.

---

## 14. Security architecture

### 14.1 What the tenancy model buys, stated as properties

1. **No query can cross tenants**, because there is no shared table containing tenant content (§3.2).
2. **No file listing can cross tenants**, because the workspace id is the R2 key prefix (§5.4).
3. **No broadcast can cross tenants**, because sockets are held by the tenant's own object (§6).
4. **No token can cross tenants**, because the token's prefix is what routes it (§11).
5. **A tenant can be deleted completely**, because it is one object plus one prefix (§3.9).

Each of those is a test, not a convention. In particular there is a test asserting that the control-plane schema contains no column capable of holding tenant content — the mechanical enforcement of §3.7.

### 14.2 What it does not buy

- **A compromised Worker can address every cloud object and disclose cloud-held social metadata and ciphertext.** It cannot derive the account vault key or recovery code. It can still deny service, replay or tamper with traffic, so clients authenticate ciphertext, bind AAD and reject stale epochs.
- **A compromised control plane discloses the social graph** — who is in which workspace — without disclosing any content.
- **A prompt-injected agent operating with a valid delegation is acting with its owner's authority.** Policy bounds it; nothing prevents it.
- **PITR restores deleted credentials.** A 30-day restore reinstates what a customer deliberately deleted, so restores are audited events with an explicit acknowledgement, never a silent operation.

### 14.3 The rules that must be pure

Every predicate below lives in `shared/`, with a case table: mention visibility · unread derivation · channel membership · private-status visibility · handle reservation across the three namespaces · the vault policy pipeline · queue ranking and tiebreaks · the three agent-enqueue brakes · session capability tiering.

They are pure because the DB suite is opt-in and CI is not, and because the same predicate must give the same answer in a query, in a socket fan-out, and in a search filter. **Two implementations of a visibility rule eventually disagree, and the disagreement nobody notices is the one where the looser path wins.**

---

## 15. Observability

Per-tenant, because everything else is:

- Every log line and trace carries `workspace_id`, and **a log line carrying a credential value is a build failure** — a redaction layer scrubs known field names, and a test asserts it.
- The daily alarm reports per-tenant health to the control plane: `schema_version`, `databaseSize`, message and row counts, active agents, failed webhook reconciliations, quarantine state.
- An internal fleet view answers the questions this architecture creates: which tenants are behind on schema, which are approaching 10 GB, which have a stuck migration, which have a runner that has been offline for a week.
- Workers observability for the edge; DO-level metrics per namespace.
- **Audit is not telemetry.** It is tenant data, hash-chained, in the tenant's object, and it is never shipped to an aggregator.

---

## 16. Testing

| Layer | How | Gate |
|---|---|---|
| `shared/` predicates | Vitest, case tables | Every PR |
| Workspace DO | `@cloudflare/vitest-pool-workers`, real DO + real SQLite | Every PR |
| Migrations | Replayed against fixture databases at every historical version | Every PR |
| **Tenant isolation** | Two workspaces, adversarial cases, assert no crossing | **Release gate** |
| Vault leak tests | Grep every log, broadcast, index and tool result for known values | **Release gate** |
| Realtime | Multi-socket, hibernation, reconnect-with-cursor, filtered fan-out | Every PR |
| Agent behaviour | The eval suite from PRD §8.11 | **Release gate** |
| End-to-end | Playwright against a preview deployment | Pre-release |

The isolation suite is the one that must never be quarantined when it is slow. It creates two tenants, gives one a credential and a private channel, and then tries every reachable path from the other: query, search, socket, file, token, MCP tool, webhook. **A green suite is what lets us write §14.1 as facts.**

---

## 17. Build and deploy

Next.js built with the OpenNext Cloudflare adapter and deployed with Wrangler, alongside the workspace DO and required bindings; the control-plane D1 migrations run in `predeploy`; tenant migrations roll forward lazily per object (§5.2). Environments: `dev` (local Miniflare, real DO SQLite), `preview` (per-PR), `staging`, `production`.

**Deploys are not atomic across tenants, and that is the design.** New code reaches every tenant at once, but each tenant's schema migrates on its own next wake. So every deploy must be **backward compatible with the previous tenant schema for at least one release** — new code reads old shape, migration runs, next release may assume the new shape. Nothing else makes a fleet of independent databases safe to deploy against.

---

## 18. Open engineering questions

- **Waiting adapter certification:** the no-park transport and lifecycle are fixed by §10.1 and the runner contract. D03 must demonstrate session reuse, cancellation, reconnect and the exit race against each supported harness.
- **Vault owner sharing:** the user-held AVK and recovery protocol are fixed by §9 and the [vault key and recovery contract](./docs/vault-key-recovery-contract.md). Specify multi-owner envelope distribution, removal and rekeying without creating a server-decryptable wrap before V01.
- **Cloud provider authorization:** specify what credential authorizes session creation and resource fetches in the customer's account, where it is stored, and how it is revoked. Customer-paid execution does not eliminate this integration credential.

- **Does the object need splitting before 50 seats?** §3.4 argues no on a soft 1,000 req/s ceiling. Before GA, load-test one object with 50 simulated users, 500 sockets, a busy queue and two local agents draining, and find the real number rather than trusting the soft one.
- **What exactly does a workspace cost per month?** Row-write billing with FTS5 in the loop is the single largest unknown in the business model, and Free gives away a full-featured workspace. Instrument a synthetic busy tenant for a week before pricing is committed publicly.
- **Archive-to-R2 at the 10 GB ceiling** is designed and unbuilt (§3.8). It needs building before the first tenant passes 60%, not at 95%.
- **Does the Slack import fit the CPU budget?** A 30-second ceiling per DO request and 100 bound parameters per statement mean import is chunked and alarm-driven. Prototype against a real large export early — this is the milestone most likely to discover a platform wall.
- **Is `blockConcurrencyWhile` migration latency acceptable after a long migration chain?** A tenant dormant for a year could run twenty migrations on someone's first click. Consider a compaction step that collapses the chain into a baseline schema periodically.
- **Where does the MCP authorization server's state live?** Auth codes are short-lived and workspace-scoped; the argument for the tenant object is consistency, and for D1 it is that a client registers before a workspace is known. Leaning tenant object with a D1 client registry.
- **Backup beyond 30 days.** The launch default ends at the rolling 30-day recovery boundary. Longer application-managed backups require a separately published retention and pricing policy; the normative deletion/restore rules are in the [retention, residency and recovery contract](./docs/retention-residency-recovery-contract.md).
