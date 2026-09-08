# The harness and operating-system matrix

Status: implemented 2026-09-07 (R04). Companion to the
[harness preset contract](./harness-preset-contract.md) and the
[local runner contract](./local-runner-contract.md).

This is the honest state of what Lepidy's local runner has actually been shown
to do, on which machines, with which harnesses. Cells are marked **proven**
(an automated scenario runs it), **checkable** (an operator can prove it in a
second with a shipped command), or **unproven** — with the reason.

Nothing here is marked proven because it ought to work.

## 1. Operating systems

| | Linux | WSL2 | Windows | macOS |
|---|---|---|---|---|
| Daemon builds and its suites run | **proven** | **proven** | **proven** | **unproven** — no machine |
| Process-tree stop kills a grandchild | **proven** | **proven** | **proven** ¹ | **unproven** |
| Credential injection into a child's environment | **proven** | **proven** | **proven** | **unproven** |
| Output scrubbing across both streams | **proven** | **proven** | **proven** | **unproven** |
| File delivery is owner-only, checked | **proven** (mode bits) | **proven** | **proven** (real ACL) | **unproven** |
| Preset file refused when others can read it | **proven** (mode + uid) | **proven** | **proven** ² | **unproven** |
| Desktop shell builds | **unproven** ³ | **unproven** ³ | **proven** | **unproven** |
| Native user verification | **unimplemented** | **unimplemented** | **proven to compile** ⁴ | **unimplemented** |

¹ Through `taskkill /T`, exercised by the runner's own integration suite on the
Windows leg of the gate.

² The `icacls` parser has scenarios against recorded output, and the owner-only
rule is applied for real. Loosening a real file's ACL and watching the refusal
is **checkable**, not proven — the gate cannot safely edit an ACL.

³ The Tauri crate needs GTK development libraries that this project's Linux
environment does not have. This is an environment gap, not a code one: the
crate's own suites run on Windows.

⁴ Windows Hello is implemented and compiles on the gate toolchain. **No prompt
is ever displayed by an automated scenario** — a user-verification gesture is,
by construction, something a person performs.

## 2. Harnesses

| | Claude Code | Codex | Custom binary |
|---|---|---|---|
| Installed and readable on the gate machine | **proven** — 2.1.241 | **proven** — codex-cli 0.145.0 | n/a |
| Program exists, is a file, is executable | **proven** | **proven** | **checkable** |
| Version pinned and drift refused | **proven** | **proven** | **proven** |
| Non-interactive invocation validated | **unproven** ⁵ | **unproven** ⁵ | **proven** ⁶ |
| Safe default permission posture validated | **unproven** ⁵ | **unproven** ⁵ | **proven** ⁶ |
| Blocked permission mapped to exit 78 | **unproven** ⁵ | **unproven** ⁵ | **proven** ⁶ |
| Drains a claim and posts a reply | **unproven** ⁵ | **unproven** ⁵ | **proven** ⁶ |

⁵ Every one of these needs the harness to actually run, which needs a model
provider, an API key and network egress. **A verification gate that needs those
is not a gate**, so they are deliberately not in it. What R04 ships instead is
`lepidy-agentd preset check`, which answers everything else in a second, and the
version pin that makes a validated preset stay validated.

⁶ The reference harness, `lepidy-harness-reference`, which R02 drives end to end
against a real MCP endpoint.

**What this means in practice.** Somebody putting Claude Code or Codex behind
Lepidy must validate the invocation themselves, once, on their machine — and
`preset check` then keeps it honest by refusing when the harness moves. That is
a smaller promise than "we certified it", and it is the true one.

## 3. The WSL decision

**A preset must name a program on the same side of the boundary as the daemon
that will run it.** This is a refusal, not a warning.

A Linux daemon that starts a Windows executable — `/mnt/c/…/thing.exe`, or a
bare `thing.exe` — gets a process it cannot put in a process group and cannot
signal. `kill` reaches the interop stub, not the program. So a stop would
return success and leave the harness running with its injected credentials,
which is precisely the failure the whole stop path exists to prevent. The
reverse, a Windows daemon launching `wsl.exe`, has the same hole from the other
side.

`preset check` refuses both, names the consequence, and says which way to fix
it. The daemon refuses to start at all rather than discovering it at the first
mention, in front of whoever asked.

## 4. Version compatibility

A preset records the harness version it was validated against. `preset check`
pins it; every later check compares. Any difference is a **failure**, not a
warning, and the daemon will not start.

That is deliberately blunt. A non-interactive flag, a default permission
posture and an exit code can all change between versions, and no comparison of
version *numbers* can tell which way. So the rule is: it changed, therefore
somebody has to look.

Pinning does not move the preset revision — this machine wrote down what it
observed, it did not change what runs, and bumping the revision would strand
every live session for nothing. Editing a preset *clears* the pin, because
whatever was validated before was validated against a different preset.

## 5. What would close the unproven cells

- **macOS**: a machine. Everything else is written; the daemon and CLI crates
  have no macOS-specific code paths beyond the Unix ones already exercised on
  Linux, and the native gesture needs `LocalAuthentication` writing.
- **Linux and WSL desktop shell**: GTK development libraries in the build
  environment, then the existing suites run unchanged.
- **Linux native verification**: PAM.
- **A model-backed harness end to end**: a machine with credentials, run
  deliberately and outside the gate. `preset check` plus one real mention is the
  whole procedure.

## 6. Required automated scenarios

All of these exist and pass; see `TESTING.md` for where.

1. A program that does not exist, is not a file, or is not executable, refused
   before anything starts.
2. A working directory that has been deleted, refused.
3. Limits that would defeat the brakes, refused; the combination that turns a
   mention loop into a fork bomb, warned.
4. The WSL boundary refused from both sides, on any platform.
5. A pinned version matching, missing, and drifted — the last refusing, and the
   daemon refusing to start.
6. A file delivery's real permissions asserted on both platforms.
7. The harnesses actually installed on the gate machine read and recorded.
