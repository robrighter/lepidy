# The store capability matrix and disclosures

Status: prepared 2026-09-09 (P02). Companion to the
[desktop distribution contract](./desktop-distribution-contract.md), which owns
signing, the updater and the build gate.

This records what each distribution channel can do, what it deliberately cannot,
the identifiers and accounts each one needs, and the disclosure text both stores
require. **It does not submit anything.** Store review is an external process on
an external timeline; P04 owns the readiness evidence and the actual submission
is separately authorised.

## 1. One store rule, two consequences

**A sandboxed Mac App Store application may not spawn an arbitrary child process
with an injected environment.** That is exactly and only what
`lepidy run --with GITHUB_TOKEN -- gh pr list` does. There is no entitlement
that fixes it and no workaround worth shipping (PRD §10.1).

It has **two** consequences, and they should always be stated in the same breath
because they have the same cause and the second one is the one people forget:

1. The Mac App Store build has **no injection engine**.
2. The Mac App Store build **cannot host a runner** either. It can configure a
   local agent and watch its sessions; it cannot be the machine one runs on.

Windows is unconstrained: an MSIX package declares `runFullTrust`, so the
Microsoft Store build is the whole product.

## 2. The matrix

| | Direct download | Microsoft Store (MSIX) | Mac App Store |
|---|---|---|---|
| Platforms | Windows, macOS, Linux | Windows | macOS |
| Chat, agents, vault UI, approvals, audit | Yes | Yes | Yes |
| `lepidy` CLI in the package | Yes | Yes | **No** (§1) |
| Can be a local runner | Yes | Yes | **No** (§1) |
| Update path | Lepidy's signed updater | Store | Store |
| Commerce | Stripe | Own commerce permitted | Apple IAP, plus an external-purchase link where the entitlement allows |
| Bundle config | `bundle.direct.json` | `bundle.msix.json` | `bundle.mas.json` |
| Build | `npm run desktop:build` | `… -- --variant msix` | `… -- --variant mas` |

The variant is compiled in, not switched at runtime. A runtime switch would be a
build claiming capabilities its package does not have — and on a store build,
claiming them is what gets an application rejected, or accepted and then broken
for everybody. `distribution::Variant` is the single place that decides, the
bundle gate refuses a package that contradicts it, and the shell reports
`Runner unavailable` rather than `Stopped` on a build that could never host one:
"stopped" invites somebody to start it, and there nothing ever will.

**The CLI is distributed separately** — Homebrew, `winget`, `curl | sh`,
`.deb`/AppImage and `cargo install` — and this costs nothing in practice. A
person who needs `lepidy run` is already in a terminal, and installing a CLI
from a terminal is where they expect to get one.

## 3. Identifiers, accounts and obligations

Names are reserved once and then never changed: a bundle identifier is what
every installed copy, every keychain entry and every store listing is keyed on.

| | Value |
|---|---|
| Product name | Lepidy |
| Bundle identifier | `com.lepidy.desktop` |
| URL scheme | `lepidy://` (one scheme; see the presence contract) |
| Publisher | Lepidy |
| Updater endpoint | `https://updates.lepidy.app/v1/…` |
| CLI docs link shown by a build without the engine | `https://lepidy.app/cli` |

**External requirements, so they are budgeted rather than discovered.** None of
these can be produced from this repository, and each blocks a channel:

| Needed | For | Blocks |
|---|---|---|
| Apple Developer Program membership | Both macOS channels | Direct macOS, Mac App Store |
| Developer ID Application certificate + notarisation credentials | Direct macOS | Direct macOS |
| Mac App Distribution certificate + provisioning profile | Mac App Store | Mac App Store |
| EV or organisation-validated code-signing certificate | Windows direct | Direct Windows |
| Microsoft Partner Center account + Store identity | MSIX | Microsoft Store |
| Reserved listing names in both stores | Both stores | Both stores |
| MSIX packaging of the MSI payload | MSIX | Microsoft Store |

Tauri has no MSIX target, so the Microsoft Store variant produces the MSI
payload that MSIX packaging wraps. Validating the packaged artifact and its
declared capabilities belongs to **P04**.

## 4. The disclosures

Both stores require a data-use disclosure, and PRD §10.2 is explicit that it
**must describe the vault honestly** — an app store review is not the place to
be vague about holding customer credentials. The text below is drawn from §8.1
and is the source for both stores' forms.

### Data collected and linked to the user

- **Account identity.** Email address, display name and workspace membership,
  used to authenticate and to attribute messages. Not used for tracking and not
  shared with third parties.
- **Workspace content.** Messages, threads, files and agent activity the person
  creates, stored for the workspace they belong to.
- **Audit records.** Every credential request, approval, denial and release,
  with requester, agent, reason and decision. Retained because the product's
  purpose is that nobody has to wonder what an agent did with a token.

### Data collected and not linked to the user

- **Diagnostics.** Aggregate error and performance counters, redacted.

### Data not collected

- **Credential values.** Lepidy stores credential **ciphertext**, encrypted
  metadata, salts and wrapped data keys. The vault key and printable recovery
  code are generated on the user's own device, shown to them, and **never sent
  to or stored by Lepidy**. The Worker, Durable Object, D1, R2, logs, analytics,
  support tools and backups never receive a key that can independently decrypt
  them. Losing every enrolled device and the recovery code permanently loses the
  vault; support cannot override this.
- **Tracking identifiers.** None. Lepidy does not track users across
  applications or websites and runs no advertising identifier.

### What reviewers will ask about, answered in advance

- **"Does this app store passwords?"** It stores credential ciphertext for a
  workspace, encrypted on the user's device with a key the service never has.
  It is a team credential vault for automated tools, not a password manager for
  websites.
- **"Why does it need the network?"** Outgoing only, to the workspace the person
  signed in to. There is no listening port; the local runner holds an outbound
  connection.
- **"Does it execute code?"** The Mac App Store build does not start any child
  process. The direct and Microsoft Store builds ship a command-line tool that a
  person runs themselves, in their own terminal, to inject credentials into a
  command they typed.

## 5. What P02 does not claim

- **No account exists, and nothing has been submitted.** Every row in §3 is an
  external requirement. Store review is an external process on an external
  timeline and is tracked separately; P04 owns readiness evidence.
- **No store package has been produced.** The two store variants are configured
  and their configuration is asserted, but neither has been built: an `.app` for
  the Mac App Store needs a macOS machine, which does not exist here, and MSIX
  packaging needs the Store identity in §3.
- **The disclosure text is prepared, not filed.** It is written to be pasted into
  both stores' forms and to be reviewed by whoever signs the submission.
