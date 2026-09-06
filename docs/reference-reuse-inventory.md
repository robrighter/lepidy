# Reference reuse inventory

This inventory pins the two internal applications that inform Lepidy. Both repositories are proprietary: neither contains a tracked standalone license file; Slipchat's desktop crate declares `UNLICENSED`, and Agent Vault's workspace declares `UNLICENSED`. Their code may be reused only within the owner's authorized internal work. Dependencies retain their own upstream licenses through their package manifests and lockfiles.

| Key | Pinned source and paths | Lepidy destination | Reuse state and boundary |
|---|---|---|---|
| S1 | `slip-robotics-chat@0750852`: `src/app/(app)/shell.tsx`, `src/components/sidebar.tsx`, channel composer/message components | `app/`, `components/`, future channel UI | Shell visual behavior adapted in F01. Data access and product-specific UI will be rewritten for the workspace authority. |
| S2 | `slip-robotics-chat@0750852`: handles, groups, bot mentions/specs | Future `src/domain/identity/` and Workspace storage | Candidate pure rules and tests only. Persistence, ownership, reserved namespaces and tenant-local identity await D01. |
| S3 | `slip-robotics-chat@0750852`: MCP tools, tokens, attribution and OAuth specs | Future `src/mcp/`, agent queue and authorization modules | Tool shapes and regression cases may be adapted. Slip-OS/CRM proxies, storage and authorization are excluded. |
| S4 | `slip-robotics-chat@0750852`: room modes, ranked feed and form composer | Future queue domain and UI | Validation and deterministic rank cases may be ported. Privacy and storage are new. |
| S5 | `slip-robotics-chat@0750852`: mentions, notify mode, DND, drafts and search | Future notification/search domain and UI | Preserve tested product semantics where the PRD agrees; replace delivery and queries. |
| S6 | `slip-robotics-chat@0750852`: Slack format/thread sync and custom emoji | Future one-way importer | Formatting and idempotent mapping concepts only. Live Slack bridging is excluded. |
| S7 | `slip-robotics-chat@0750852`: Tauri Rust shell, capability file and desktop titlebar | `src-tauri/`, `components/desktop-titlebar.tsx` | Adapted in F01. Kept current macOS overlay and Windows frameless patterns; removed company origin, updater, menu, notification and broad plugin capabilities. |
| V1 | `agent-vault@d794820`: policy, grants, usage and policy cases | Future TypeScript vault policy modules | Case tables and fail-closed ordering are candidates. Hosted tenant/ACL/delegation rules remain authoritative. |
| V2 | `agent-vault@d794820`: CLI run, scrub, with-file, client and end-to-end tests | Future Lepidy Rust CLI/runner crates | Process and leak-prevention behavior may be adapted. Unix socket auth is excluded. |
| V3 | `agent-vault@d794820`: capture/import/template/scan/hook/init and agent evaluations | Future CLI, hooks and evaluations | Create-only capture and anti-circumvention cases are candidates; hosted scan claims must be re-proven. |
| V4 | `agent-vault@d794820`: audit chain, crypto cases and approval UI | Future audit/vault services and approval UI | Test concepts and displayed approval facts may be reused. Local vault format and native biometrics are excluded. |

## Source-to-target controls

- Copy behavior and test cases deliberately; do not add either reference repository as a runtime dependency.
- Record the full source commit and path in the implementation ledger whenever code or a test is adapted.
- Preserve copyright and proprietary status in internal history. Do not publish reference source through generated fixtures, examples or documentation.
- Recheck the pinned commit before later reuse. Newer reference behavior requires a new inventory entry or an updated pin with reviewed differences.
- The exclusion list in `IMPLEMENTATION-PLAN.md` remains authoritative: no Supabase, Neon/Postgres layer, NextAuth/Auth.js legacy wiring, Vercel service, SSE polling, Slip-OS/company-domain lock, live Slack bridge, huddles or whiteboards.
