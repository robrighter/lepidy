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

## Credential CLI

`lepidy` is the local client that injects vault credentials into a command. It
lives in `src-tauri/crates/lepidy-cli` and builds on its own:

```sh
cargo run --manifest-path src-tauri/crates/lepidy-cli/Cargo.toml --bin lepidy -- --help
```

Four commands: `login` enrols this machine and generates the device signing key
and the vault wrapping key, whose private halves stay here sealed under a
passphrase Lepidy never sees; `list` shows credential metadata; `add` encrypts a
value locally and uploads only ciphertext; `run` asks the workspace to release
one credential for one command, decrypts it here, and runs the command with the
value in its environment or in an owner-only file that is removed afterwards.

No option accepts a credential value, a password or a passphrase — those are
read from the terminal, or from standard input in a documented order — because
a command line is readable by other processes and is captured verbatim by the
harness logs this CLI exists to keep credentials out of. `LEPIDY_HOME` chooses
the profile directory.

`run` requires `--reason`: a credential that asks every time raises an approval
card, and the reason is what the person deciding actually reads. When a card is
raised the command does not run — the CLI reports the request and exits 78, and
the card is answered in the Inbox or in the direct message from `@a.vault`.

## Desktop shell

Run `npm run desktop:dev` after installing the Tauri system prerequisites. The desktop window follows the current Slipchat platform pattern:

- macOS uses native traffic lights with an overlay titlebar and hidden title text.
- Windows uses an undecorated window with the native shadow, a branded drag region, and web-rendered caption buttons.
- Linux retains native window chrome.

Only development localhost receives the narrow window capabilities needed by the custom Windows controls. Release builds currently show the bundled connection screen; the hosted production origin and its explicit capability scope will be added with the authenticated desktop bridge.

The placeholder Cloudflare resource identifiers in `wrangler.jsonc` support local type generation and dry-run builds. Provisioned environment IDs belong in deployment-specific configuration, never in source secrets.
