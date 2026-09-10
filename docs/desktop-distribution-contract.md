# The desktop distribution contract

Status: implemented 2026-09-09 (P01b). Companion to the
[native shell contract](./native-shell-contract.md) and the
[desktop presence contract](./desktop-presence-contract.md).

This records how the desktop application is built, what a build refuses to do,
how it replaces itself, and the one suite that drives it for real.

## 1. The asymmetry everything here follows from

A Lepidy desktop build supervises a process that holds injected credentials, and
it replaces itself over the network.

- An unsigned installer that reaches somebody is a program nobody can attribute.
- An updater artifact with no signature is an update nobody can verify,
  delivered by a mechanism designed to run without asking.
- An update that installs while a harness is running leaves a process tree with
  injected credentials and no supervisor.

None of those is a thing to discover after shipping, so each is a refusal in the
build or a fixed ordering in the code, not a note in a runbook.

## 2. The gate refuses; it does not warn

`lepidy-bundle-gate` runs before `tauri build` and exits non-zero when this
environment cannot sign what it is about to produce. A warning in a build log is
a warning nobody reads on the one occasion it mattered, and by then the artifact
is on a download page.

What it requires, per platform:

| Platform | Required | Why |
|---|---|---|
| All | `TAURI_SIGNING_PRIVATE_KEY` (when updater artifacts are produced) | An unsigned update is an update nobody can verify |
| All | `LEPIDY_UPDATER_PUBKEY` | A build without one has no update mechanism — safe, and also a release that can never be fixed in place |
| Windows | `LEPIDY_WINDOWS_CERTIFICATE_THUMBPRINT` or `TAURI_WINDOWS_SIGNING_CERTIFICATE_THUMBPRINT` | SmartScreen tells every person who downloads an unsigned installer so |
| macOS | `APPLE_SIGNING_IDENTITY` or `APPLE_CERTIFICATE` | Gatekeeper refuses to open an unsigned build |
| macOS | `APPLE_API_KEY` or `APPLE_ID` | Signing without notarising ships something that still does not open |
| Linux | nothing | A `.deb` and an AppImage carry no code signature. Saying so is better than inventing a requirement; their integrity story is the updater signature and the checksum beside the download |

Three properties of the gate matter as much as the list:

- **It checks presence, not validity.** Only the platform's own tooling can say
  whether a certificate is good. What this prevents is the accident this
  repository can actually have — a build that quietly produced distributable
  artifacts because the machine had nothing configured.
- **It names variables and never reads their values.** A refusal message cannot
  put a signing key into a build log, which is exactly the sort of place this
  product spends its time keeping credentials out of.
- **An empty variable is not a credential.** The specific case: a CI environment
  that defines every secret name and populates none of them on a fork build.

`--unsigned` builds for the current machine and says loudly, on stderr, that
what it produced must not be published and is not an update.

## 3. The direct build carries the injection engine

PRD §10.1: the direct download is the full product, CLI included. So the bundle
ships `lepidy` and `lepidy-agentd` as sidecars, and the gate refuses if either
is undeclared or unstaged — a bundle without them installs an application that
cannot inject a credential, and nobody notices until `lepidy run` on a fresh
machine.

The declaration lives in `src-tauri/bundle.direct.json`, merged over the base
configuration by `npm run desktop:build`, for two reasons. Tauri validates
`externalBin` when the crate is *compiled*, so declaring sidecars in the base
configuration would make `cargo check` require a release build of the CLI — and
the local gate compiles this crate on every run. And §10.1 splits this product
into a direct build that carries the injection engine and a Mac App Store build
that cannot, so the direct build's extras belonging to the direct build is the
shape that split will need. **P02 owns the store variant.**

## 4. No key, no updater

The public key that verifies an update is compiled in from the environment at
build time. A build that was given none **does not register the updater at
all** — it has no update mechanism rather than one that trusts whatever answers
the endpoint. A key read at runtime would be a key that anybody who can write a
file beside the application can replace, which is the whole attack the signature
exists to stop; the committed configuration's `pubkey` is deliberately empty.

Endpoints are HTTPS, and the three `dangerous…` escape hatches Tauri offers are
each one boolean away from an update path that trusts the network. Plain HTTP
would not let somebody *forge* an update — the signature stops that — but it
would let them see which version every machine in a company runs and withhold
the release that fixes something.

## 5. The runner stops before the install, and a person chooses

Checking is automatic, because a person cannot act on an update they were never
offered. Downloading and installing is a **tray item** they choose, because this
application is a tray-resident supervisor and restarting it silently would stop
a machine answering for somebody's agents at a moment nobody chose. The item's
label carries the consequence — *"Restart to update to 0.2.0 (stops the
runner)"* — because that is what a person supervising agents needs before they
choose it, not after.

The ordering is asserted, not just written: the tray handler calls
`updater::prepare_to_install` before `install_pending_update`. Stopping
afterwards would be stopping nothing, because this process is already gone.

**No command reaches any of this.** There is no command that checks, downloads,
installs or restarts, and the pending update is a module-private slot with no
accessor. A page that could cause an update could cause a restart of the process
supervising somebody's agents.

## 6. The GUI harness, and the defect it found immediately

`npm run test:desktop-gui` starts the built Worker and drives the compiled
application through `tauri-driver`. It is the only test anywhere that goes
through a real webview.

It found a real defect on its first run. **Tauri refuses a custom command to a
remote origin unless a capability names it** — and the workspace is a remote
origin — so `runner_status`, `runner_stop`, `runner_start`, `local_verify`,
`platform_name`, `notify` and `set_badge` were *all unreachable from the only
page that is ever meant to call them*. Every other test in this repository
exercises those commands as Rust, where the access-control layer is not in the
way. The fix declares the command surface to the ACL in `build.rs` and grants
each command by name; the list now lives in three places — the invoke handler,
the build script and the capability files — and a test asserts all three agree.
Three places is more than one, but each is a place somebody would have to
deliberately add a command to, which is the property this surface is meant to
have.

It speaks WebDriver over HTTP directly rather than through WebdriverIO. Four
scenarios do not justify a two-hundred-package dependency tree in a repository
whose gate audits its dependencies, and on this development machine the full
runner cannot reach the driver at all: Windows refuses inbound connections from
WSL, so the suite runs entirely on the platform whose GUI it drives, which a
plain script can do and a framework's runner cannot.

**It is not part of `npm run verify:local`,** and that is a deliberate trade. It
needs `tauri-driver` and a platform WebDriver whose version matches the
installed WebView2 runtime, and a fresh checkout has neither; a gate that cannot
run on a fresh checkout is a gate people stop running. TESTING.md records when
to run it. It refuses to attach to a driver left by an interrupted run, because
doing so would drive whichever binary *that* run started.

## 7. What P01b does not claim

- **No artifact is signed, and none has been produced.** Signing needs
  certificates this repository must never hold: an EV or organisation-validated
  Windows certificate, and an Apple Developer ID with notarisation credentials.
  What is implemented is everything up to them, plus a gate that proves the
  build refuses to emit an unsigned artifact.
- **No update has ever been downloaded or verified.** There is no release
  endpoint and no signing key, so the check, download, signature verification
  and install path are compile-verified only. What is tested is the ordering,
  the reachability boundary and the configuration.
- **The tray and the native gesture are still undriven.** WebDriver reaches the
  webview's document, not the operating system's own chrome: a tray click and a
  Windows Hello prompt are not automatable this way and would need a UI
  automation harness. R03's limitation stands, narrowed — the window, the page,
  the IPC boundary and the navigation guard are now covered.
- **macOS is unexercised.** There is no macOS machine, so the `.app`/`.dmg`
  targets, the minimum system version and the notarisation requirement are
  declared and never run.
