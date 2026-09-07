import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;

if (!npmCli) throw new Error("Run this verifier through `npm run verify:local`.");

function run(label, command, args, env = process.env) {
  process.stdout.write(`\n=== ${label} ===\n`);
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function npm(label, args) {
  run(label, process.execPath, [npmCli, ...args]);
}

npm("Generate Cloudflare binding types", ["run", "cf:typegen"]);
npm("Workers integration tests", ["run", "test:workers"]);
npm("TypeScript contracts", ["run", "typecheck"]);
npm("Next.js production build", ["run", "build"]);
npm("OpenNext Worker build", ["run", "cf:build"]);
// The browser suite drives the built Worker, so it runs after the bundle exists.
npm("Browser integration tests", ["run", "test:browser"]);
npm("Wrangler deployment bundle", ["run", "cf:dry-run"]);
npm("Production dependency audit", ["audit", "--omit=dev"]);

// The whole Rust workspace: the Tauri shell and the credential CLI, whose
// integration suite drives the compiled binary against a local double.
const cargoArgs = ["--manifest-path", "src-tauri/Cargo.toml", "--workspace"];

if (process.platform === "linux" && os.release().toLowerCase().includes("microsoft")) {
  const windowsRoot = execFileSync("wslpath", ["-w", root], { encoding: "utf8" }).trim();
  const manifest = `${windowsRoot}\\src-tauri\\Cargo.toml`.replaceAll("'", "''");
  const command = [
    "$env:CARGO_INCREMENTAL='0'",
    `cargo fmt --manifest-path '${manifest}' --all -- --check`,
    "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    `cargo check --manifest-path '${manifest}' --workspace`,
    "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    `cargo test --manifest-path '${manifest}' --workspace`,
  ].join("; ");
  run(
    "Native Windows Tauri compile",
    "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
  );
} else {
  run("Tauri formatting", "cargo", ["fmt", "--manifest-path", "src-tauri/Cargo.toml", "--all", "--", "--check"]);
  run("Native Tauri compile", "cargo", ["check", ...cargoArgs], {
    ...process.env,
    CARGO_INCREMENTAL: "0",
  });
  run("Native local-store and CLI integration tests", "cargo", ["test", ...cargoArgs], {
    ...process.env,
    CARGO_INCREMENTAL: "0",
  });
}

process.stdout.write("\nLocal verification passed.\n");
