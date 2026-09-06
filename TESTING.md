# Lepidy local integration testing standard

Status: mandatory for all implementation work from 2026-09-05 onward.

Lepidy treats automated local integration tests as implementation, not follow-up work. Every user-visible behavior, security rule, durable state transition, protocol boundary and supported native action must be exercised by an automated test that runs locally. Unit tests remain useful for dense case tables, but a unit test alone cannot complete a behavior.

## The local gate

Install dependencies and the Chromium test browser once:

```sh
npm install
npx playwright install chromium
```

Run the complete gate from the repository root:

```sh
npm run verify:local
```

The command stops at the first failure and verifies, in order:

1. generated Cloudflare environment types;
2. Worker-runtime integration tests with isolated local storage;
3. application and test type contracts;
4. the Next.js production build;
5. the OpenNext Worker bundle, then the Wrangler deployment dry run;
6. browser integration tests at desktop and mobile sizes, driven against the built Worker;
7. the production dependency audit;
8. formatting, compilation and file-backed SQLite integration tests on the native Tauri target.

On WSL, the final step intentionally uses the host Windows Rust toolchain so the result covers the product's Windows target without requiring Linux GTK/WebKit packages. On macOS, Windows outside WSL, and Linux with Tauri prerequisites, it uses the current host toolchain directly.

## What counts as integration coverage

An integration test crosses the real boundary where a defect could occur:

| Boundary | Required local test |
|---|---|
| Pure product rule used by several callers | A case-table unit test plus at least one Worker/API or UI integration scenario using that rule. |
| Workspace state | Run the exported Durable Object in Cloudflare's Workers runtime with real local SQLite storage. Inspect persisted rows where the invariant concerns storage. |
| D1, KV, R2 or Queues | Use the local Cloudflare binding implementation. Do not replace the binding with an object-shaped mock. |
| HTTP/API/MCP | Call the public transport entry point with signed or authenticated test identities. Assert the response and durable side effects. |
| Browser behavior | Drive the locally started application with Playwright. Cover wide and narrow viewports, keyboard use, error/loading/empty states and accessibility. |
| Tauri behavior | Drive the compiled app with WebdriverIO's Tauri service when native commands land. A browser-mode test may cover rendering, but it does not prove a native command. |
| Rust CLI/runner | Launch the compiled executable against disposable local services. Assert process tree, exit code, files, permissions, redaction and cleanup. |
| External provider | Run Lepidy against a deterministic local HTTP double that implements the provider contract, including retries, invalid signatures, timeouts and ambiguous outcomes. Keep a separately triggered sandbox certification test when the provider offers one. |
| Billing/store behavior | Replay signed local fixtures through the real webhook handler and durable entitlement store. Never call a live purchase endpoint in the normal local gate. |
| Load/recovery | Run seeded multi-tenant scenarios locally with deterministic fault injection, process restart/DO eviction and measured writes, duration and latency. |

Cloudflare's test runtime supplies storage isolation and direct Durable Object access. Playwright starts the built Worker under `wrangler dev`, not `next dev`: the Next.js binding proxy cannot host a Durable Object, and a cross-worker object reached over the dev registry stops answering after the first call. Driving the real Worker also means the browser suite exercises the runtime the product ships on. `scripts/browser-worker.mjs` starts development and production-configured instances with separate disposable D1/DO storage, applies migrations and removes storage on graceful teardown. The test-only wrapper in `tests/fixtures/browser-worker.ts` seeds real channel history through production methods, inserts agent attribution for the not-yet-exposed agent transport, exposes authenticated state counts and acknowledges local queue deliveries as a deterministic sink. Production `custom-worker.ts` does not import that wrapper. Browser account identifiers derive deterministically from the scenario and account ordinal. Tauri's current recommended end-to-end route is WebdriverIO with its Tauri service; it supports an embedded driver on Windows, Linux and macOS.

## Required scenario families

Test names use `<AREA>-INT-<number>` and include the identifier in the test title or a nearby comment. Each ledger record lists the identifiers it added or changed.

| Area | Ledger scope | Minimum automated scenarios before completion |
|---|---|---|
| Foundation | F01–F06 | Production bundles, binding availability, schema history from every retained version, rollback/quarantine, restart, outbox replay, duplicate commands and competing alarms. |
| Identity and tenancy | D01, F04–F05, C07 | Sign-up/link/recovery, invite, last-admin guard, tenant mismatch across HTTP/socket/MCP, device revoke and cross-plane session termination. |
| Chat | C01–C11 | Authorized send/read/edit/delete, idempotent writes, thread/read state, reconnect replay, responsive composer, drafts, notification rules, file visibility, search privacy, ranked queues and resumable import. |
| Agents | D02–D06, A01–A05 | Reserved identities, enqueue/claim/lease/fence/complete, lost wake, crash/retry, delegation expiry, OAuth resource binding, cloud callbacks and duplicate external outcomes. |
| Solo local content | D08a, F03b, C02–C09 | Cloud metadata with no message bodies, host SQLite commit-before-ack, encrypted relay frames, offline failure, stale-host fencing, reconnect, host transfer and Team upgrade migration. |
| Vault | D04–D05, D05a, V01–V08 | Native-client-generated root/recovery material, cloud/browser schema and transport absence, every policy branch, per-custodian wrapping/rekey, ciphertext/AAD/versioning, device enrollment, requester-owner-approver provenance, expiry/revoke, local/cross-device injection, device-mediated proxy, recovery and leak canaries. |
| Runner and desktop | D05a, R01–R05, P01–P04 | Remote trigger schema rejects executable/script/arguments/directory/environment/limit overrides; local edits require real OS verification; process launch/stop/tree cleanup, session reuse, offline stop, Windows/macOS/Linux presets, Tauri IPC allow/deny and distribution capability differences. |
| Billing | B01–B03 | Seat examples 1/2/5/6/20/21/50, storage packs, proration decisions, webhook replay/order, lapse/recovery and preservation of customer data. |
| Operations | D07, O01–O03 | Retention clocks, export/delete, restore without authority resurrection, tenant cost counters, limits, migration quarantine, rollback and redacted diagnostics. |
| Release gates | G01–G05 | The full synthetic-secret product journey, two-tenant adversarial suite, load/fault suite and supported-platform acceptance matrix. |

## Test data and isolation

- Every test creates its own tenant and uses deterministic IDs. Tests may never depend on execution order or a developer's existing local data.
- Credentials are synthetic canaries. Values must be recognizable enough to detect leaks and worthless outside the test.
- Time, random IDs and provider responses are injectable at domain boundaries. Tests exercise expiry and retries without sleeping for wall-clock minutes.
- Each test cleans temporary files and child processes in a `finally`/teardown path. The suite fails when cleanup detects leftovers.
- Network access is denied by default inside tests. A scenario must explicitly register each allowed local or sandbox endpoint.
- Storage fixtures are versioned. Migration tests retain at least one database created by every released schema version.

## Assertions for security-sensitive behavior

A success assertion is insufficient. Each authorization, vault and tenant feature includes paired allow and deny cases. Tests assert that denied or failed operations leave no forbidden rows, queued events, files, grants, logs, notifications or partial external actions. Cross-tenant cases use two valid tenants and valid credentials so they cannot pass merely because the request was malformed.

Leak tests scan HTTP bodies, WebSocket messages, MCP results, browser storage, captured logs, audit metadata, child stdout/stderr and temporary files for the synthetic secret canaries. Redaction tests also cover encoded and line-split output forms defined by the threat model.

Security boundary tests also scan every cloud migration and serialized cloud protocol fixture for vault roots, recovery codes and local launch configuration. The runner suite sends validly authenticated requests containing each forbidden launch field and proves rejection before any process or durable write. Vault setup and recovery tests capture every local cloud-bound request and prove that only ciphertext, wraps, salts and KDF parameters leave the client.

## Flake policy

- Local tests run with zero retries. A failure must remain visible.
- Tests wait on observable state or controlled clocks, never fixed sleeps.
- A flaky test blocks task completion. Quarantine is allowed only for an upstream tool defect with a linked issue, an owner and a replacement release gate; tenant-isolation and leak tests cannot be quarantined.
- Randomized and property tests print their seed so the exact failure can be replayed.

## Ledger evidence contract

A task may move to `done` only when its evidence record includes:

- scenario identifiers and the files containing them;
- the exact local command and passing counts;
- which real boundaries were exercised and which dependencies were deterministic local doubles;
- supported operating systems actually exercised;
- any external sandbox certification still required before release.

Manual review and screenshots can supplement visual judgment, store review and hardware-specific behavior. They do not replace automated functional coverage. If a behavior cannot yet be automated, its ledger item remains `in_progress` or `blocked` with the missing harness named explicitly.

## Current automated baseline

| Scenario | Location | Coverage |
|---|---|---|
| `WORKSPACE-INT-001` | `tests/workspace.test.ts` | Direct RPC to a local SQLite Durable Object and singleton schema persistence. |
| `RUNNER-SEC-001/002` | `src/domain/local-agent-trigger.test.ts` | Exact opaque remote trigger schema and rejection of every local launch-configuration override. |
| `VAULT-AUTH-001–005` | `src/domain/vault-authorization.test.ts` | ACL union plus mandatory intersections, complete unattended delegation, independent reveal rights and exact grants. |
| `SESSION-INT-001` | `tests/authorization.test.ts` | Opaque session/CSRF issuance, individual/global revocation and separation from runner-device lifecycle in real local D1. |
| `DEVICE-INT-001/002` | `tests/authorization.test.ts` | P-256 signed request/body binding, replay and tamper rejection, device revoke, D1 plus tenant-local membership epochs and member-socket closure. |
| `LOCAL-CONTENT-001/002`, `SOLO-TRANSFER-001` | `src-tauri/tests/local_store_integration.rs` | File-backed native SQLite commit-before-ack, reopen/read, request replay/conflict, epoch fencing and checksummed host transfer. |
| `SOLO-RELAY-001–003` | `src/domain/relay-crypto.test.ts`, `tests/workspace.test.ts` | Authenticated opaque content frames, tamper rejection, host lease/offline behavior, directional replay sequences and old-host fencing. |
| `SOLO-UPGRADE-001` | `tests/workspace.test.ts` | Resumable staged snapshot verification and atomic content import/routing-epoch transition to Team. |
| `SCHED-RULE-001–007`, `AUDIT-RULE-001–010` | `src/domain/due-work.test.ts`, `src/domain/audit-chain.test.ts` | Deterministic backoff, earliest-deadline selection, missed-slot collapsing, retention clocks; audit hash coverage of every provenance field, canonical metadata, delimiter forgery, redaction deny list and chain verification including a purged head. |
| `SCHED-INT-001–006` | `tests/scheduler.test.ts` | One alarm multiplexing competing deadlines, duplicate coalescing, per-item backoff and retirement of a handler-less kind, recurring catch-up, alarm rebuilt from durable state across a real Durable Object eviction and the exported `alarm()` handler itself. |
| `OUTBOX-INT-001–008` | `tests/scheduler.test.ts` | One transaction for rows, audit, outbox, replay, deadlines and idempotency receipt; full rollback on failure; replayed request without repeated effects; transient retry, permanent and budget-exhausted dead-lettering; delivery dedupe; the real local Queue binding; membership projection over RPC. |
| `AUDIT-INT-001–003` | `tests/scheduler.test.ts` | Append-only triggers, tamper detection after an operator drops the trigger, daily anchoring and refusal to seal a broken chain. |
| `RETENTION-INT-001/002` | `tests/scheduler.test.ts` | Every D07 expiry class swept exactly at its boundary under a controlled clock, and audit purge limited to anchored expired sequences with the chain still verifiable afterwards. |
| `SHELL-RULE-001–009` | `src/shell/shell-model.test.ts` | Active-section resolution, path normalisation, section and channel titles, channel links, generated initials and gradients, and theme preference/resolution/toggle rules. |
| `SHELL-DATA-INT-001–004` | `tests/shell-data.test.ts` | The real control-plane adapter against local D1 and a real workspace object: a signed-in workspace, a private room hidden from a valid member who is not in it, archived rooms and agents excluded, missing/forged/revoked/stale-epoch sessions refused, and an unbound development preview allowed while every partial or complete control-plane binding refuses a signed-out preview. |
| `SHELL-INT-001–008` | `tests/browser/shell.spec.ts` | Shell layout at both viewports, accessibility in light and dark on three routes, one current navigation item, keyboard-only operation, dark mode applied before first paint and remembered, honest not-built-yet and unavailable-channel states, the absence of development fixture data in an authenticated deployment and the viewer's profile. Every scenario signs up into its own real workspace. |
| `DESKTOP-INT-001–003` | `tests/browser/shell.spec.ts` | Windows caption controls and drag surface, macOS overlay reserving the native traffic lights, and the rail sitting below the reserved titlebar only on desktop. |
| `ROOM-RULE-001–013` | `src/domain/rooms.test.ts` | Channel slug normalisation and reserved namespaces, name and topic bounds, canonical direct-message identity including a splice-forgery case, message body control-character stripping and limits, one-level thread placement and opaque history cursors. |
| `ROOM-INT-001–012` | `tests/rooms.test.ts` | Idempotent room creation, private-room invisibility to a valid non-member with no rows left behind, join/leave, archive-readable-but-not-writable, one conversation per set of people, the single send transaction with body-free audit/replay/delivery, idempotent retry and key-reuse refusal, thread depth and reply counts, history paging with a same-millisecond tie, the Solo refusal to store content, revoked-member refusal and two-workspace isolation. |
| `ROOM-INT-013` | `tests/browser/shell.spec.ts` | Rendered channel history, agent messages visibly distinct from people, thread reply counts and the empty-room state. |
| `READ-RULE-001–010`, `SOCKET-RULE-001–007` | `src/domain/read-state.test.ts`, `src/domain/socket-protocol.test.ts` | The one visibility rule, monotonic clamped read cursors, unread derivation including a non-member room contributing nothing, presence/typing freshness, and total frame parsing that carries no actor and refuses oversized or malformed input. |
| `LIVE-INT-001–010` | `tests/live.test.ts` | Real hibernatable sockets against the object: authorized upgrade and stale refusal, keepalives answered by the runtime with no durable write, filtered fan-out that never reaches a room the socket may not see, cursor replay refiltered against current membership, an expired replay window answered with a reset, malformed frames and live authority revocation, one read cursor across a member's devices, separate thread read state, no unread in a room never joined, and presence/typing relayed without writing anything. |
| `MD-RULE-001–013` | `src/domain/markdown.test.ts` | Fenced code with a language, everything inside a fence kept literal, block grouping, code spans winning over every inline rule, link-scheme safety, a tree that is never markup, mention classification by prefix, the email-domain case, and reaction shapes. |
| `MSG-INT-001–007` | `tests/messages.test.ts` | Mention recording and resolution with unknown handles kept unresolved and code-fenced ones ignored, author-only edits with a re-derived address list and a visible marker, the Solo refusal to edit content, a delete that removes the body, mentions and reactions while keeping the tombstone and thread, admin deletion attributed to the admin, and idempotent reactions refused from outside the room or of the wrong shape. |
| `MSG-INT-008/009` | `tests/browser/shell.spec.ts` | Markdown rendered as elements with a language-tagged code block and a classified mention, and the composer's three regressions: focus retained after a send attempt, a per-room draft that survives leaving and returning, and Enter sending while Shift+Enter adds a line. |
| `ACCOUNT-INT-001–003` | `tests/accounts.test.ts` | The control-plane account object against real local D1: sign-up provisions a workspace with a starter room, an unknown address and a wrong password answer identically, addresses normalise, and a duplicate address is refused. |
| `AUTH-INT-001` | `tests/browser/account.spec.ts` | Sign-up into a real workspace and a message posted through the composer's authenticated path, persisting across a reload, driven against the built Worker with real D1 and real Durable Objects. |
| `AUTH-INT-002/003` | `tests/browser/account.spec.ts` | HttpOnly session cookie, sign-out, refusal on the next request after restoring the revoked token, indistinguishable wrong-password/unknown-address errors, and successful sign-in after both failures. Each submission waits for its own response and the form becoming ready. |
| `AUTH-INT-004` | `tests/browser/account.spec.ts` | The same real sign-up action and input refused in a production-configured built Worker and accepted in development; denied sign-up leaves accounts, challenges, sessions, memberships and workspaces unchanged. |
| `AUTH-INT-005` | `tests/browser/account.spec.ts` | Message actions reject missing, forged and other-account CSRF tokens and a foreign Origin; denial leaves message, mention, reaction, audit, replay, outbox and idempotency counts unchanged. A valid session-bound token sends successfully. |
| `AUTH-INT-006` | `tests/browser/account.spec.ts` | Sign-out actions reject missing, forged and previous-session CSRF tokens while leaving the current session usable; the current token signs out successfully. |
| `PIN-INT-001–004`, `SAVED-INT-001–004`, `FORWARD-INT-001–004` | `tests/saved-content.test.ts` | Room-wide pins refused to non-members and invisible outside a private room; private saved items that stop resolving once the member leaves the room or the message is deleted; forwarding that carries a copy, withholds the source room from a reader who cannot see it, and is refused for an unreadable source or an unjoined target; history paged without loss or repetition; and Solo refusals for pinning and forwarding. |
| `MSG-INT-010–014`, `SAVED-INT-005/006`, `FORWARD-INT-005` | `tests/browser/saved-content.spec.ts` | The same actions driven as a signed-in member: edit with an edit marker, delete leaving a tombstone, react and un-react, pin and unpin, save and unsave from a private list reachable from the rail, forward with visible provenance, and revealing older messages without disturbing what is on screen. |
| `DRAFT-INT-001–005`, `SCHED-MSG-INT-001–007` | `tests/drafts-scheduled.test.ts` | One draft per member per surface with a revision that refuses to overwrite another device's edit; thread drafts separate from a room's; drafts withheld once the member leaves the room; scheduled sends that fire once at their time, survive an eviction, recheck authority at the send time rather than the scheduling time, refuse a suspended author or an archived room, edit and cancel before firing, stay private to their author, and are bounded in time. Solo refusals for both. |
| `DRAFT-INT-006`, `SCHED-MSG-INT-008` | `tests/browser/saved-content.spec.ts` | A draft synced to the server and read back by a second browser carrying the same session, spent on send; and a message scheduled, listed, and cancelled before it could arrive. |
| `PROD-RULE-001–014` | `src/domain/productivity.test.ts` | Slash command classification including the `//` escape and refusal of an unknown command, the text the speaking commands post, custom emoji name normalisation and confusable-name refusal, token scanning, and snippet parsing that keeps code indentation while bounding title, language and length. |
| `SNIP-INT-001–003`, `CMD-INT-001–004`, `EMOJI-INT-001–004` | `tests/productivity.test.ts` | Snippets posting a summary into history with the body beside it and out of every record that outlives it; commands carried out through the same authority a button would use, with an unknown one refused rather than posted and no command reaching further than the person typing it; admin-only emoji naming, one name one meaning, a reaction refused for an undefined name and still withdrawable after the name is removed. Solo refusals throughout. |
| `CMD-INT-005`, `SNIP-INT-004`, `EMOJI-INT-005` | `tests/browser/productivity.spec.ts` | The same three driven as a signed-in member: a command run and a mistyped one refused, a long snippet collapsed and expanded, and an emoji named, refused when confusable, and removed. |
| `AGENT-RULE-001–018` | `src/domain/agents.test.ts` | The `a.` namespace and refusal of a name from another one; the single scope rule proving the write side is never looser than the read side; each of the three enqueue brakes and their order; the last-owner guard; the preamble's clauses, its tier order, and that the module exports no way to change it; and injection flags that flag without filtering. |
| `AGENT-INT-001–014` | `tests/agents.test.ts` | Agent creation owned by its creator, handles refused or already taken, an agent id rejected as an actor everywhere and absent from the members table, the last-owner guard in both the code and the database, somebody else's agent reported as missing, the three tiers shown to an owner with the brief kept out of the audit record, out-of-scope mentions never written at all, an empty scope list acting as a pause, a private room in a scope not disclosed to others, and each brake including rollback of queued work with its message. |
| `AGENT-INT-015` | `tests/browser/productivity.spec.ts` | Creating an agent as a signed-in member, a namespace-violating handle refused, and the compiled-in preamble readable with its "not editable" statement. |
| `MOCKUP-SEC-001/002/003` | `tests/browser/mockup-contracts.spec.ts` | Rendered Solo storage, local-only runner configuration and user-held vault recovery disclosures. |
| Supporting rule cases | `src/domain/idempotency-key.test.ts` | Bounded transport-safe idempotency keys; a command integration test must consume this rule when mutation handling lands. |

The desktop rendering tests cover web content under the same platform marker injected by Tauri. Actual minimize/maximize/close calls require the WebdriverIO Tauri harness and remain part of R03/P01 rather than being inferred from browser tests.

## Tool references

- Cloudflare Workers Vitest integration: <https://developers.cloudflare.com/workers/testing/vitest-integration/>
- Durable Object testing: <https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/>
- Playwright local web server: <https://playwright.dev/docs/test-webserver>
- Tauri WebDriver testing: <https://v2.tauri.app/develop/tests/webdriver/>
