# Lepidy — Claude Code plugin

Everything that teaches an agent to use Lepidy correctly, packaged as one installable
unit. The rationale and the layering model are in [PRD §8.11](../../PRD.md); what is
implemented and how it is tested is in the
[V08 evidence record](../../IMPLEMENTATION-LEDGER.md).

```
plugin/lepidy/
├── .claude-plugin/plugin.json     manifest: hooks
├── skills/lepidy/SKILL.md         on-demand depth (layer 3)
├── hooks/hooks.json               PreToolUse registration (layer 4)
└── evals/agent-behavior.md        the anti-circumvention gate
```

> **Check the manifest schema before relying on it.** `plugin.json` and `hooks.json`
> are written to the shape current at the time of writing. The substance here is
> `SKILL.md` and the hook's rules, both of which are schema-independent and both of
> which are exercised by automated tests.

## The four layers

| Layer | Channel | Loaded | Cost |
|---|---|---|---|
| 1 | the MCP server's `instructions` | every session | tokens always, even when no credential is touched |
| 2 | tool descriptions, `credential_hint`, `lepidy hint`, deny hints | every session / on failure | small, then free |
| 3 | `skills/lepidy/SKILL.md` | on demand | free until invoked |
| 4 | the `PreToolUse` hook | every Bash call | free; catches the mistake before it costs a turn |

Layers 1 and 2 are portable to any MCP client. Layers 3 and 4 are Claude Code
specific.

## Layer 1 — the always-on text

Emitted in the MCP `initialize` response, and defined once in
`src/domain/agent-onboarding.ts` as `VAULT_INSTRUCTION`. **It is the only text loaded
into every session, so it is budgeted at 80 tokens and carries exactly one idea.**
A test asserts the budget, because the failure mode is somebody growing it into a
manual and taxing every session forever.

> Lepidy holds this workspace's credentials and lends them to commands, not
> conversations. Never ask for a value or read one from a file: run the work through
> `lepidy run --with NAME -- <command>`, which puts it in that child's environment.
> No tool returns a credential value. A refusal is an answer: report it and stop.

Change that string only with a corresponding eval run.

## Layer 4 — what the hook is and is not

**It is not a security boundary.** It fails open on every error, it sees only Bash
tool calls, an agent can construct a command it does not recognise, and it reads a
local cache that may be stale. The workspace's policy engine is the control; the hook
exists to teach at the moment of the mistake and to save a wasted turn.

Five rules, in order. First match wins:

| # | Condition | Action |
|---|---|---|
| 1 | Command already goes through `lepidy` / `lp` | Allow immediately — never coach a correct command |
| 2 | A known credential **value** appears literally in the command text | Block. A plaintext credential has reached the context; keep it out of argv and shell history too |
| 3 | `echo $KNOWN`, `printenv KNOWN`, bare `env` | Block. Printing an injected value defeats injection |
| 4 | Reading `.env`, `~/.aws/credentials`, `~/.netrc`, `id_rsa`, `.pgpass`, `~/.docker/config.json` | Block. Lepidy is the source for these |
| 5 | Program needs a credential and is not wrapped | Block with the exact rewrite |

Rule 5's program→credential mapping comes from each credential's own `commands`
metadata plus a small conventional table (`gh` → `GITHUB_TOKEN`, `aws` → `AWS_*`),
and it only ever names a credential the vault actually holds. That is the guard
against **false coaching**, which is the failure mode that makes somebody disable the
hook — after which none of this helps anybody.

## Installation

`lepidy init` registers the MCP server for the project and installs the skill, then
tells you exactly what it did not do rather than editing files whose schema it is
guessing at. `lepidy init --global` does the same for every project on the machine
through Claude Code's own CLI.

Confirm it worked:

```bash
lepidy list
lepidy hint --command "gh pr list"
```
