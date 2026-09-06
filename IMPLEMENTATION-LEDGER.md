# Lepidy implementation ledger

Companion: [implementation plan](IMPLEMENTATION-PLAN.md). This file is the source of task status.

## Agent update rules

1. Pick a task whose dependencies are done. Claim it by changing status to in_progress and filling Owner with your task/agent identity and Started with an ISO date. Re-read before editing to avoid overwriting another agent's claim.
2. Never change another active owner's row without coordination. Dependencies refer to completed integrated work, not another branch's intention. Claim shared-schema/contract changes explicitly before concurrent edits.
3. Status values: todo, in_progress, blocked, done. Check the Done box only with status done. Blocked means a concrete missing decision, failed dependency, or external requirement; record the unblock condition.
4. Preserve IDs. Split oversized work into suffixed IDs (for example C08a) and update dependencies; keep the parent incomplete until all children pass. Do not reuse deleted IDs.
5. Before completion, integrate the change, satisfy the acceptance column, add automated integration coverage required by [TESTING.md](TESTING.md), run `npm run verify:local`, and append an evidence record. Set Finished and link the evidence heading from the row. Unit-only or manual-only verification cannot complete implemented behavior. Do not record planned tests as passed.
6. Evidence includes scenario IDs, changed paths, reused source revision/path, actual commands/results, exercised boundaries and local doubles, supported platforms actually run, remaining limitations and follow-ups. No secrets or private tokens.
7. Documentation preparation does not complete implementation tasks. All tasks below intentionally begin unchecked. Check a decision only when resolved, recorded and propagated to affected specs.
8. At handoff, update active rows and evidence, identify the next ready task and exact blockers. No elapsed-time or automatic percentage-based completion.
9. This ledger organizes work; it does not authorize deployments, purchases, messages, account changes or store submissions beyond the user's instructions.

Source keys S1–S7 and V1–V4 resolve in plan §4. Acceptance criteria are cumulative with plan §6. Dates and owners are blank until work starts.

## Task ledger

| Done | ID | Task | Dependencies | Reuse | Acceptance / required output | Status | Owner | Started | Finished | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|
| [x] | D01 | Identity and tenant contract | — | S1,S2 | Document URL/cookie/passkey boundaries, tenant-local author IDs, linking/recovery and cross-plane revocation; reconcile specs. | done | /root | 2026-09-05 | 2026-09-05 | [D01](#d01--identity-and-tenant-contract) |
| [ ] | D02 | Runner and queue contract | — | S2,S3,V2 | Resolve designated runner/concurrency, leases/fencing, completion, retries, idle timeout, disconnect policy and session-token scope. | todo | — | — | — | — |
| [ ] | D03 | MCP waiting and harness spike | F01,F03,D02 | S3,V2 | Demonstrate repeated work in one harness without a permanently parked workspace request; measure idle duration and test cancellation/reconnect. | todo | — | — | — | — |
| [x] | D04 | Vault and approval contract | D01 | V1,V4 | Specify ACL union/intersection, provenance binding, signed project/device claims, step-up matrix, batch approvals and grant expiry semantics. | done | /root | 2026-09-06 | 2026-09-06 | [D04](#d04--vault-and-approval-contract) |
| [ ] | D05 | Vault sharing and release contract | D04,D05a | V4 | Resolve device-mediated delivery, browser trust, per-owner wraps, removal/rekey and lost-device behavior while preserving user-held root custody. | in_progress | /root | 2026-09-06 | — | — |
| [x] | D05a | Local execution and vault-root invariants | D01,D08a | V1,V2,V4 | Specify and reconcile local-only runner configuration plus client-generated vault unlock/recovery material that never reaches Lepidy; add schema/protocol negative tests. | done | /root | 2026-09-06 | 2026-09-06 | [D05a](#d05a--local-execution-and-vault-root-invariants) |
| [ ] | D06 | Cloud and custom contract spike | F01 | S3 | Verify provider auth, APIs, signed callbacks, schedule budgets and reconciliation; custom replay/SSRF boundaries; record supported capabilities. | todo | — | — | — | — |
| [ ] | D07 | Retention/residency/recovery contract | — | V4 | Specify retention by data class, export/delete/restore, EU scope, audit anchors and archive-search design. | todo | — | — | — | — |
| [ ] | D08 | Product and commerce decisions | — | S4,S5,S7 | Resolve remaining product boundaries listed in plan §3, including proration, companion composer, file extraction and store purchase behavior. | todo | — | — | — | — |
| [x] | D08a | Free workspace storage boundary | D01,F03 | V2,V4,S2 | Specify cloud channel metadata versus host-owned content, encrypted relay, offline behavior, one-host fencing, recovery and cloud upgrade; reconcile specs and tests. | done | /root | 2026-09-06 | 2026-09-06 | [D08a](#d08a--free-workspace-storage-boundary) |
| [x] | F01 | Next.js/OpenNext and Tauri workspace skeleton | — | S1,S7 | Next.js builds locally and for Workers; establish Tauri v2 Rust workspace and CLI layout, typed environment bindings, dev configuration and no legacy infrastructure. | done | /root | 2026-09-05 | 2026-09-05 | [F01](#f01--nextjsopennext-and-tauri-workspace-skeleton) |
| [x] | F02 | CI and reusable-code inventory | F01 | S1–S7,V1–V4 | Record reference revisions/license notices and source-to-target map; CI builds and executes pure-rule and SQLite DO fixtures. | done | /root | 2026-09-05 | 2026-09-05 | [F02](#f02--ci-and-reusable-code-inventory) |
| [x] | F02a | Local integration testing standard | F02 | — | Define the automated integration contract for every implementation task; add a single local verification runner and browser coverage for the existing web/Tauri shell. | done | /root | 2026-09-05 | 2026-09-05 | [F02a](#f02a--local-integration-testing-standard) |
| [x] | F03 | Workspace storage and migrations | F01,D01 | S2 | Create D1 control plane and per-workspace SQLite schema; singleton migration version, atomic progression, quarantine and historical-fixture tests. | done | /root | 2026-09-05 | 2026-09-05 | [F03](#f03--workspace-storage-and-migrations) |
| [ ] | F03b | Solo host content store and encrypted relay | F03,D08a,F05 | V2,V4,S2 | Implement host SQLite content schema, authenticated encrypted frames, commit-before-ack idempotency, offline errors, host-epoch fencing, transfer and Team-upgrade migration. | todo | — | — | — | — | — |
| [x] | F04 | Identity and workspace onboarding | F03,D01,D08a | S1,S2 | Implement verified accounts, password/passkey/Google/email-link methods, safe linking, local-host or cloud workspace creation, invitations, roles and last-admin protection. | done | /root | 2026-09-05 | 2026-09-06 | [F04](#f04--identity-and-workspace-onboarding) |
| [ ] | F05 | Session/device authorization | F04,D04 | S3,V2 | Revocable browser/device credentials, request signing/replay protection, authoritative membership checks and socket revocation; separate runner lifecycle. | todo | — | — | — | — |
| [ ] | F06 | Alarm scheduler, outbox and audit baseline | F03,D07 | V4 | Multiplex due work; transactional pending events, idempotent retry/replay and audit; test restart, duplicates and competing deadlines. | todo | — | — | — | — |
| [ ] | C01 | Tauri-compatible branded shell | F04 | S1 | Implement shell/navigation/theme/profile basics from mockups, Next.js data adapters, responsive layouts and desktop layout boundary. | todo | — | — | — | — |
| [ ] | C02 | Channels, DMs and message writes | F05,F06,F03b,C01 | S1,S2 | Public/private rooms, membership, group DMs, threads and idempotent send against the plan authority; transactions include replay/outbox; authorized history reads. | todo | — | — | — | — |
| [ ] | C03 | Live delivery and read state | C02 | S5 | Hibernating sockets, filtered replay, reconnect cursor, cross-device channel/thread reads, presence and typing; no per-heartbeat durable write. | todo | — | — | — | — |
| [ ] | C04 | Composer and message essentials | C02,C03 | S1,S5 | Markdown/code, mentions, edit/delete, replies and reactions; preserve composer/focus/scroll regressions and thread-default agent rendering. | todo | — | — | — | — |
| [ ] | A01 | Agent identities and visibility rules | C04 | S2 | Reserved a./g. handles, non-authenticating authors, owners/last-owner guard, briefs/preamble, scope and enqueue brakes with pure tests. | todo | — | — | — | — |
| [ ] | A02 | MCP OAuth and connection management | F05 | S3 | Workspace-scoped OAuth metadata/PKCE/resource binding, code expiry, rotating refresh and revoke; reject wrong-tenant tokens. | todo | — | — | — | — |
| [ ] | A03 | Agent queue and chat tools | A01,A02,D02,F06 | S2,S3 | Claim/lease/complete APIs distinct from display read state, pagination, retries/fencing; live owner rights and stable attribution for all tools. | todo | — | — | — | — |
| [ ] | A04 | Delegations and session tokens | A03,D04 | S3,V1 | Session-scoped tokens bounded by owner and delegation on every tool, including ordinary chat reads; offboarding/expiry/revoke tests. | todo | — | — | — | — |
| [ ] | V01 | Zero-knowledge vault and policy | F05,F06,D04,D05a | V1,V4 | Client envelope crypto/versioning/AAD, ciphertext CRUD, ACL, grants, rate limits and metadata-only discovery; prove cloud cannot unwrap any credential. | todo | — | — | — | — |
| [ ] | V02 | Rust CLI local injection and registration | V01 | V2 | login/run/list/add with signed HTTPS and local unwrap, no values in argv/cloud, stdout/stderr scrubbing, temp cleanup and exit behavior; initial dev platform tested. | todo | — | — | — | — |
| [ ] | V03 | Conversational approvals and kill switch | V01,A04,C03 | V1,V4,S5 | Inbox and system DM, push via outbox, first-decision-wins, five-minute expiry, batched credentials, step-up and grant revocation. | todo | — | — | — | — |
| [ ] | V04 | Vault and agent activity UI | V03,A01 | V4,S1 | Credential/agent pages, live grants/revoke, approvals and provenance distinguish requester/owner/approver; metadata visibility enforced. | todo | — | — | — | — |
| [ ] | R01 | Headless runner and local policy | D02,D03,D05a,A04,V02 | V2,S7 | agentd outbound socket; OS-user-verified, local-only launch configs; immutable remote trigger schema; concurrency/cooldown, offline stop and process-tree tracking. | todo | — | — | — | — |
| [ ] | R02 | First local harness workflow | R01,V03 | S3,V2 | One validated noninteractive harness preset drains claims and posts replies, reuses session, reports blocked permissions, survives lost wake/exit race. | todo | — | — | — | — |
| [ ] | R03 | Tauri v2 native runner integration | R01,C01 | S7,V2 | Reuse reference Tauri patterns for tray, native local approval, runner lifecycle and stop control; narrow IPC/capabilities and trusted-origin boundary. | todo | — | — | — | — |
| [ ] | R04 | Harness and OS matrix | R02,R03 | V2,V3 | Test Claude Code/Codex/custom binary presets and injection/process cleanup on Windows/macOS/Linux; include WSL path/process decisions and version compatibility. | todo | — | — | — | — |
| [ ] | G01 | First end-to-end product gate | R02,V04,C04 | V3,S3 | Demonstrate two-device mention→session→approval→injection→thread reply→reuse→stop with synthetic secrets; failure and leak evidence. | todo | — | — | — | — |
| [ ] | C05 | Daily-use message features | C04,F06 | S1,S5 | Pins/bookmarks, saved items, forwarding/quotes, synced drafts, scheduled sends, snippets, slash commands, custom emoji and webhook posting. | todo | — | — | — | — |
| [ ] | C06 | Notifications, Home and Inbox | C03,V03,D08 | S5 | Human/agent tiers, per-room modes, keywords, thread subscriptions, DND, broadcast gate, ranked Home and actionable Inbox; private-item filters. | todo | — | — | — | — |
| [ ] | C07 | People, groups and administration | F04,A01,D08 | S2,S5 | Directory/status/timezone/working hours, groups, profile/hovercards, invitations, role controls, offboarding and ownership transfer. | todo | — | — | — | — |
| [ ] | C08 | Files, uploads and previews | C02,D07,D08 | S1,S5 | R2 metadata/quotas, authorized signed transfers, upload verification/cleanup, image paste, file lists, downloads and bounded safe unfurls. | todo | — | — | — | — |
| [ ] | C09 | Search and saved searches | C08,C04,D08 | S5 | FTS/operators/pagination with in-query visibility; saved searches and credential metadata ACL; extraction only per resolved scope. | todo | — | — | — | — |
| [ ] | C10 | Form and ranked work queues | C04,C07,D08,A03 | S4 | Forms/presets, statuses/privacy, stable ranking, voting eligibility, queue MCP tools and status changes under delegated owner rights. | todo | — | — | — | — |
| [ ] | C11 | Resumable one-way Slack import | C05,C08,C10 | S6 | Checkpointed channels/threads/reactions/files/authors/emoji mapping; reruns idempotent; imported history never wakes agents or sends live notifications. | todo | — | — | — | — |
| [ ] | V05 | Capture, import and execution ergonomics | V02,V03 | V3 | Create-only capture with approval, typed credentials/tags/template/file injection, imports and rotation UI; source deletion only explicit. | todo | — | — | — | — |
| [ ] | V06 | Device-mediated HTTP credential proxy | V01,V03,D05,R01 | V1 | Bound authorization and encrypted relay to an unlocked release device; safe egress/redirect handling, atomic usage/grants, redacted results/audit and offline-device behavior. | todo | — | — | — | — |
| [ ] | V07 | Vault recovery and owner sharing | D05,V04,R01 | V4 | Implement client-generated recovery, device/owner enrollment, removal and rekeying; prove no server-decryptable path and test lost-device/code cases. | todo | — | — | — | — |
| [ ] | V08 | Agent onboarding and leak prevention | V05,V06,A03 | V3 | MCP instructions/hints, skill/hooks/init, scan and canary design, non-authoritative hook behavior; real-harness anti-circumvention evaluations. | todo | — | — | — | — |
| [ ] | A05 | Cloud and custom runtimes | D06,A04,V06,F06 | S3 | Customer-org setup/test-event gate, authenticated provider calls, schedules/manual runs/budgets, dedup/reconcile and custom callbacks with visible failures. | todo | — | — | — | — |
| [ ] | R05 | Complete runtime configuration UI | R04,A05,V07 | S1 | Connected/local/cloud/custom screens, delegation sentence, run history, start/stop/expiry/budget behavior, locally pending preset changes. | todo | — | — | — | — |
| [ ] | P01 | Tauri desktop distribution | R03,R04 | S7 | Tauri v2 signed direct builds, updater, deep links, native notifications/badges/hotkeys/offline fallback; no unsafe remote-content native privileges. | todo | — | — | — | — |
| [ ] | P02 | Store preparation and capability matrix | F01,D08 | S7 | Prepare names/accounts/build profiles/privacy disclosures; specify macOS supervision build versus full direct build and Windows full build; track external review separately. | todo | — | — | — | — |
| [ ] | P03 | PWA and approvals companion | C06,V03,D08 | S5,S7 | Installed PWA chat/push and companion per chosen scope, approval deep links/step-up, expiry races and offline state; no promise to override OS notification settings. | todo | — | — | — | — |
| [ ] | P04 | Store packages and submissions readiness | P01,P02,P03,B02 | S7 | Validate distribution-specific capabilities, signing and approved commerce; prepare review artifacts; actual submission/review is separately evidenced. | todo | — | — | — | — |
| [ ] | B01 | Seat and storage entitlements | F04,D08,C08 | — | Solo/Team capacities and packs; 1/2/5/6/20/21/50-seat examples, quota warnings and upload limits; no deletion on lapse. | todo | — | — | — | — |
| [ ] | B02 | Billing integration and reconciliation | B01,F06 | — | Stripe test mode and chosen store rails, idempotent webhook handling/proration/cancellation, entitlement reconciliation; no unsolicited live purchases. | todo | — | — | — | — |
| [ ] | B03 | Pricing, upgrade and billing UI | B02,C07 | S1 | Pricing mockup becomes real flow; explicit added-seat/storage purchase, invoices/status, downgrade safeguards and restore after lapse. | todo | — | — | — | — |
| [ ] | O01 | Tenant backup/export/delete and restore | D07,F06,V07,C08 | V4 | Tenant-scoped export/PITR procedures, R2 cleanup, retention/archive tests; restore cannot silently reactivate grants/devices/delegations. | todo | — | — | — | — |
| [ ] | O02 | Cost instrumentation and resource limits | F06,C03,R02 | — | Per-tenant aggregated writes/reads/duration/storage and forecasts, idle runner measurements, published rate/concurrency limits and alarms. | todo | — | — | — | — |
| [ ] | O03 | Fleet operations and deployment recovery | F03,O01,O02 | — | Canary migration rollout/quarantine, internal tenant-health view, redacted diagnostics, key rotation, backward-compatible deploy and recovery runbooks. | todo | — | — | — | — |
| [ ] | G02 | Tenant isolation and vault security gate | C09,C10,C11,V07,V08,A05 | V3,V4,S2 | Adversarial two-tenant suite across HTTP/MCP/files/search/socket/replay/hooks; prompt injection and output leak tests; no quarantined failures. | todo | — | — | — | — |
| [ ] | G03 | Load, cost and resilience gate | O02,O03,R05,C11 | — | 50 humans/500 sockets plus agent-heavy/idle/import cases; measure p95, writes and costs; inject outages, lost replies, duplicates and approval races. | todo | — | — | — | — |
| [ ] | G04 | Cross-platform acceptance gate | P04,B03,R05 | S7,V2 | Browser/Tauri/CLI/companion acceptance matrix, accessibility/dark mode, signatures/install/update, onboarding and platform limitations verified. | todo | — | — | — | — |
| [ ] | G05 | Release documentation and final decision | G01,G02,G03,G04,O03 | — | Reconcile PRD/HLD/mockups, publish-ready docs/marketing and support runbooks, enumerate accepted deferrals and external reviews; release only with required authorization. | todo | — | — | — | — |

## Evidence records

### D04 — Vault and approval contract

- Task / owner: D04 / `/root`
- Status / dates: done / 2026-09-06 to 2026-09-06
- Decision delivered: independent `use`, `reveal` and `manage` ACL verbs; union inside one verb followed by mandatory membership/device/origin/policy/delegation intersections; exactly one accountable owner/delegation per autonomous request; signed opaque project/device claims; a concrete step-up matrix; digest-bound, per-item batch approval; exact grant identity, expiry, atomic consumption and revocation triggers. Cloud authorization releases ciphertext work to a trusted device and never grants a cloud decrypt.
- Changed files: `docs/vault-authorization-contract.md`, `src/domain/vault-authorization.ts`, `src/domain/vault-authorization.test.ts`, `PRD.md`, `HLD.md`, `IMPLEMENTATION-PLAN.md`, `TESTING.md`, `IMPLEMENTATION-LEDGER.md`.
- Reused design: the ordered fail-closed decision pipeline, exact-client grants, delivery restrictions, single-use semantics and denial behavior were adapted from `../agent-vault/crates/av-core/src/policy.rs`, `grants.rs` and their case tables at the pinned V1 revision. Lepidy adds tenant membership, channel origin, device signatures, agents and one-owner delegation intersection.
- Automated evidence: `VAULT-AUTH-001–005` exercise ACL union, seven mandatory deny overrides, complete unattended delegation, independent reveal rights, ask/auto behavior and exact grants. The full local gate passed with 39 Worker/D1/SQLite/pure tests, 12 desktop/mobile browser tests, TypeScript, production Next.js/OpenNext/Wrangler builds, zero production dependency vulnerabilities and native Windows Tauri compilation.
- Limitations / follow-ups: D05 specifies multi-owner key envelopes and release-device protocols. F05 implements signed request and revocation persistence; V01/V03 implement durable policy, grants and approval races.

### D08a — Free workspace storage boundary

- Task / owner: D08a / `/root`
- Status / dates: done / 2026-09-06 to 2026-09-06
- Decision delivered: Solo keeps account, device, workspace, member, agent, channel, access, routing and coarse activity metadata in its cloud control/relay plane. One designated online computer is authoritative for messages, files, search, content-bearing agent state, audit and vault ciphertext in local SQLite. Remote operations use authenticated opaque relay frames, commit locally before acknowledgement, return `host_offline` without cloud queuing, and carry a monotonic host epoch that fences stale hosts. Host transfer, user-held backup recovery and resumable upgrade to Team are specified.
- Changed files: `docs/free-local-workspace-contract.md`, `PRD.md`, `HLD.md`, `IMPLEMENTATION-PLAN.md`, `IMPLEMENTATION-LEDGER.md`, `TESTING.md`, the control/workspace migration foundation and affected pricing/device mockups.
- Automated evidence: onboarding creates `storage_mode='local_host'` by default and initializes the relay object without message rows; the historical workspace migration suite reaches the plan-aware schema. The full local gate passed with 28 Worker/D1/SQLite tests and 12 desktop/mobile browser tests, plus production builds, dependency audit and native Windows Tauri compilation.
- Limitations / follow-ups: F03b implements the host SQLite protocol, opaque relay, reconnect/fencing, transfer and upgrade scenarios. No production relay is claimed by this decision task.

### D05a — Local execution and vault-root invariants

- Task / owner: D05a / `/root`
- Status / dates: done / 2026-09-06 to 2026-09-06
- Decision delivered: executable/script, arguments, working directory, environment mapping, harness and resource limits are local-only and require fresh OS user verification to change; remote triggers contain opaque ids and a local revision only. The account vault key and mandatory recovery code are generated and retained by trusted clients; Lepidy stores ciphertext and wraps without a decryption root. Cloud credential proxying is performed by an enrolled unlocked release device.
- Changed files: `docs/local-runner-configuration-contract.md`, `docs/vault-key-recovery-contract.md`, `PRD.md`, `HLD.md`, `IMPLEMENTATION-PLAN.md`, `IMPLEMENTATION-LEDGER.md`, `TESTING.md`, `src/domain/local-agent-trigger.ts`, its test, the cloud-schema negative test and affected runtime/vault/credential mockups.
- Automated evidence: `RUNNER-SEC-001` accepts the exact opaque trigger contract; eight `RUNNER-SEC-002` cases reject remote script, command, executable, argument, working-directory, environment, permission and limit fields. `CONTROL-INT-001` scans the real local D1 schema for forbidden vault-root, recovery-code and runner-configuration columns. `MOCKUP-SEC-001/002/003` render the disclosures and prove the remote runtime screen has no Edit or Reset control. The full local gate passed with 28 Worker/D1/SQLite tests and 12 desktop/mobile browser tests, production builds, dependency audit and native Windows Tauri compilation.
- Limitations / follow-ups: R01/R03 will prove real OS verification, protected local persistence and process behavior. V01/V07 will prove cryptographic non-recoverability, device enrollment, owner sharing and recovery with synthetic canaries.

### F04 — Identity and workspace onboarding

- Task / owner: F04 / `/root`
- Status / dates: done / 2026-09-05 to 2026-09-06
- Implementation delivered: verified-email password registration and single-use email login; Argon2id password hashing in the actual Workers runtime; Google account creation with collision-safe explicit linking; required-user-verification WebAuthn registration/authentication; Solo and Team workspace provisioning; tenant-local owner projection; email-bound invitations; active owner/admin invite authorization; role changes and last-owner protection in D1 and workspace SQLite.
- Changed files: `migrations/control/0002_auth_onboarding.sql`, `src/control/identity.ts`, `src/control/passkeys.ts`, `src/control/onboarding.ts`, `src/cloudflare/workspace-migrations.ts`, `src/cloudflare/workspace.ts`, `tests/onboarding.test.ts`, workspace migration tests and dependency/type configuration.
- Reused design: tenant-local handles and invitation concepts were adapted from `../slip-robotics-chat` at the revision recorded under S1/S2. Argon2id and native approval expectations follow the `../agent-vault` boundary recorded under V2/V4; no server vault custody was introduced.
- Integration scenarios: `IDENTITY-INT-001` covers verified signup, real Argon2id verification, wrong password and single-use links; `IDENTITY-INT-002` covers Google creation, collision and stepped-up explicit linking; `PASSKEY-INT-001` verifies RP id, required user verification, challenge consumption and counters; `ONBOARD-INT-001` proves Solo/Team storage-mode projection and last-owner enforcement across D1/DO; `ONBOARD-INT-002` proves inviter authorization, verified-email binding, single-use acceptance and safe ownership transfer. Each case provisions its own identities/workspace and does not depend on test order.
- Verification: `npm run verify:local` passed with 28 Worker/D1/SQLite tests, 12 desktop/mobile browser tests, TypeScript, Next.js/OpenNext/Wrangler production builds, zero production dependency vulnerabilities and native Windows Tauri compilation.
- Limitations / follow-ups: F05 adds revocable sessions/devices and authenticates service entry points. The WebAuthn integration uses real production option generation plus a deterministic attestation/assertion verifier in local integration tests; browser-authenticator ceremony coverage belongs to F05/P03.

Append one record per completed task; use the matching task ID as its heading. For partial work, label it explicitly and retain in_progress or blocked in the table.

### D01 — Identity and tenant contract

- Task / owner: D01 / `/root`
- Status / dates: done / 2026-09-05 to 2026-09-05
- Decision delivered: path-scoped workspace URLs at `app.lepidy.com/w/{slug}`; WebAuthn RP ID `app.lepidy.com`; host-only opaque session cookie; tenant-local immutable member/agent/group authors; explicit stepped-up identity linking; recovery and versioned, fail-closed cross-plane revocation.
- Changed files: `docs/identity-tenant-contract.md`, `PRD.md`, `HLD.md`, `IMPLEMENTATION-LEDGER.md`.
- Reused design: `../slip-robotics-chat` commit `07508524d1b8aabc4dc12f2adb02f34779837505` handle, invitation and agent-author concepts; `../agent-vault` commit `d794820084151eddbdbb56bf9cd10b5bf3666cdc` device authority and recovery concerns. Both were adapted to a many-tenant account/member split; no source was copied.
- Verification: `npm run verify:local` passed using the pinned Linux runtime: 8 Workers tests, 6 browser integrations with accessibility scan, TypeScript, Next.js and OpenNext builds, Wrangler dry run, zero production dependency vulnerabilities, and native Windows Tauri formatting/compile.
- Exercised boundaries: the existing local integration gate remained green after reconciling the PRD/HLD. The contract records eight mandatory integration scenarios for F04/F05; no runtime identity behavior is claimed in this decision task.
- Limitations / follow-ups: custom tenant domains remain outside v1. F03 implements the schema and migration boundary; F04 and F05 implement and exercise linking, onboarding, session and revocation behavior.

### F03 — Workspace storage and migrations

- Task / owner: F03 / `/root`
- Status / dates: done / 2026-09-05 to 2026-09-05
- Implementation delivered: Wrangler-managed D1 control schema for accounts, login identities, passkeys, sessions, devices, workspace routing, tenant-local membership mappings, invitations, durable control operations and subscriptions; per-workspace SQLite migration chain with a singleton state row, contiguous versions, transactional compare-and-set progression, bounded failure records and per-object quarantine.
- Changed files: `migrations/control/0001_control_plane.sql`, `src/cloudflare/workspace-migrations.ts`, `src/cloudflare/workspace.ts`, `tests/control-plane.test.ts`, `tests/workspace.test.ts`, `tests/fixtures/migration-fixture.ts`, test/Wrangler configuration, `package.json`, `README.md`, `PRD.md`, `HLD.md`, `IMPLEMENTATION-LEDGER.md`.
- Reused code: `../slip-robotics-chat` commit `07508524d1b8aabc4dc12f2adb02f34779837505` schema concepts for people, agents, groups, channels, membership and messages. These were ported from shared Postgres assumptions into isolated SQLite tables with tenant-local authors. No proprietary source was copied verbatim.
- Integration scenarios: `CONTROL-INT-001` asserts D1 contains control entities and no tenant-content tables or sensitive content columns; `CONTROL-INT-002` proves one account receives distinct local member IDs in two tenants; `WORKSPACE-INT-001` migrates a new object from version zero; `MIGRATION-INT-001` upgrades a historical v1 fixture to v2 and proves repeat execution is stable; `MIGRATION-INT-002` injects a mid-migration SQL failure and proves atomic rollback, one failure record, persistent quarantine and isolation from a healthy object.
- Verification: `npm run db:migrate:local` applied `0001_control_plane.sql` with 19 successful commands. `npm run verify:local` passed: 12 Workers integration/pure tests, 6 browser integrations with accessibility scan, TypeScript, Next.js and OpenNext production builds, Wrangler dry run with D1/DO bindings, zero production dependency vulnerabilities and native Windows Tauri formatting/compile.
- Boundaries and doubles: tests use the real local D1 and real SQLite-backed Durable Objects under workerd. The broken migration is a test-only Durable Object fixture; no remote database or Cloudflare account resource was mutated.
- Limitations / follow-ups: schema recovery from quarantine remains an operator workflow for O03. F04 adds identity/onboarding behavior over these tables; F06 adds outbox delivery and alarms over the prepared operation tables.

### F01 — Next.js/OpenNext and Tauri workspace skeleton

- Task / owner: F01 / `/root`
- Status / dates: done / 2026-09-05 to 2026-09-05
- Decision or implementation delivered: Next.js 16.3.4 App Router with OpenNext 1.20.6; current Cloudflare bindings and generated types; initial SQLite `Workspace` Durable Object export; branded responsive application shell; Tauri v2 Rust workspace with macOS overlay titlebar, frameless Windows custom titlebar, native shadow and narrow window permissions. Next.js moved from PRD version 15 to 16 because the final 15.x release retained a high-severity PostCSS advisory and the selected OpenNext adapter explicitly supports Next.js 16.3.3+.
- Changed files: `package.json`, `package-lock.json`, `next.config.ts`, `open-next.config.ts`, `tsconfig.json`, `wrangler.jsonc`, `wrangler.next-dev.jsonc`, `worker-configuration.d.ts`, `custom-worker.ts`, `app/*`, `components/desktop-titlebar.tsx`, `src/cloudflare/workspace.ts`, `public/mark.svg`, `desktop-shell/*`, `src-tauri/*`, `.gitignore`, `README.md`, `PRD.md`.
- Reused code: `../slip-robotics-chat` commit `07508524d1b8aabc4dc12f2adb02f34779837505`, `desktop-tauri/src-tauri/src/lib.rs`, `desktop-tauri/src-tauri/capabilities/default.json`, `src/components/desktop-titlebar.tsx` → Lepidy Tauri window builder, narrow capabilities and branded React titlebar; adapted to Lepidy tokens and removed unrelated updater/menu/notification privileges. `../agent-vault` commit `d794820084151eddbdbb56bf9cd10b5bf3666cdc` was inspected for its Tauri v2 workspace conventions; no source was transplanted in F01.
- Verification: `npm run typecheck` passed; `npm run build` passed; `npm run cf:build` passed and generated `.open-next/worker.js`; `npx wrangler deploy --dry-run --outdir .wrangler/dist` bundled the Worker with Workspace DO, D1, KV, R2, Queue and Assets bindings; `npm audit --omit=dev` found zero vulnerabilities; `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` passed; native Windows `cargo check --manifest-path src-tauri/Cargo.toml` passed with `CARGO_INCREMENTAL=0`. Browser inspection at desktop/narrow width confirmed the responsive shell, readable content, landmark structure and controls.
- Evidence artifacts or commit: foundation commit `dff0d66`; local build artifacts under ignored `.next/`, `.open-next/`, `.wrangler/` and `src-tauri/target/`.
- Limitations / user-approved deferrals: Cloudflare resource IDs remain local placeholders until environment provisioning. The release Tauri build intentionally loads a bundled connection screen; an authenticated, origin-locked production bridge is deferred to R03/P01. macOS code follows the verified Slipchat overlay pattern but could not be compiled on this Windows host.
- Follow-ups and unblock conditions: D01 is required before F03 implements the full workspace schema and production tenant mapping. R03 will add trusted native runner behavior without granting remote workspace content unrestricted IPC.

### F02 — CI and reusable-code inventory

- Task / owner: F02 / `/root`
- Status / dates: done / 2026-09-05 to 2026-09-05
- Decision or implementation delivered: GitHub Actions jobs for web/Worker verification and Windows/macOS Tauri checks; Cloudflare's current Vitest 4 plugin with isolated Workers runtime storage; one pure idempotency-key rule fixture; one direct-RPC SQLite Durable Object fixture; pinned, path-level source-to-target inventory and proprietary-license status for both internal reference apps.
- Changed files: `.github/workflows/ci.yml`, `docs/reference-reuse-inventory.md`, `vitest.config.mts`, `wrangler.test.jsonc`, `tests/*`, `src/domain/idempotency-key.ts`, `src/domain/idempotency-key.test.ts`, `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`.
- Reused code: inventory pins `../slip-robotics-chat` at `07508524d1b8aabc4dc12f2adb02f34779837505` and `../agent-vault` at `d794820084151eddbdbb56bf9cd10b5bf3666cdc`. No additional reference implementation was copied in F02; the inventory records the planned adaptation boundary for S1–S7 and V1–V4.
- Verification: clean `npm@11.6.2 ci` passed; `npm run cf:typegen` passed; `npm test` passed 2 files/8 tests, including a local workerd SQLite DO; `npm run typecheck`, `npm run build`, `npm run cf:build`, Wrangler deployment dry run and production dependency audit all passed; native Windows Cargo format/check passed; the CI YAML parsed with jobs `web-and-worker` and `desktop`.
- Evidence artifacts or commit: foundation commit `dff0d66` includes the workflow, inventory and fixtures; the final ledger status is recorded in the following ledger commit.
- Limitations / user-approved deferrals: the local repository has no GitHub remote, so the authored CI workflow cannot receive a hosted run until a remote is connected and pushed. macOS compilation is represented in the CI matrix and awaits that first hosted run.
- Follow-ups and unblock conditions: connect the repository remote to obtain the first hosted Windows/macOS CI evidence. Add adapted-source entries to each later ledger record rather than treating the inventory as blanket approval to copy code.

### F02a — Local integration testing standard

- Task / owner: F02a / `/root`
- Status / dates: done / 2026-09-05 to 2026-09-05
- Decision or implementation delivered: mandatory local integration-testing contract for every implemented behavior; one cross-platform `npm run verify:local` gate; Playwright desktop/mobile shell checks; automated accessibility scanning; Windows/macOS titlebar rendering scenarios; CI browser execution. The initial run found and corrected six WCAG contrast failures in the live shell.
- Changed files: `TESTING.md`, `scripts/verify-local.mjs`, `playwright.config.ts`, `tests/browser/shell.spec.ts`, `tests/workspace.test.ts`, `package.json`, `package-lock.json`, `.github/workflows/ci.yml`, `.gitignore`, `README.md`, `IMPLEMENTATION-PLAN.md`, `IMPLEMENTATION-LEDGER.md`, `app/globals.css`.
- Reused code: no reference application code was copied. Test boundaries follow the existing Lepidy architecture and current official Cloudflare, Playwright and Tauri testing facilities linked from `TESTING.md`.
- Verification: `npm run verify:local` passed end to end with `WORKSPACE-INT-001`, 7 supporting idempotency cases, `SHELL-INT-001` at desktop/mobile, `SHELL-INT-002` at desktop/mobile, `DESKTOP-INT-001`, and `DESKTOP-INT-002`; totals were 8 Workers tests and 6 browser integration executions, zero browser retries, zero serious/critical axe violations, successful Next.js/OpenNext/Wrangler builds, zero production dependency vulnerabilities and a successful native Windows Tauri Cargo check.
- Evidence artifacts or commit: Playwright failure traces and screenshots are emitted under ignored `test-results/`; the passing run finished with `Local verification passed.`
- Limitations / user-approved deferrals: browser-mode desktop tests prove the platform-specific web chrome, spacing and drag/caption markup. Actual native caption command execution will be automated with WebdriverIO's embedded Tauri driver in R03/P01; those tasks cannot complete on browser-mode evidence alone.
- Follow-ups and unblock conditions: every future implementation record must cite scenario IDs and a passing local gate. Provider sandboxes and store/platform certification remain additional release evidence after deterministic local contract coverage passes.

### Record template

- Task / owner:
- Status / dates:
- Decision or implementation delivered:
- Changed files:
- Reused code: repository, commit, source path → destination, adaptation:
- Verification: exact command or browser scenario; result; platform/environment:
- Evidence artifacts or commit:
- Limitations / user-approved deferrals:
- Follow-ups and unblock conditions:

## Stage reviews

No stages completed. Add a dated review after each exit gate with linked task evidence and unresolved issues.

## Handoff

Foundation state: F01, F02 and F02a are complete with a verified web, Worker and Windows Tauri skeleton, mandatory local integration gate, CI definition and pinned reuse inventory.
Ready to start: D01, D02, D06, D07, and D08. D04 and F03 become ready after D01. Run ready tasks according to actual dependencies; do not treat this list as a stale override.
Desktop decision: **Tauri v2**, as explicitly requested by the user. Next.js is the web UI and server layer, not a replacement for the native desktop shell.
