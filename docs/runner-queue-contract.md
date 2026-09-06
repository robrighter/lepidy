# Runner and queue lifecycle contract

**Status:** Accepted  
**Decision:** D02  
**Date:** 2026-09-06  
**Applies to:** local agent runners, workspace/host queue authority, MCP sessions, delegations and kill controls

This contract makes a local agent session reusable without letting a stale or disconnected process retain authority. Queue durability belongs to the workspace authority: a Team workspace Durable Object or the Solo host SQLite store. A runner is an outbound client of that authority and never becomes a second source of queue truth.

## 1. Designation and concurrency

An agent has one designated runner device and one monotonically increasing `runner_epoch`. Changing the device or its locally approved preset revision increments that epoch, revokes the prior session token and fences its queue leases. V1 has no automatic runner failover because another computer may not have the same locally approved command or project access. A person must approve a replacement on that computer.

One agent may have at most one live harness session. One runner may serve many agents. Its locally protected configuration sets a default maximum of two concurrent harnesses and may be changed locally from one through sixteen. The workspace may impose a lower entitlement or safety limit, but no remote instruction can raise the local limit.

## 2. Durable queue and ordering

Every work item has an immutable id, agent id, origin message/event id, accountable owner/delegation id, priority, enqueue sequence, state, attempt count and `not_before`. The unique `(agent_id, origin_id, action_kind)` tuple prevents a retried mention or schedule event from enqueueing twice.

Eligible work is ordered by priority (`urgent`, `normal`, `background`), then enqueue sequence and id. Claiming is separate from human read state. Pausing an agent blocks new claims but preserves pending work. Cancellation marks pending work cancelled; claimed work also emits a stop instruction and its final state records whether the process stopped cleanly.

## 3. Claim, lease and fencing

The runner uses a short authenticated request to claim one eligible item. A successful claim transaction:

1. rechecks the agent, owner, delegation, runner device, `runner_epoch`, preset revision, kill switch and concurrency;
2. changes `pending` to `claimed`;
3. increments the item's `lease_generation` and attempt count;
4. assigns the session id and a random, hashed lease token;
5. sets a 60-second lease expiry; and
6. returns the plaintext lease token once to the runner.

The runner renews at most every 20 seconds. Renewal and completion require the exact agent, item, session, runner device, runner epoch, lease generation and lease token. A stale holder cannot renew, append progress, request credentials or complete work after reassignment. Heartbeats update an in-memory connection view; only claims, material session transitions and periodic last-seen checkpoints write durable state.

Completion is an idempotent compare-and-set. Replaying the same completion id returns the recorded result. A different completion or output digest under that id fails. Socket delivery happens after commit and may be retried.

## 4. Retry and ambiguous outcomes

The runner records `execution_started` with the lease before launching the configured harness.

- A lease lost before `execution_started` returns to pending after 5, 30, 120 and 600 seconds, capped at five claims.
- A process that reports a definite transient failure may use the same bounded schedule when the harness marks the operation retry-safe.
- A lease lost after `execution_started`, a crash with no final receipt or a timed-out external action becomes `needs_attention`. It is never automatically executed again because the external effect may already have happened.
- Five pre-start or explicitly retry-safe failures become `dead_letter`. A human can retry by creating a new work item linked to the old one.

This distinction prevents duplicate messages, file changes, purchases and other side effects while still recovering automatically from a runner that crashes before it starts work.

## 5. Session lifecycle and idle timeout

The durable states are `starting`, `running`, `waiting`, `stopping`, `stopped` and `failed`; absence of a live session is shown as `idle`. A runner reuses the live session for later work by asking the harness to perform another bounded `agent_next` call after a wake. The workspace object never holds that request open.

After the queue drains, the harness waits locally. The default idle timeout is ten minutes and may be configured locally between one and sixty minutes. A session has an eight-hour hard lifetime. At timeout the runner asks the harness to exit, waits ten seconds, then terminates its process tree. When a process exits, cleanly or otherwise, the runner rechecks queue depth before declaring the agent idle; nonzero depth starts a fresh session subject to cooldown and concurrency.

## 6. Wake, reconnect and disconnect

The hibernatable runner WebSocket carries `wake { agent_id }`, `stop { agent_id, reason }` and metadata-only state. A wake never carries an executable, arguments, path, environment or prompt. Enqueue persists a pending wake in the same transaction; delivery is retried by the workspace outbox. On every connection and process exit, the runner queries its designated agents for queue depth, closing the lost-wake race without polling a permanently open request.

If the socket disconnects, the runner accepts no new work or credential release. It tries to reconnect while current leases retain authority. If it cannot renew before the 60-second lease expiry, it terminates the harness process tree and clears the session token locally. Solo content remains local, but disconnected autonomous execution still stops because membership, delegation, kill-switch and vault revocation cannot be rechecked. A local **Stop all sessions** always works without a network.

## 7. Session-scoped token

Each harness gets an opaque session token minted from one current delegation. The cloud stores only its hash. It is bound to workspace, agent, accountable owner, delegation, session, runner device, runner epoch, local preset revision and an explicit capability list. It cannot create agents, change owners, edit local launch configuration, reveal a vault value or widen its own scope.

The token expires after 15 minutes and may be rotated while the session, lease, membership, delegation, device and kill switch remain valid. Its absolute expiry is the earlier of delegation expiry and the session's eight-hour lifetime. Rotation invalidates the previous token. Stopping the session, changing runner/preset authority, pausing the agent, removing the owner, revoking the delegation/device or enabling the kill switch revokes it immediately. Every MCP tool still checks live tenant and delegation authority; possession is not a cached authorization decision.

## 8. Required automated scenarios

1. Concurrent claimers yield one lease; a stale generation cannot renew, progress or complete.
2. A lost response followed by the same claim/completion id returns the committed result without duplicate work.
3. A pre-start crash retries with the bounded schedule; a post-start crash becomes `needs_attention` and never auto-runs.
4. A paused agent, revoked owner/delegation/device, changed runner epoch or kill switch rejects the next action and stops a live session.
5. Reconnect and process-exit depth checks drain work after a lost wake without a parked Durable Object request.
6. Disconnect prevents new work and terminates the process tree no later than lease expiry.
7. One session is reused for sequential mentions, exits after its local idle timeout and cannot exceed eight hours.
8. Session tokens reject wrong workspace, agent, owner, delegation, session, runner, epoch, preset revision, capability and expiry.
9. Wake and cloud schemas reject every executable, argument, working-directory, environment and prompt field.
10. Solo host and Team Durable Object implementations pass the same queue state-machine fixtures.
