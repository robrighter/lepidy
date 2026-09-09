# Lepidy

Lepidy is a shared workspace for people, agents, and credentials. The application uses Next.js on Cloudflare Workers through OpenNext and a Tauri v2 desktop shell. Team workspaces keep content in an isolated SQLite Durable Object; free Solo workspaces keep channel metadata in their cloud object while one designated computer owns content SQLite.

## Local development

Requires Node.js 22 or newer, npm 11 or newer, Rust, and the Tauri platform prerequisites for the current operating system. npm 11 is pinned because npm 10 cannot validate the current Vitest plugin's optional peer graph from the lockfile.

```sh
npm install
npm run cf:typegen
npm run dev
```

Apply the D1 control-plane migrations to the local Wrangler database with:

```bash
npm run db:migrate:local
```

Workspace Durable Objects migrate their isolated SQLite database on first wake. A failed workspace migration is rolled back and that workspace reports a quarantined health state.

Open <http://localhost:3000>. The Next.js development proxy intentionally uses `wrangler.next-dev.jsonc`; workspace Durable Objects run in the dedicated local Worker integration fixture.

The complete local gate is:

```sh
npm run verify:local
```

Install its browser once with `npx playwright install chromium`. The required coverage and evidence rules are defined in [TESTING.md](TESTING.md).

Useful checks:

```sh
npm run typecheck
npm run build
npm run cf:build
npx wrangler deploy --dry-run --outdir .wrangler/dist
cargo check --manifest-path src-tauri/Cargo.toml
```

Run `npm run cf:typegen` whenever bindings in `wrangler.jsonc` change. The generated `worker-configuration.d.ts` is committed so a fresh checkout can type-check before provisioning Cloudflare resources.

## People and workspace administration

The People screen is the tenant-local directory. Members can publish a title,
time zone, working hours, a short status and a declared availability without
exposing their global account identity. Declaring Focus or Away outranks being
connected, and clearing it hands the dot back to live connection state.
Mentioning somebody in a room shows that profile as a
hovercard on hover or keyboard focus. Group handles use the `g.` namespace; a
group creator or a workspace administrator can maintain its membership, a group
mention's card names who it would actually reach, and archived groups keep
their identity without remaining mentionable. An agent's mention card names its
owners, because mentioning an agent hands the message to all of them.

Owners and administrators can invite people, change permitted roles and
offboard members from the same screen. Solo invitations that would add a paid
seat are held until an administrator explicitly confirms the seat change.
Ownership transfer requires typing the destination member's exact handle, and
offboarding immediately advances authority in both the control plane and the
workspace, closing or revoking the former member's delegated access while
retaining their directory tombstone for attribution.

## Credential CLI

`lepidy` is the local client that injects vault credentials into a command. It
lives in `src-tauri/crates/lepidy-cli` and builds on its own:

```sh
cargo run --manifest-path src-tauri/crates/lepidy-cli/Cargo.toml --bin lepidy -- --help
```

`login` enrols this machine and generates the device signing key and vault
wrapping key, whose private halves stay here sealed under a passphrase Lepidy
never sees. `list` shows credential metadata; `add`, `capture`, `import` and
`rotate` create client-side ciphertext; `run` asks the workspace to release
credentials for one command, decrypts them here, and injects them into its
environment or owner-only temporary files.

No option accepts a credential value, a password or a passphrase — those are
read from the terminal, or from standard input in a documented order — because
a command line is readable by other processes and is captured verbatim by the
harness logs this CLI exists to keep credentials out of. `LEPIDY_HOME` chooses
the profile directory.

`run` requires `--reason`: a credential that asks every time raises an approval
card, and the reason is what the person deciding actually reads. When a card is
raised the command does not run — the CLI reports the request and exits 78, and
the card is answered in the Inbox or in the direct message from `@a.vault`.

`capture NAME -- command` stores a command's standard output as a new
credential, so a token an agent mints never passes through its own context.
It is create-only, and what it creates is switched off until a person confirms
it in the vault — an agent can create a credential this way but cannot make one
usable. `import` seeds the vault from a `.env` and leaves the file alone unless
`--shred` is given; `rotate` replaces a value and is deliberately something only
a person does. `run` also takes `--all-tagged TAG` for a whole tagged group
under one approval and `--with-template SRC:PATH` to resolve `${lepidy:NAME}`
placeholders into an owner-only file for the life of one command.

`scan`, `hint`, `hook` and `init` are the leak-prevention and onboarding half.
`lepidy scan <path|->` reports whether text contains the value of a credential
this machine knows about — wire it into a `pre-commit` hook. `lepidy hint
--command "<command>"` names the credentials a command needs and the exact
`lepidy run` rewrite. `lepidy hook pretooluse` is the Claude Code `PreToolUse`
hook, and `lepidy init` registers this workspace's MCP server, installs the
skill and the hook, and reports what it deliberately did not touch.

Those three read a **local advice cache** (`advice.json` in `LEPIDY_HOME`,
owner-only) written by any authenticated command and refreshed with `--refresh`.
They have to: a commit hook has no terminal to read a passphrase from and a
`PreToolUse` hook runs on every Bash call. So their advice can be stale, and
none of them is a boundary — the workspace's policy engine decides every
release, over a signed request, every time.

The cache and the workspace hold a **scan target** per credential: a SHA-256
digest of the value bound to workspace, credential and version, plus its length.
It finds an exact, whole, unencoded value; a base64'd, escaped or split secret
goes straight through, and nothing in the product claims otherwise. A digest is
a verifier, so it is served only to a member who already holds a verb on that
credential, `lepidy add --no-scan` withholds one, and a value shorter than eight
characters never gets one.

`lepidy add --canary` creates a **canary**: a deliberately fake value, generated
locally, never typed and never printed. Its public marker is stored in cleartext
metadata so the workspace can recognise it, and a message, MCP tool argument or
proxied request body carrying one is refused before the write, recorded, and
reported to the credential's custodians as a direct message from `@a.vault`.
Nothing legitimate ever sends a canary, so one appearing means a credential left
the injection path.

**The hook is not a security boundary.** It sees only Bash tool calls, it fails
open on every error, it reads a cache, and it is configuration the agent could
edit. It exists to teach at the moment of the mistake and to save a wasted turn.
`plugin/lepidy` holds the skill, the hook registration and the
[anti-circumvention gate](plugin/lepidy/evals/agent-behavior.md) that proves
those claims against a real harness process.

The first enrolled custodian also uploads an Argon2id/AES-GCM recovery package;
the printable recovery code and vault key never leave the CLI. On a replacement
device, `lepidy recover` downloads that ciphertext, opens it locally, rewraps
every current credential to a fresh member key, rotates the recovery package
and prints a new code. Signed device endpoints also support recipient-key-bound
device packages, explicit custodian addition, full-rekey custodian removal and
rekey-before-revoke device removal. Remotely served web pages receive none of
the recovery, private-key or DEK material.

## The runtime screen

Each agent has a runtime page at `/agents/<id>/runtime`, visible only to that
agent's owners. It answers one question in four forms — connected, local,
Claude Cloud, custom — and restates the delegation behind an unattended agent
as one English sentence, because a permission nobody can repeat is a permission
nobody is supervising.

The page can start a session by hand, stop every live session at once,
re-affirm a delegation before it expires, change a cloud run's spending cap,
and set who may cause a process to start on the machine — an owner-only policy,
and a switch that leaves mentions queueing without waking anything.

**It is not a launch editor, and no route behind it is.** The executable,
arguments, working directory, environment mapping, permission posture and
resource limits live only on the machine that runs them and are changed there
behind an operating-system verification gesture. What this page can do is ask
that machine to look at something — one intent from a closed set, with no
parameters — and then show that ask as pending until the machine reports a
higher preset revision through a signed registration. That revision is the only
evidence the cloud can have that somebody was actually at that computer, so it
is the only thing that clears the request. `lepidy-agentd status` prints the
same pending asks on the machine itself.

## Desktop shell

Run `npm run desktop:dev` after installing the Tauri system prerequisites. The desktop window follows the current Slipchat platform pattern:

- macOS uses native traffic lights with an overlay titlebar and hidden title text.
- Windows uses an undecorated window with the native shadow, a branded drag region, and web-rendered caption buttons.
- Linux retains native window chrome.

Only development localhost receives the narrow window capabilities needed by the custom Windows controls. Release builds currently show the bundled connection screen; the hosted production origin and its explicit capability scope will be added with the authenticated desktop bridge.

The placeholder Cloudflare resource identifiers in `wrangler.jsonc` support local type generation and dry-run builds. Provisioned environment IDs belong in deployment-specific configuration, never in source secrets.

Cloud/custom runtimes additionally require two platform secret bindings:
`TRANSPORT_SECRET_KEY` (at least 32 random bytes) envelopes webhook transport
secrets, and `WIF_SIGNING_JWK` contains the private platform OIDC signing JWK.
Provision both with the deployment secret store (for example, `wrangler secret
put`), never in `wrangler.jsonc`, logs, tenant data, or a checked-in environment
file. The matching public key must be published by Lepidy's OIDC issuer.
