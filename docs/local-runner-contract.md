# The local runner contract

Status: implemented 2026-09-07 (R01). Implements the wake transport specified by
the [MCP waiting and harness contract](./mcp-waiting-and-harness-contract.md) and
the queue state machine in the [runner and queue contract](./runner-queue-contract.md).

## 1. The one-way rule

The workspace decides **that** there is work. The machine decides **whether**,
**how often**, **how many at once**, **for how long**, and **what actually runs**.

That split is the whole design. Everything below is a consequence of it, and
every mechanism exists to make one direction of trust impossible rather than
merely discouraged.

| The workspace may | The workspace may not |
|---|---|
| Say an agent has work | Say what program to run |
| Name a preset the machine already registered | Describe a preset, or create one |
| Say the preset revision it last heard about | Change a preset, or its revision |
| Say "stop working this agent" | Say "start working, ignoring your limits" |
| Refuse the agent's next call | Reach anything on the machine that is not this socket |

## 2. What a wake is allowed to say

The wake frame carries the D05a trigger and nothing else:

```json
{ "type": "wake", "trigger": {
  "workspaceId": "…", "agentId": "…", "deviceId": "…",
  "presetId": "…", "configRevision": 3, "requestId": "…" } }
```

Six keys. There is no field for an executable, an argument, a working
directory, an environment mapping or a permission posture, so there is nothing
to smuggle one in. An unknown key is a **hard refusal of the whole trigger**,
not a field that gets ignored — on both sides:

- `src/domain/local-agent-trigger.ts` builds the frame and refuses to emit a
  malformed one.
- `src-tauri/crates/lepidy-runner/src/trigger.rs` parses it and refuses to act
  on one.

The guarantee only holds at the narrower end, which is why the runner's copy is
the one that matters and why it is tested against the specific keys an attacker
would reach for: `command`, `args`, `argv`, `cwd`, `env`, `permissionMode`,
`dangerouslySkipPermissions`, `executable`.

`presetId` is an opaque local name. The workspace stores whatever the machine
called its preset, so it can say it back; a name the machine does not recognise
is refused locally, and the machine never guesses.

## 3. Outbound only

The runner dials the workspace. The workspace answers on the socket the runner
already holds.

Nothing listens on the machine. No port is opened, no inbound firewall rule is
needed, and there is no code path by which a workspace initiates a connection to
somebody's laptop. A daemon that accepted inbound connections would be a much
larger promise than this product needs to make, and would put the blast radius
of a workspace compromise on every machine rather than on the queue.

The upgrade carries the same F05 signed envelope as every other device endpoint:
canonical claims, an ECDSA P-256 signature over them, the method and path
inside the signature, and the control plane's nonce table against replay. A
socket that were easier to open than the endpoints beside it would be the
weakest thing in the design.

**A socket is not a registration.** An unregistered device, a device belonging to
another member, or a superseded runner epoch each get a 409 rather than a
connection that would sit silently forever.

## 4. One device per agent

Registering **moves** an agent to a device. It never quietly shares one.

Two machines both deciding they answer for an agent is how a single mention gets
worked twice, and the queue's leases would then be the only thing between a
duplicate and a duplicated side effect. So the assignment is exclusive, the
displaced device is named in the response, and it is sent a `stop` for each
agent it lost.

The runner epoch identifies one run of the daemon. A registration with an epoch
lower than the stored one is refused, so a process that restarted with a stale
epoch cannot reclaim agents a newer one took; and a socket held by an older
epoch is closed when a newer registration lands.

## 5. Wakes cannot be lost, only delayed

A wake is written in the same transaction as the queue row it announces, and
delivered only **after** that transaction commits. A mutation that rolls back
delivers nothing.

Delivery is best effort. Durability is not:

| Situation | What happens |
|---|---|
| Runner connected | The frame is sent and the wake is marked delivered |
| Runner offline | The wake stays pending and is handed over on the next connection |
| Frame sent to a socket that then died | The runner's own depth check finds the work |
| Agent reassigned | Wakes addressed to the old device are deleted |
| Agent stopped | The pending wake is deleted with the stop |

Repeated work collapses into one pending wake per agent per device. A wake says
*there is work*, not *there is this work*; the depth check says how much.

## 6. The runner's own clock

D03 refused a parked wait because an idle agent must cost nothing. The
consequence is that a wake can be lost — to a redeploy, an eviction, a network
blip, a closed laptop lid — with nothing durable noticing. So the daemon asks
anyway:

- on every connection, before waiting for anything;
- after every process exit;
- and on its own idle timer, ten minutes by default, clamped between one minute
  and one hour so a preset cannot turn it into polling.

The read timeout on the socket *is* the idle timer, so no second thread holds a
clock. A lost wake costs one bounded call.

## 7. Local brakes

Every rate decision is local, in this order — and the order is the contract,
because a stop must outrank a preset that is otherwise ready to run:

1. **Stopped?** An agent switched off is not started, whatever else is true.
2. **Known preset?** A trigger naming something this machine does not hold is
   refused rather than guessed.
3. **Current revision?** A preset edited after the workspace last heard about it
   refuses work signed against the old one.
4. **Capacity?** Per agent, default one at a time.
5. **Cooldown?** Default fifteen seconds between starts.

A wake storm, a mention loop and an agent that answers itself all arrive looking
identical, and all three are stopped by the last two rules. Thirty wakes in a
moment cost one process.

## 8. Stopping

Stopping is durable first and a frame second. The durable half — the agent's next
bounded call is refused — is what actually holds; the frame is what makes it
prompt.

| Trigger | Reaches the runner as |
|---|---|
| Agent paused or archived | `stop { agentId, reason: "agent_paused" \| "agent_archived" }` |
| Delegation revoked | `stop { agentId, reason: "delegation_revoked" }` |
| Agent reassigned to another device | `stop { agentId, reason: "reassigned_to_another_device" }` |
| Owner releases the device | a `stop` per agent, then the socket is closed |

`releaseRunner` works with the machine unreachable, which is the case an owner
most needs it for: the rows go away whether or not anything is listening, so no
new work is queued for that device and its socket cannot be reopened.

A stop kills the **tree**, not the process the daemon happens to know about. A
harness spawns compilers, package managers, test runners and shells; killing
only the top of that leaves the rest alive, still holding injected credentials,
still writing files, still costing money. On Unix the child leads its own
process group and the group is signalled; on Windows `taskkill /T` does the same
job. Terminate first, kill after a ten-second grace.

## 9. Launch configuration

Presets live in `$LEPIDY_HOME/presets.json` and nowhere else. Each says what
runs: program, arguments, working directory, credential-to-environment mapping,
concurrency, cooldown, timeout — and the harness's own **safe default**
permission posture, never a loosened one.

Two gates guard the file:

- **The operating system.** It must be owner-only and owned by the user running
  the daemon, checked on **every load** rather than only on write, because a
  file that was created correctly and later opened up is exactly the case a
  write-time check misses.
- **A person.** Editing requires unsealing the local keystore, which requires
  the passphrase, which is read from the terminal and never from `argv`.

Editing moves the revision, which is signed into every request afterwards, so
the workspace can tell a session started under an edited preset from one started
under the preset it registered — without ever learning what either preset says.

**The passphrase is presence, not platform identity**, and the daemon keeps it
because a headless machine has no desktop to prompt on. R03 adds the stronger
gesture on top, through the desktop shell: Windows Hello confirms the person at
the keyboard, bound to a digest of the exact action, single-use and short-lived.
On a platform where no verifier is wired up the shell refuses rather than
assuming — see the [native shell contract](./native-shell-contract.md).

The owner-and-permissions check is a real OS check on both platforms now: file
mode and owning uid on Unix, and the discretionary ACL on Windows, where any
principal beyond the owner, `SYSTEM` and the administrators group is a refusal.

## 10. What this does not certify

This contract settles the transport and the local policy. It does **not**
certify any particular harness. Claude Code, Codex and a custom binary each have
their own non-interactive flags and their own idea of a safe default permission
posture, and asserting from here that a given flag is safe on a given version
would be a claim nobody has tested. R02 validates the first real preset end to
end; R04 owns the harness and operating-system matrix.

## 11. Required automated scenarios

All of these exist and pass; see `TESTING.md` for where.

1. One device per agent, with the displaced device named and stopped.
2. A wake written in the same transaction as its queue row, and discarded if
   that transaction rolls back.
3. An undelivered wake collected on reconnect, once.
4. A wake frame whose trigger has exactly the six schema keys.
5. A wake carrying an extra key refused whole, starting nothing.
6. Work found by a depth check that no wake announced.
7. A stop mid-run killing a grandchild that would otherwise have outlived it.
8. A storm of wakes costing one process.
9. An unsigned, tampered or stale-epoch socket refused.
10. A launch configuration that cannot be changed without the local passphrase,
    and is refused when the file is readable by anybody else.
