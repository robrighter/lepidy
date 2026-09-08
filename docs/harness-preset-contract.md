# The harness preset contract

Status: implemented 2026-09-07 (R02). Builds on the
[local runner contract](./local-runner-contract.md) and the
[MCP waiting and harness contract](./mcp-waiting-and-harness-contract.md).

A **preset** is a local launch configuration. A **harness** is whatever it
starts. This is the agreement between them: what the runner hands a harness,
what the harness may do with it, and how it says how things went.

## 1. What a harness is given

Through its **environment**, never through `argv`:

| Variable | What it is |
|---|---|
| `LEPIDY_MCP_URL` | The workspace's MCP endpoint, absolute |
| `LEPIDY_SESSION_TOKEN` | A scoped session token, used as `Authorization: Bearer …` |
| `LEPIDY_SESSION_ID` | The session's id, required by every queue tool |
| `LEPIDY_AGENT_ID` | The agent this run answers for |
| `LEPIDY_WORKSPACE_ID` | The workspace, for logging and for nothing else |
| `LEPIDY_REQUEST_ID` | This particular run |
| `LEPIDY_PRESET_ID` | The preset that started it |

Plus whatever the preset's own `environment` map sets, applied first so nothing
local can quietly overwrite the session.

The token is in the environment for the same reason no credential is ever in a
command line: `argv` is readable by every other process on the machine and is
captured verbatim by harness logs. It is a *session* credential, not the device
key — bound to this device, this runner epoch and this preset revision, and
expiring on the delegation's own clock.

A harness is given **no prompt, no instruction and no content** from the
workspace at startup. It fetches its own work with the tools below. Everything
it reads through them is data, and the security preamble the workspace returns
with each item says so.

## 2. What a harness may do

The session carries exactly these capabilities:

```
whoami  list_channels  read_channel  read_thread
agent_inbox  agent_next  agent_start  agent_renew  agent_complete  agent_post
```

No `post_message` as a person, no agent administration, no vault verb. A session
that could widen itself would not be a boundary.

The loop is:

1. `agent_next` — claim one item, with a `claim_id` and a `lease_token` the
   harness invents. The workspace stores only the token's digest, so the same
   token must be presented on every later call about that lease.
2. `agent_start` — say work has begun. After this, a lost lease becomes
   `needs_attention` rather than being retried.
3. Do the work. Answer with `agent_post` in the channel the item names.
4. `agent_complete` — with a stable `completion_id` and an `output_digest`.
5. Back to 1 until `agent_next` answers with no item.

**Bounded, not "until empty."** A harness that loops on a queue being written to
never exits, and a run that never exits never frees its slot or reports its
outcome. The reference harness stops after eight items.

## 3. How a harness reports

By **exiting**. Not by calling a tool, because a harness that dies, hangs or is
killed calls nothing — and those are the cases somebody needs to hear about.

| Exit code | Meaning | What the runner does |
|---|---|---|
| `0` | Finished | Reports `completed`; nothing else happens |
| `78` | **Blocked** — refused something under its own permission posture | Reports `blocked`; anything this session had claimed becomes `needs_attention`, and the owner is told |
| anything else | Failed | Reports `failed`; claims become `needs_attention` and the session is discarded |
| killed | Failed | Same as above; the runner supplies the outcome the process could not |

`78` is the same number `lepidy run` uses for "a human has to decide", so one
number means one thing across everything a preset might invoke.

**Blocked is not an error.** It is a person's decision waiting to be made.
Retrying work that a permission posture refused just refuses again, so the item
is parked where an owner will look rather than thrown back on the queue.

## 4. What a preset must be

- **Non-interactive.** Nothing that waits for a terminal. Standard input is
  `/dev/null`.
- **Under its own safe default permission posture** — the harness's default,
  not a loosened one. Loosening is a local, deliberate edit, and it is an edit
  to a file the workspace cannot reach.
- **Bounded.** The preset's `timeout_seconds` kills the whole process tree.
- **Rate-limited locally.** `max_concurrent` and `cooldown_seconds` are the
  machine's brakes, not the workspace's.

## 5. Session reuse

One session serves many runs. Starting a harness is the expensive part, and a
workspace that minted a session per mention would spend more on process startup
than on work. The runner mints one when it connects and keeps it until it
expires, is revoked, or a run fails.

The ceiling is A04's and unchanged: the delegation's lifetime, the eight-hour
session cap, and exact-tuple token binding.

## 6. The reference harness

`lepidy-harness-reference` implements all of the above in about two hundred
lines. It is what the gate runs, and it is the executable form of this document:
anything written against this contract should be able to replace it.

It exists because **a verification gate that needs an API key, a model provider
and a network is not a gate.** It proves the contract deterministically and
offline. It is not a model-backed harness and this document makes no claim that
it behaves like one.

## 7. A Claude Code preset

Shipped as documentation, not as a certified configuration:

```bash
lepidy-agentd preset set claude \
  --program "$(which claude)" \
  --arg --print \
  --arg "Work your Lepidy queue using the lepidy MCP server, then stop." \
  --env "LEPIDY_HOME=$HOME/.lepidy" \
  --dir "$HOME/work" \
  --max-concurrent 1 --cooldown 30 --timeout 1800
```

The harness needs the MCP server registered on its side, pointed at
`LEPIDY_MCP_URL` with the bearer token from `LEPIDY_SESSION_TOKEN`.

**What is not claimed here.** Whether a given flag is non-interactive on a given
version, what that version's safe default permission posture is, whether it maps
a blocked permission onto exit code 78, and how it behaves on each operating
system are all untested by this task. R04 owns the harness and OS matrix, and
until it lands, a preset like the one above is a starting point somebody must
validate on their own machine — not a certification.

## 8. Required automated scenarios

All of these exist and pass; see `TESTING.md` for where.

1. A claim drained and answered in the room it came from, over real MCP.
2. Three runs served by one session, with exactly one minted.
3. A harness blocked by its permission posture reported as `blocked`, its claim
   parked for a person, nothing posted, and the operator told in words.
4. Work that arrived while the last run was ending, found by the check after
   the exit rather than by a wake.
5. The session token absent from every command line, log line and preset file.
6. A session refused for an agent the device is not the designated runner for,
   and for an agent with no live delegation.
