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
5. the OpenNext Worker bundle and Wrangler deployment dry run;
6. browser integration tests at desktop and mobile sizes;
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

Cloudflare's test runtime supplies storage isolation and direct Durable Object access. Playwright starts the local web server from its configuration. Tauri's current recommended end-to-end route is WebdriverIO with its Tauri service; it supports an embedded driver on Windows, Linux and macOS.

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
| `SHELL-DATA-INT-001–003` | `tests/shell-data.test.ts` | The real control-plane adapter against local D1 and a real workspace object: a signed-in workspace, a private room hidden from a valid member who is not in it, archived rooms and agents excluded, and missing/forged/revoked/stale-epoch sessions refused. |
| `SHELL-INT-001–008` | `tests/browser/shell.spec.ts` | Shell layout at both viewports, accessibility in light and dark on three routes, one current navigation item, keyboard-only operation, dark mode applied before first paint and remembered, honest not-built-yet and unavailable-channel states, the development-data banner and the viewer's profile. |
| `DESKTOP-INT-001–003` | `tests/browser/shell.spec.ts` | Windows caption controls and drag surface, macOS overlay reserving the native traffic lights, and the rail sitting below the reserved titlebar only on desktop. |
| `ROOM-RULE-001–013` | `src/domain/rooms.test.ts` | Channel slug normalisation and reserved namespaces, name and topic bounds, canonical direct-message identity including a splice-forgery case, message body control-character stripping and limits, one-level thread placement and opaque history cursors. |
| `ROOM-INT-001–012` | `tests/rooms.test.ts` | Idempotent room creation, private-room invisibility to a valid non-member with no rows left behind, join/leave, archive-readable-but-not-writable, one conversation per set of people, the single send transaction with body-free audit/replay/delivery, idempotent retry and key-reuse refusal, thread depth and reply counts, history paging with a same-millisecond tie, the Solo refusal to store content, revoked-member refusal and two-workspace isolation. |
| `ROOM-INT-013` | `tests/browser/shell.spec.ts` | Rendered channel history, agent messages visibly distinct from people, thread reply counts and the empty-room state. |
| `READ-RULE-001–010`, `SOCKET-RULE-001–007` | `src/domain/read-state.test.ts`, `src/domain/socket-protocol.test.ts` | The one visibility rule, monotonic clamped read cursors, unread derivation including a non-member room contributing nothing, presence/typing freshness, and total frame parsing that carries no actor and refuses oversized or malformed input. |
| `LIVE-INT-001–010` | `tests/live.test.ts` | Real hibernatable sockets against the object: authorized upgrade and stale refusal, keepalives answered by the runtime with no durable write, filtered fan-out that never reaches a room the socket may not see, cursor replay refiltered against current membership, an expired replay window answered with a reset, malformed frames and live authority revocation, one read cursor across a member's devices, separate thread read state, no unread in a room never joined, and presence/typing relayed without writing anything. |
| `MOCKUP-SEC-001/002/003` | `tests/browser/mockup-contracts.spec.ts` | Rendered Solo storage, local-only runner configuration and user-held vault recovery disclosures. |
| Supporting rule cases | `src/domain/idempotency-key.test.ts` | Bounded transport-safe idempotency keys; a command integration test must consume this rule when mutation handling lands. |

The desktop rendering tests cover web content under the same platform marker injected by Tauri. Actual minimize/maximize/close calls require the WebdriverIO Tauri harness and remain part of R03/P01 rather than being inferred from browser tests.

## Tool references

- Cloudflare Workers Vitest integration: <https://developers.cloudflare.com/workers/testing/vitest-integration/>
- Durable Object testing: <https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/>
- Playwright local web server: <https://playwright.dev/docs/test-webserver>
- Tauri WebDriver testing: <https://v2.tauri.app/develop/tests/webdriver/>
