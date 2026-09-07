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
| Rust CLI/runner | Launch the compiled executable against disposable local services. Assert process tree, exit code, files, permissions, redaction and cleanup. The CLI suite lives in `src-tauri/crates/lepidy-cli/tests` and runs inside the native step of `npm run verify:local`. |
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
| `VAULT-AUTH-001–006` | `src/domain/vault-authorization.test.ts` | ACL union plus mandatory intersections, complete unattended delegation, independent reveal rights, exact grants and instructive non-circumvention denials. |
| `VAULT-ENVELOPE-RULE-001/002`, `VAULT-POLICY-RULE-001–003` | `src/domain/vault-envelope.test.ts`, `src/domain/vault-policy.test.ts` | AES-GCM AAD binds workspace/credential/version; envelope, wrap, metadata, TTL, rate and exact-custodian constraints fail closed. |
| `VAULT-INT-007/008` | `tests/vault.test.ts` | One custodian wrapping key per member with replacement refused rather than silently stranding wrapped credentials; a release that returns ciphertext only on an allow, only to a custodian, and spends no grant or rate slot on a requester who holds no wrap; and a real ECDH round trip where only the test's private half opens the value. |
| `VAULT-APPROVAL-RULE-001–013` | `src/domain/vault-approval.test.ts` | A mandatory reason kept to one line; a batch bounded at ten with no repeated credential and only where the eligible-approver set is identical; the allow windows a policy actually permits and the expiry each becomes; first-terminal-answer-wins with the second told what happened; expiry exactly at five minutes and only while pending; a gesture digest bound to the approval, every credential version, policy epoch, outcome and window, and refusing a partial answer; agent-facing hints that say stop rather than retry; every fact PRD §8.6 requires on the card including the reveal warning; and a kill-switch announcement that never claims revoked grants came back. |
| `VAULT-INT-009–014` | `tests/vault.test.ts` | Against the real Durable Object and SQLite: an ask becoming a card in every owner's vault DM with no ciphertext in the message or the queued push while an automatic allow needs no card; a gesture refused without verification, with a mismatched digest, or from somebody who is not an approver; first-answer-wins issuing exactly one grant, the second answer refused and both copies of the card carrying the answer; the grant then honoured by the release path; timing out at the deadline, denying the items, posting the timeout and refusing a late answer; one command coalesced into one card and never across owners, with mixed per-item decisions atomic; each kill-switch scope revoking grants, ending pending cards, announcing itself, outranking policy and never restoring on the way back; and a card refused after the credential it described changed. |
| `VAULT-APPROVAL-INT-001/002` | `tests/browser/vault-approvals.spec.ts` | The whole flow against the built Worker: a device request becoming a card, the card in the Inbox with its reason, credential, risk and deadline, allowing gated on a passkey and completed with a real WebAuthn assertion from a virtual authenticator, the resulting grant honoured once and asked for again afterwards, and the conversation with `@a.vault` carrying the question and the answer but never the value. With scripting off, denying still works and the allow buttons say they are not ready. |
| `VAULT-INT-015–018` | `tests/vault.test.ts` | Against the real Durable Object and SQLite: live grants listed with the holder, the agent operating under them and the approver as separate fields, filtered to what the reader may see and refusing a revoke from somebody who may not; a credential described as metadata, policy and the three ACL verbs with no field able to carry a value, and reported as missing to a member with no rights; an activity log that keeps requester, operating owner and approver apart across an approval answered by the second owner and used by the first; and an agent described with its vault switch separate from its status. |
| `VAULT-UI-INT-001–003` | `tests/browser/vault-ui.spec.ts` | The pages against the built Worker: an approval allowed for fifteen minutes appearing as a live grant that names all three parties, honoured while it stands and refused the moment it is revoked from the page; the credential page carrying the delivery explanations, policy, the three privileges and the access log with the requester's own reason, clean of the canary and free of serious accessibility violations in both themes, with an unknown credential reported as missing rather than forbidden; and an agent cut off from the vault with scripting switched off, staying active, with the on switch saying plainly that it needs a passkey. |
| `VAULT-CLI-RULE-001–023` | `src-tauri/crates/lepidy-cli/src/*.rs` | The canonical AAD and signed-request strings byte for byte against their TypeScript twins; wrap and envelope opening refused under any other context or key; scrubbing across chunk boundaries, overlapping values and short-value suppression; `NAME:PATH` parsing including Windows drive letters; refusal to clobber a file it did not create; and plain HTTP refused off loopback. |
| `VAULT-CLI-INT-001–016` | `src-tauri/crates/lepidy-cli/tests/cli_integration.rs` | The compiled binary against a loopback double that verifies the signed envelope: enrolment sending no passphrase, recovery code or private key and a keystore only those two open; a refused login writing nothing; metadata listing over a verified signature; a wrong passphrase never reaching the network; `add` sealing the value before it leaves, reversible only by the sealed local key; injection into a real child with both streams redacted, including a value split across writes; a `0600` file delivery readable by the child and unlinked afterwards; deny, needs-approval, unknown-credential and stale-key-epoch paths that never spawn the command, each with its own exit code; no flag anywhere accepting a value; a device with no vault key able to list but not to seal; a pending approval reported with its id and the workspace's own waiting wording, refused without a reason, and never spawning the command; and one command asking once for every credential it needs rather than once each. |
| `VAULT-DEVICE-INT-001/002` | `tests/browser/vault-device-api.spec.ts` | The device HTTP surface against the built Worker with a real P-256 device key: enrolment, a body-tampered and a forged signature refused, metadata with no ciphertext or wraps, creation requiring user verification in the same request, a policy-allowed release opened only by the client's own private key, and refusal of a replayed nonce, an unsigned call, another device's key and an origin that does not exist. |
| `VAULT-INT-001–006` | `tests/vault.test.ts` | Real SQLite Durable Object ciphertext CRUD/rotation/tombstones, ACL metadata filtering, Solo refusal, all-table plaintext/DEK canary scans, exact grants, expiry/single-use/rate/project/origin/device denials, kill-switch non-revival and device/member revocation. |
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
| `FORM-INT-001` | `tests/browser/productivity.spec.ts` | With scripting switched off, so the page can never hydrate: an agent is created, a namespace-violating handle is refused with its error rendered, a custom emoji is named and then removed — all through real form posts to server actions — and the composer, which cannot work before hydration, reports itself as not editable rather than accepting characters the first render would wipe. |
| `MCP-RULE-001–016` | `src/domain/mcp-oauth.test.ts` | The token shape that routes to one workspace and parses one way; resource identity and its RFC 9728 metadata location; mandatory RFC 8707 resource indicators compared exactly; PKCE S256 with `plain` refused and a constant-time comparison; what a client may register as a redirect and the exact match it is held to, with the loopback port as the single exception; open registration bounded; an unknown scope refused rather than dropped; the bearer challenge that cannot break out of its own quoting; which authorization refusals may be redirected and which may not; RFC 9207 issuer identification; the code binding re-checked at redemption; refresh rotation with replay read as a leak; the audience checked against where the request arrived; and the origin taken from the host the client addressed. |
| `MCP-RULE-017–019` | `src/domain/mcp-oauth.test.ts` | Strict tool names and argument shapes with per-tool scopes and no voting capability; opaque, tamper-refusing agent-queue cursors; and the exact per-connection/per-agent write-window boundary. |
| `MCP-INT-001–007` | `tests/mcp-oauth.test.ts` | The same authorization server against a real Durable Object: a connection made by a member that acts as that member with the credential kept out of the audit; a code that is single-use, expires in a minute and is refused for a wrong verifier, a changed redirect or another client; rotation, a replayed refresh token killing the whole connection, and another client refused without killing it; one workspace's token refused at another in both directions and when it claims the other's audience; membership re-checked live so removal cuts a connection off with nothing to revoke; access expiry with the connection still refreshable; scope enforced; a person listing and ending only their own connections, with somebody else's reported as missing; and an authorization request refused for a stale epoch or an absent member. |
| `AGENT-QUEUE-INT-001–003`, `AGENT-TOOLS-INT-001–003` | `tests/agent-tools.test.ts` | Private-room-safe keyset queue pages and display read state independent from execution; one-winner claims, lost-response replay, lease generation/token/session fencing, exact completion replay, bounded pre-start retry/dead-letter behavior and post-start attention; live owner/connection/scope enforcement, persistent human/agent attribution, thread posting with no agent-to-agent enqueue loop, Solo content refusal, and strongly consistent per-connection/per-agent write limits. |
| `AGENT-SESSION-RULE-001–003` | `src/domain/agent-session.test.ts` | Delegation and session lifetime ceilings, normalized non-widening capabilities, and exact tool/channel intersection rules. |
| `AGENT-SESSION-INT-001–005` | `tests/agent-sessions.test.ts` | Digest-only scoped session credentials; delegated channel limits on posting and queue claims; exact-tuple token rotation; immediate denial after delegation revoke, owner removal, member offboarding, agent pause or expiry; single-live-session replacement; and cross-workspace refusal. |
| `MCP-INT-008–013` | `tests/browser/mcp-oauth.spec.ts` | The whole dance against the built Worker: discovery, registration, consent, redemption, rotation, disconnect and cross-workspace refusal, followed by tool discovery and scoped channel/agent reads, human posting, claim/start/renew/complete, an agent reply in the originating thread, stable connection/client or session/delegation/device attribution after a fresh read, refusal of agent tools on read-only connections, a runner session confined to its delegated tools/channels, and vault metadata discovery whose HTTP results exclude plaintext, ciphertext and wraps. |
| `MOCKUP-SEC-001/002/003` | `tests/browser/mockup-contracts.spec.ts` | Rendered Solo storage, local-only runner configuration and user-held vault recovery disclosures. |
| Supporting rule cases | `src/domain/idempotency-key.test.ts` | Bounded transport-safe idempotency keys; a command integration test must consume this rule when mutation handling lands. |

The desktop rendering tests cover web content under the same platform marker injected by Tauri. Actual minimize/maximize/close calls require the WebdriverIO Tauri harness and remain part of R03/P01 rather than being inferred from browser tests.

## Tool references

- Cloudflare Workers Vitest integration: <https://developers.cloudflare.com/workers/testing/vitest-integration/>
- Durable Object testing: <https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/>
- Playwright local web server: <https://playwright.dev/docs/test-webserver>
- Tauri WebDriver testing: <https://v2.tauri.app/develop/tests/webdriver/>
