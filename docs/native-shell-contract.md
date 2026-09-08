# The native shell contract

Status: implemented 2026-09-07 (R03). Companion to the
[local runner contract](./local-runner-contract.md) and the
[harness preset contract](./harness-preset-contract.md).

The desktop shell is a window onto a workspace plus four native abilities. This
records what those are, what guards each of them, and what is deliberately not
claimed.

## 1. The premise

The page in this window is written by Lepidy. **The content it renders is
written by agents and by strangers.** Every decision below follows from taking
that seriously: one cross-site scripting bug in a message renderer would
otherwise hand whoever wrote that message everything the native side can do.

So the native side is small enough to read in one sitting, and each part of it
is either read-only, protective, or gated behind a gesture the page cannot
perform on a person's behalf.

## 2. The trusted origin

The window loads exactly one origin and IPC is answered only for that origin.

- Given by `LEPIDY_ORIGIN`; loopback is allowed in a debug build so `next dev`
  works, and a release build with no origin set refuses to start rather than
  falling back to a default nobody notices is wrong.
- Plain HTTP is refused anywhere but loopback.
- Compared **as an origin, never as a prefix**. `https://lepidy.example.evil`
  starts with `https://lepidy.example`, and a prefix check is how that becomes a
  navigation nobody intended.
- A URL carrying a path, query, fragment or `user:pass@` credentials is not an
  origin and is refused outright — those are exactly the pieces a look-alike
  relies on.
- Enforced on navigation, not merely described: `on_navigation` refuses and logs
  anything outside the origin.

## 3. The command surface

Five commands. That is the whole list.

| Command | Guard |
|---|---|
| `runner_status` | Origin. Read-only |
| `runner_stop` | Origin. **Nothing else** |
| `runner_start` | Origin, plus a fresh native confirmation for exactly this action |
| `local_verify` | Origin. Asks the OS; the page cannot answer |
| `platform_name` | Origin. Returns a constant |

There is no command that reads a file, runs a program, or takes a path. Launch
configuration is edited by the local CLI on the machine — never through this
window.

The capability file grants only window chrome: no `shell`, no `fs`, no
`process`, no `http`, no `updater`, no `notification`, no `clipboard`, no
`dialog`. `withGlobalTauri` is off, and the CSP has no `unsafe-eval`.

## 4. Stopping never asks

`runner_stop` takes no confirmation, from the window or from the tray. It is
idempotent and safe with nothing running.

This is deliberate and it is the one asymmetry worth stating plainly: **a stop
that can be refused is a stop that gets skipped at the moment it is needed.**
The worst case of an unnecessary stop is that somebody's agents go idle. The
worst case of a stop that did not happen is a harness still running with
injected credentials after a person decided it should not be. That is not a
close call.

Stop kills the whole process tree, through the same code the daemon uses to stop
a harness.

## 5. The native gesture

`local_verify` asks the operating system to confirm the person at the keyboard.
Two properties matter more than which API is used.

**It is about one specific thing.** A confirmation is bound to a digest of the
exact action and subject — `edit the preset named claude` is a different digest
from `start the runner` and from `loosen the posture of claude`. A shell tricked
into asking for one harmless confirmation cannot bank it against another action.
The page chooses from a fixed list of actions rather than composing its own
prompt, because a page that could write the prompt could describe one thing and
have a confirmation recorded against another.

**It fails closed.** No verifier available, no enrolled credential, an error
from the platform — every one of those is a refusal, and nothing is recorded.
A gate that quietly stops being a gate on the machines where nobody looks is
worse than no gate, because people rely on it.

Confirmations are single-use, expire in two minutes, live in memory only, and
are cleared wholesale when the shell loses track of who is present.

**Platform coverage.** Windows Hello is implemented, through
`UserConsentVerifier`. macOS `LocalAuthentication` and Linux PAM are **not
wired up**, and on those platforms every gated action is refused with a message
saying so. That is a real limitation, not a soft one: the desktop shell on macOS
and Linux currently cannot start the runner from the window. The daemon's own
CLI still works there, behind the local vault passphrase, which is what a
headless machine has always used.

## 6. The tray

A runner keeps answering with no window open — that is what a headless daemon
is for — so the one thing a machine must never do is answer for somebody's
agents with no visible sign that it is. The tray is that sign. It shows the
runner's state, and its first item is the stop.

A daemon that exited on its own reads as *stopped unexpectedly*, not as
*stopped*: a person deciding whether their agents are covered acts on that
difference, and a shell that quietly restarted it would hide a real failure.

## 7. Required automated scenarios

All of these exist and pass; see `TESTING.md` for where.

1. An origin that refuses look-alikes, credentials, schemes and ports.
2. A confirmation that cannot be spent on a different action, twice, or late.
3. A platform with no verifier refusing and recording nothing.
4. Every command refusing an untrusted caller.
5. Stop working with nothing confirmed and nothing running.
6. A daemon that exited on its own reported as such.
7. The command list, capability grants and window security asserted as
   configuration, so a capability cannot creep in unnoticed.
