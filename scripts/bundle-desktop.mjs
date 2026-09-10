import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Build the direct-download desktop bundle.
 *
 * Three steps, in this order, and the order is the point:
 *
 * 1. build the CLI and the daemon and stage them under the names Tauri looks
 *    for, because PRD §10.1 says the direct download is the full product and a
 *    bundle without them is an application that cannot inject a credential;
 * 2. run `lepidy-bundle-gate`, which refuses if this environment cannot sign
 *    what it is about to produce;
 * 3. only then bundle.
 *
 * Pass `--unsigned` to build something for this machine. The gate says loudly
 * what that means, and what it produces must not be published.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = path.join(root, "src-tauri", "Cargo.toml");
const npmCli = process.env.npm_execpath;
const unsigned = process.argv.includes("--unsigned");

function run(label, command, args) {
  process.stdout.write(`\n=== ${label} ===\n`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/** The triple rustc will actually build for, asked rather than assumed. */
function hostTriple() {
  const version = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const host = version.split("\n").find((line) => line.startsWith("host: "));
  if (!host) throw new Error("rustc did not report a host triple");
  return host.slice("host: ".length).trim();
}

const triple = hostTriple();
const windows = triple.includes("windows");
const suffix = windows ? ".exe" : "";

run("Build the injection engine and the daemon", "cargo", [
  "build",
  "--release",
  "--manifest-path",
  manifest,
  "-p",
  "lepidy-cli",
  "--bin",
  "lepidy",
  "-p",
  "lepidy-runner",
  "--bin",
  "lepidy-agentd",
]);

// Staged rather than referenced in place: Tauri looks for the triple in the
// file name and ships the file beside the application with the triple stripped,
// which is what lets the shell find the daemon next to its own executable.
const staging = path.join(root, "src-tauri", "binaries");
fs.mkdirSync(staging, { recursive: true });
for (const binary of ["lepidy", "lepidy-agentd"]) {
  const built = path.join(root, "src-tauri", "target", "release", `${binary}${suffix}`);
  const staged = path.join(staging, `${binary}-${triple}${suffix}`);
  fs.copyFileSync(built, staged);
  process.stdout.write(`staged ${path.relative(root, staged)}\n`);
}

run("Distribution gate", "cargo", [
  "run",
  "--release",
  "--manifest-path",
  manifest,
  "--bin",
  "lepidy-bundle-gate",
  "--",
  ...(unsigned ? ["--unsigned"] : []),
]);

if (!npmCli) throw new Error("Run this through `npm run desktop:build`.");
// `--config` merges the direct build's extras over the base. Without it the
// bundle would install an application with no injection engine beside it, which
// is why the gate above refuses when either the declaration or the staged file
// is absent.
run("Bundle", process.execPath, [
  npmCli,
  "exec",
  "--",
  "tauri",
  "build",
  "--config",
  "bundle.direct.json",
]);
