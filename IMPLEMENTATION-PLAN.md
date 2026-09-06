# Lepidy implementation plan

Status: ready for staged execution; unresolved decisions are tracked explicitly.
Companions: [PRD](PRD.md), [HLD](HLD.md), [implementation ledger](IMPLEMENTATION-LEDGER.md), [mockup walkthrough](markups/index.html).

## 1. How to execute this plan

The ledger is the single source of implementation status. This plan defines sequencing, contracts, reuse, and gates; it does not claim implementation has started. Read relevant PRD/HLD sections and reference source before claiming a task. Follow applicable AGENTS.md and platform skills when implementing.

Accepted decisions from the conversation and HLD take precedence over older PRD milestone text. In particular: Next.js via OpenNext; one SQLite workspace DO; D1 control plane; customer-funded execution; authoritative authorization without KV session caching; Solo free and Team $19 including five humans plus $4 each above five. The PRD M0 Auth.js wording is stale and must not drive implementation.

Never copy entire reference repositories into Lepidy. Reference repositories remain unchanged. Copy or adapt bounded modules with their regression tests, record their source revision and target paths in task evidence, and remove unrelated integrations. A reference spec describes intended behavior; inspect the implementation and tests before assuming it shipped.

A task is complete only when its acceptance criteria pass in the integrated Lepidy checkout. A mock, stub, or isolated prototype cannot complete a production task. Partial work remains in_progress; a failed check is not waived by documenting it.

## 2. Delivery sequence

| Stage | Outcome | Ledger tasks | Exit gate |
|---|---|---|---|
| 0 | Decisions and executable platform skeleton | D01–D08, F01–F06 | Next.js reaches a real workspace DO; isolated tenant fixtures; migration and CI baseline |
| 1 | Minimal collaborative workspace | C01–C04 | Two users exchange threaded messages, reconnect, and see consistent read state |
| 2 | First useful agent and vault | A01–A04, V01–V04 | Connected MCP agent uses injected credentials after a real approval and replies in the originating thread |
| 3 | Phone-to-runner workflow | R01–R04, G01 | Mention starts an approved local harness; reuse, recovery, denial, and stopping work end to end |
| 4 | Complete daily-use collaboration | C05–C11 | Required chat, notifications, search, files, queues, and Slack import work with real permissions |
| 5 | Complete custody and external runtimes | V05–V08, A05, R05 | Tier B and cloud/custom lanes satisfy resolved contracts and leak tests |
| 6 | Desktop, mobile, billing and operations | P01–P04, B01–B03, O01–O03 | Installable clients, entitlement enforcement, recovery, quotas and cost evidence |
| 7 | Release qualification | G02–G05 | Security, load, platform and acceptance gates pass; explicit release decision |

Stage order is a delivery guide, not a reason to block independent work. Dependencies in the ledger govern readiness. Decision tasks can run ahead of their consuming stage. A Tier B decision does not block Tier A prototyping. Full desktop packaging does not block the early headless runner. Store-account setup and review preparation should start early, without making a public release.

First demo: Solo workspace → register runner → approve local launch → mention from a second browser/device → session-scoped MCP connection → request test credential → phone/browser approval → scrubbed injected command → threaded reply → another mention reuses session → kill switch revokes further access. Use synthetic credentials and a disposable test service.

## 3. Decisions that must become explicit contracts

These are open work, not implied approval of earlier recommendations.

| ID | Contract to settle | Required output |
|---|---|---|
| D01 | Identity and tenancy | Workspace URL and immutable ID, central sign-in/cookie boundary, passkey RP/origin rules, verified account linking/recovery, global account versus tenant-local author identity, membership mirroring and revocation ordering; no cross-database foreign keys |
| D02 | Queue and runner lifecycle | One designated runner/session recommendation; claim/lease/complete, retry policy, fencing stale consumers, crash recovery, idle timeout, lost wake, disconnected stop behavior, session token scope and expiry |
| D03 | Waiting transport | Measured Next.js/Worker/MCP/DO prototype preserving session reuse without treating parked DO requests as free; cancellation and reconnect; tested permission posture for each harness |
| D04 | Vault authorization | Who may use versus where use is allowed; delegation intersection; authenticated task/channel provenance; device/project claims; approval step-up matrix; multi-credential approvals and session-grant boundaries |
| D05 | Tier B custody | Remove independent server-decryptable key path; choose supported delivery modes; phone-to-runner encryption, multi-owner wraps, recovery and lost devices; state actual threat model for server-delivered browser code |
| D06 | Cloud/custom contracts | Verify current provider APIs, authentication custody, session/schedule lifecycle, budgets, signed webhook routing and retry semantics; custom webhook signing, replay protection and restricted callbacks |
| D07 | Retention and operations | Message/audit/event/approval retention, exports, backup retention, deletion deadlines, restore effects on grants/tokens, EU scope across DO/R2/control plane, archive/search compatibility |
| D08 | Remaining product boundaries | Pricing proration/seats/storage packs; billing lapse recovery; store commerce; companion composer scope; group/agent voting; private-status notification rules; search file contents versus metadata; deterministic versus AI Home/search; call-link versus actual attendance |

Record resolutions with rationale, alternatives, evidence, date, and affected PRD/HLD/mockup sections. Implementers may settle routine technical choices within accepted scope. Changes to custody promises, paid behavior, supported platforms, or release scope require a user decision. Do not mark a decision done merely because a recommendation exists.

## 4. Reference reuse map

Paths below are relative to the Lepidy directory and were verified during planning. These are starting points, not dependencies to import at runtime.

| Key | Reference source | Reuse strategy and boundaries |
|---|---|---|
| S1 | ../slip-robotics-chat/src/app/(app)/shell.tsx; src/components/sidebar.tsx; src/components/channel/composer.tsx; src/components/channel/message-item.tsx; src/components/channel/formatted-message.tsx (all under that repository) | Adapt Next.js shell and client components. Replace data loaders and action transport; preserve scrolling, draft and composer regression behavior. Use Lepidy tokens and layout. |
| S2 | ../slip-robotics-chat/src/lib/handles.ts, group-handles.ts, bot-mentions.ts, bots.ts; docs/BOTS-SPEC.md; docs/USER-GROUPS-SPEC.md | Port pure namespace/mention rules with tests. Rewrite persistence for SQLite. Preserve owner-visible mention disclosure; replace delivery-as-read for unattended jobs. |
| S3 | ../slip-robotics-chat/src/lib/mcp/bot-tools.ts, tools.ts, tokens.ts, attribution.ts, oauth-actions.ts; docs/CLAUDE-MCP-INTEGRATION-SPEC.md | Adapt tool schemas, attribution and OAuth behavior. Replace storage, tenant routing, rate limits and authorization. Do not copy CRM/RTM/Slip-OS proxies. |
| S4 | ../slip-robotics-chat/src/lib/room-modes.ts, room-modes-internal.ts, ranked-feed.ts; src/components/channel/form-composer.tsx; docs/ROOM-MODES-SPEC.md | Port field validation, rank/tiebreak rules and UI; replace SQL and apply privacy on every reader including notifications and attachments. |
| S5 | ../slip-robotics-chat/src/lib/unread-mentions.ts, notify-mode.ts, dnd-window.ts, drafts.ts, search.ts, search-input.ts; docs/NOTIFICATIONS-SPEC.md; docs/ACTIVITY-SURFACES-SPEC.md | Preserve tested semantics while replacing transport and queries. Measure unread write amplification. Reuse read-cursor, mention, thread and reconnect regression cases. |
| S6 | ../slip-robotics-chat/src/lib/slack/format.ts, thread-sync.ts; src/lib/custom-emoji.ts; docs/SLACK-DM-SYNC-SPEC.md | Extract formatting, identity/thread mapping and idempotency concepts for one-way export import. Inventory additional file/identity adapters before reuse. Do not enable live Slack bridging. |
| S7 | ../slip-robotics-chat/desktop-tauri/src-tauri/tauri.conf.json; desktop-tauri/README.md; src/lib/desktop-notify.ts; docs/TAURI-DESKTOP-MIGRATION-SPEC.md | Adapt shell/notification patterns after inspecting capabilities. Replace release URLs, signing configuration and identity; distinguish direct and store builds. |
| V1 | ../agent-vault/crates/av-core/src/policy.rs, grants.rs, usage.rs, types.rs; crates/av-core/tests/policy.rs | Translate ordered fail-closed policy into TypeScript pure functions. Carry case tables, TTL and denial hints; add tenant, ACL and delegation cases. Rust CLI consumes protocol types, not an independent policy authority. |
| V2 | ../agent-vault/crates/av-cli/src/run.rs, scrub.rs, withfile.rs, client.rs; crates/av-cli/tests/end_to_end.rs | Adapt child execution, pipe scrubbing, exit codes and temp-file cleanup. Replace Unix socket auth with registered-device HTTPS/signing. Test Windows ACLs, signals and process-tree termination separately. |
| V3 | ../agent-vault/crates/av-cli/src/capture.rs, import.rs, template.rs, scan.rs, hook.rs, init.rs; plugin/hooks/hooks.json; plugin/evals/agent-behavior.md | Preserve create-only capture, no secrets in argv/results, coaching and anti-circumvention tests. Adapt local matching to hosted scan threat model; do not claim arbitrary substring detection works from one whole-secret hash. |
| V4 | ../agent-vault/crates/av-audit/src/lib.rs; crates/av-audit/tests/chain.rs; crates/av-crypto/tests/crypto.rs; crates/av-app/ui/approve.js | Reuse test concepts and approval information requirements. Implement WebCrypto hierarchy and tenant audit anew; local vault format and native biometrics are not the hosted architecture. |

Also consult markups/home.html, channel.html, dm.html, queue.html, search.html, inbox.html, notifications.html, people.html, agents.html, agent.html, runtime.html, vault.html, credential.html, sessions.html, mobile.html, signin.html and pricing.html. They define visual intent, not security authority. Correct contradictory fixtures rather than coding their mistakes.

Excluded imports: Slip-OS, company domain lock, Supabase, Neon/Postgres connection layer, NextAuth/Auth.js legacy wiring, Vercel services, SSE polling, live Slack bridging, huddles and whiteboards. External execution adapters are new work; neither reference establishes their completeness.

## 5. Architecture and implementation contracts

**Desktop choice is settled: Tauri v2, following both reference apps.** Next.js remains the web UI/server framework; it does not replace Tauri. Reuse Slipchat's Tauri shell patterns and Agent Vault's Rust/native patterns for notifications, tray, local launch approvals, runner hosting, deep links and OS integration. In F01/R03, verify the exact frontend packaging/loading arrangement and bridge boundary: a Tauri webview does not itself run Next.js server components, and remote workspace content must never gain unrestricted native execution. Browser-only deployment is not completion of the desktop requirement. The Rust CLI and headless runner also work independently of an open webview.

- Next.js server components/actions/handlers call authorized backend methods. Tenant content is stored only in its workspace DO; D1 holds the control plane. Never put secret-bearing payloads in caches, browser persistence, logs, or analytics.
- Contract-first boundaries: versioned request/response schemas and structured errors for Next.js, MCP, Rust CLI and runner; derive actor identity from credentials. A task identifier or channel argument alone is not proof of authority.
- Use supported DO transaction APIs, with atomic replay/outbox records and idempotency keys. Do not paste the HLD illustrative migration code: its version table needs an enforced singleton key, atomic progression, and tested rollback/failure behavior.
- Every tenant read, search, file authorization, replay and fan-out path applies the same visibility rules. Recheck grants and delegation at use; revoke existing sockets/session authority explicitly.
- Queue display read state is independent from work execution. Leases prevent abandoned claims, fencing prevents stale session completion, and retries must not silently duplicate external actions. Display uncertain outcomes for human review.
- A runner uses locally accepted executable/arguments/directory/permission settings. New server preset versions are proposals until locally accepted. Avoid injecting application credentials into the entire harness environment; release them to the intended child command.
- Proxy checks include scheme/host/port, redirects, private destinations, credential header handling, body limits, upstream timeout and response leakage. A host allowlist alone is insufficient.
- Audit records explain requester, operating owner, approver and outcome separately. A hash chain without an independently protected checkpoint is not proof against an operator rewriting the entire chain; settle the promised audit assurance.
- Build the shared alarm scheduler early. Expiry, outbox retries, schedules and migrations cannot each overwrite the object's single alarm.
- Recheck external platform documentation when implementing. Preserve accepted architecture, but do not freeze provider flags or numeric limits from draft prose.

## 6. Acceptance and validation

For every ledger task: implement the stated output, run relevant tests, integrate, record actual commands/results and evidence, then check completion. UI tasks require browser verification against mockups, including loading/error/empty states, narrow viewport, keyboard navigation and dark mode where applicable.

CI baseline: type/lint/build checks, pure-rule case tables, real SQLite DO tests, migration fixtures, and focused Rust tests as their code lands. Do not quarantine isolation/leak failures to obtain a green build. Native and provider-dependent checks can run in dedicated release jobs, but are still mandatory before their supported lane ships.

Release gates:
1. Two hostile tenants cannot cross via query, MCP, socket/replay, search, upload/download or webhook.
2. Seeded secrets stay out of tool output, transcripts, logs, indexes and broadcasts except explicit authorized reveal cases.
3. Agent-behavior suite tests real harness sessions; denial circumvention and unintended leaks fail the gate.
4. Failure injection covers lost responses, duplicate delivery, approval races, runner crashes, process-exit race, offboarding, revocation and reconnect.
5. Load/cost tests include the 50-human target, 500 sockets, imports, agent-heavy traffic and idle runners. Report actual writes and billable duration; forecasts are not measurements.
6. Platform matrix proves native install/update, approval and CLI behavior for each advertised distribution. Do not advertise a tested Linux path as proof of Windows support.
7. Billing examples include 1, 2, 5, 6, 20, 21 and 50 humans; webhook retries, canceled plans and explicit storage purchases never delete credentials.

## 7. Release and scope discipline

Stage 3 is an internal demonstration, not GA. The complete v1 ledger remains required unless the user explicitly changes scope. Distinguish external review pending from implementation complete; paid account setup, sending invitations, public deployment, store submission and live transactions remain separate release actions under the session's authorization.

After each stage, reconcile PRD/HLD/mockups and attach a short stage review to the ledger. List failures and remaining decisions; do not hide them in a green percentage. The final release decision requires all applicable gates and a documented list of any user-approved deferrals.
