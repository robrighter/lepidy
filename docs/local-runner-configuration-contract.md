# Local runner configuration contract

**Status:** Accepted  
**Decision:** D05a  
**Date:** 2026-09-06

A remote person or agent may trigger a local agent that the host owner already configured. Nothing arriving through Lepidy may create or alter what the host will execute.

## Local-only authority

The executable or script path, arguments, working directory, allowed-directory roots, environment mapping, harness preset, concurrency, cooldown and process limits live only on the host. They are stored in an owner-only local file or SQLite database protected by operating-system permissions.

Configuration mutation is available only through:

- the signed Tauri application's narrow native command, invoked from its bundled local UI; or
- an interactive local `lepidy` CLI command.

Both require a fresh operating-system user-verification ceremony such as Windows Hello, Touch ID, or the platform credential prompt. The native command accepts structured fields and writes atomically; it never accepts a shell command assembled by the webview.

There is no HTTP route, Worker RPC, Durable Object method, WebSocket message, MCP tool, cloud-agent tool or remotely loaded web page that can write these fields. The cloud may retain a preset ID, host device ID, readiness state and a hash of the effective configuration. It must not store paths, scripts, arguments, environment values or executable content.

The enforceable boundary is local OS authority plus the absence of a Lepidy network mutation path. An application cannot prove physical presence against an operating-system remote-desktop or accessibility facility that the user has authorized; product text must not claim otherwise.

## Remote triggering

A trigger names an agent and an opaque preset ID. The host resolves that ID against its local configuration, rechecks local directory and rate policy, and either starts the exact approved configuration or returns a bounded refusal. A trigger cannot override any field.

Every local configuration change increments a local revision and invalidates pending start approvals made for an older revision. The host may report the revision/hash and non-sensitive capability labels to the cloud so clients can show that local review is required.

## Required tests

1. Every remote API, MCP and relay operation rejects executable, script, argument, working-directory, environment and limit fields.
2. A valid remote trigger starts only the locally stored preset and cannot override it through unknown or nested fields.
3. Local mutation requires the native/CLI capability and a fresh OS-verification result; replay and expired verification fail.
4. Configuration files are owner-only, updates are atomic and crash recovery retains either the old or new complete revision.
5. Changing a preset revision invalidates pending starts and stale remote frames.
6. Control-plane and workspace cloud schemas contain no columns for scripts, commands, arguments, paths or environment values.
