# Lepidy

Lepidy is a shared workspace for people, agents, and credentials. The application uses Next.js on Cloudflare Workers through OpenNext, one SQLite Durable Object per workspace, and a Tauri v2 desktop shell.

## Local development

Requires Node.js 22 or newer, npm 11 or newer, Rust, and the Tauri platform prerequisites for the current operating system. npm 11 is pinned because npm 10 cannot validate the current Vitest plugin's optional peer graph from the lockfile.

```sh
npm install
npm run cf:typegen
npm run dev
```

Open <http://localhost:3000>. The Next.js development proxy intentionally uses `wrangler.next-dev.jsonc`; the workspace Durable Object will run in its dedicated local Worker fixture when F03 adds the storage and migration system.

Useful checks:

```sh
npm run typecheck
npm run build
npm run cf:build
npx wrangler deploy --dry-run --outdir .wrangler/dist
cargo check --manifest-path src-tauri/Cargo.toml
```

Run `npm run cf:typegen` whenever bindings in `wrangler.jsonc` change. The generated `worker-configuration.d.ts` is committed so a fresh checkout can type-check before provisioning Cloudflare resources.

## Desktop shell

Run `npm run desktop:dev` after installing the Tauri system prerequisites. The desktop window follows the current Slipchat platform pattern:

- macOS uses native traffic lights with an overlay titlebar and hidden title text.
- Windows uses an undecorated window with the native shadow, a branded drag region, and web-rendered caption buttons.
- Linux retains native window chrome.

Only development localhost receives the narrow window capabilities needed by the custom Windows controls. Release builds currently show the bundled connection screen; the hosted production origin and its explicit capability scope will be added with the authenticated desktop bridge.

The placeholder Cloudflare resource identifiers in `wrangler.jsonc` support local type generation and dry-run builds. Provisioned environment IDs belong in deployment-specific configuration, never in source secrets.
