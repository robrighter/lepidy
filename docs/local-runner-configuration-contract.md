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

## Asking for a local change

A remote owner may not change a preset, and may not be left with nothing to do
about one. The resolution is an *ask*, added with R05:

- The request carries an **intent from a closed set** — `approve_agent`,
  `review_preset`, `revalidate_harness`, `review_limits` — and nothing else. No
  free text, no parameters, no target field. A free-text note would be a launch
  configuration channel with extra steps.
- It is addressed to the device that already answers for that agent, at the
  preset revision that device last reported. A caller may not name a different
  device, a different revision or a different preset.
- It stays **pending** until that device registers a preset revision strictly
  higher than the one recorded when the ask was made. A reconnection at the same
  revision confirms nothing, because a registration is not evidence that anybody
  stood at the computer; only a local edit moves the revision, and a local edit
  requires the operating-system verification gesture above.
- An owner may withdraw an ask. Nothing else resolves one, and there is no
  expiry that silently marks it done.
- The device is told what it owes through the depth check it already makes, as
  a list of the same intents. The daemon prints them and acts on none of them.

Cloud state for a request is therefore an intent, a device id, a member id, a
revision number and a state. The schema has no column any launch field could
occupy, and a test asserts that over the whole workspace schema.

## Required tests

1. Every remote API, MCP and relay operation rejects executable, script, argument, working-directory, environment and limit fields.
2. A valid remote trigger starts only the locally stored preset and cannot override it through unknown or nested fields.
3. Local mutation requires the native/CLI capability and a fresh OS-verification result; replay and expired verification fail.
4. Configuration files are owner-only, updates are atomic and crash recovery retains either the old or new complete revision.
5. Changing a preset revision invalidates pending starts and stale remote frames.
6. Control-plane and workspace cloud schemas contain no columns for scripts, commands, arguments, paths or environment values.
7. A local-change request accepts only the closed intent set, records the device's real revision rather than a caller-supplied one, ignores every launch field offered alongside it, and stays pending across a re-registration at the same revision.
8. A registration at a higher revision confirms the pending requests for that device and no others; withdrawal is idempotent and does not resurrect an ask.
