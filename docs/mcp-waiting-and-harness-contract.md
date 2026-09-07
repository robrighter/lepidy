# MCP waiting and harness contract

Status: accepted 2026-09-07 (D03). Companion to the
[runner and queue contract](./runner-queue-contract.md), which this resolves the
open transport question in. Measurements below come from `MCP-WAIT-INT-001–003`
in `tests/browser/mcp-waiting.spec.ts`, run against the built Worker.

## 1. The decision

**There is no parked wait.** No tool call blocks, no request is held open while
an agent has nothing to do, and `agent_next` on an empty queue answers *now*
with `item: null`. A harness that wants to wait waits on its own clock.

The rejected alternative is the obvious one, which is why it needs writing down:
a blocking `agent_next` that returns when work arrives. It is one line in a
client and it removes the need for any wake transport at all. It is refused for
three reasons.

**It prices idleness like activity.** A parked call holds a Durable Object
request for the whole idle period. The product's free tier is "one human,
unlimited agents", and its business model rests on an idle agent costing
essentially nothing. Ten idle agents holding ten ten-minute requests, renewed
all day, is not nothing — and it is a cost that scales with how many agents a
customer *creates*, not with how much work they do. A design whose cost grows
with a number we encourage people to grow is the wrong design.

**It makes stopping hard.** The kill switch, a revoked delegation and an
offboarded owner all have to reach an agent that is mid-wait. Interrupting a
parked request means either a second channel to cancel it or waiting out the
park — and the second channel is the wake socket we would have been avoiding.
With bounded calls, a stopped session finds out at its next turn, and the
runner's idle timer bounds how long that is.

**It hides lost wakes rather than preventing them.** A parked call still ends —
on a timeout, a redeploy, an eviction, a network blip — and the client still has
to re-ask. So the reconnect path exists either way. Building it once, and using
it as the only path, means it is exercised constantly rather than only during
incidents.

## 2. What replaces it

| Concern | Mechanism | Owner |
|---|---|---|
| "There is work for you" | `wake { agent_id }` on the runner's outbound socket, persisted in the same transaction as the enqueue and retried by the outbox | R01 |
| "Is there work for me?" | One bounded `agent_next`, answered immediately | A03, proved here |
| Waiting while idle | The runner's own timer: ten minutes by default, configurable locally between one and sixty, eight-hour session ceiling | R01 |
| A wake that never arrived | A queue-depth check on every connection and every process exit | R01, proved here |
| Being stopped | The next bounded call is refused; the runner also receives `stop { agent_id, reason }` | R01 |

The workspace's side of all of this is already true and measured: every call is
bounded, and nothing is held open between them.

## 3. What was measured

Against the built Worker under `wrangler dev`, on a developer machine. These
establish *shape and magnitude* — bounded, tens to hundreds of milliseconds —
not production latencies, which O02 owns.

| Measurement | Observed | What it establishes |
|---|---|---|
| `agent_next` on an empty queue | 31–42 ms | Asking costs a round trip, not a park. This is the number the whole decision rests on. |
| Slowest call in a three-item drain (13 calls) | 296–391 ms | Nothing in the loop blocks; the slowest call is an ordinary write, not a wait. |
| Total server time for three complete turns | 1.1–1.5 s | One session's whole working cost, against an idle period that costs nothing. |
| Idle period with no calls | 1.5 s in the test, unbounded in principle | The workspace serves nothing at all while an agent waits. |
| Recovery after a wake that never arrived | 48–301 ms, one call | The entire cost of a lost wake. |
| A stopped session learning it stopped | 50–71 ms, one call, HTTP 401 | Cancellation is observed at the next turn, not waited out. |

A parked wait would be visible in this table as one call orders of magnitude
longer than the rest. `MCP-WAIT-INT-001` asserts that none is, so the property
stays proved rather than remembered.

## 4. Session reuse

One session served three separate pieces of work with one set of credentials and
no re-authentication, which is the property a runner depends on: starting a
harness is expensive, and a workspace that forced a new session per mention
would spend more on process startup than on the work.

Reuse is bounded by the same rules A04 already enforces — the delegation's
lifetime, the session's eight-hour ceiling, and the exact-tuple token rotation —
so a long-lived session is long-lived within limits somebody set, not
indefinitely.

## 5. Permission posture

Each local preset supplies a non-interactive invocation and **the harness's own
safe default permission posture**, not a loosened one. The workspace may hand a
session its capabilities and its brief; it may never change the executable,
arguments, working directory, environment mapping or permission posture, and
there is no remote schema through which it could. Loosening a posture requires a
local, OS-verified gesture on the machine that runs it.

What this contract does **not** do is certify a specific harness. Claude Code,
Codex and a custom binary each have their own flags for non-interactive
operation and their own idea of a safe default, and asserting from here that a
given flag is safe on a given version would be a claim nobody has tested. R02
validates the first real preset end to end; R04 owns the harness and OS matrix.
Until then this document records the shape a preset must have and nothing about
any particular one.

## 6. Required automated scenarios

1. Repeated work drained in one session, every call bounded, and an empty queue
   answered immediately rather than parked.
2. A wake that never arrived recovered by one bounded call on reconnect.
3. A stopped session refused at its next call, and still refused on the one
   after.
4. (R01) A wake delivered over the runner socket, and a depth check on
   connection and on process exit.
5. (R02) A real harness preset draining a claim and posting a reply
   non-interactively, under its own safe permission posture.
