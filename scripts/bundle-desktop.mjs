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
 *
 * Pass `--variant mas` or `--variant msix` for a store package. The variant
 * decides what is in the bundle and is compiled into the binary, because a
 * runtime switch would be a build claiming capabilities its package does not
 * have — and on a store build, claiming them is what gets an application
 * rejected, or accepted and then broken for everybody.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = path.join(root, "src-tauri", "Cargo.toml");
const npmCli = process.env.npm_execpath;
const unsigned = process.argv.includes("--unsigned");

/** Which channel this bundle is for. Direct unless asked for otherwise. */
const VARIANTS = {
  direct: { config: "bundle.direct.json", sidecars: true },
  mas: { config: "bundle.mas.json", sidecars: false },
  msix: { config: "bundle.msix.json", sidecars: true },
};
const requested = process.argv[process.argv.indexOf("--variant") + 1];
const variant = process.argv.includes("--variant") ? requested : "direct";
if (!Object.hasOwn(VARIANTS, variant)) {
  process.stderr.write(
    `lepidy: unknown variant ${JSON.stringify(variant)}; expected one of ${Object.keys(VARIANTS).join(", ")}\n`,
  );
  process.exit(1);
}
const { config: variantConfig, sidecars } = VARIANTS[variant];

function run(label, command, args) {
  process.stdout.write(`\n=== ${label} ===\n`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: process.env });
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

// The Mac App Store build carries neither, because its sandbox forbids the one
// thing they are for. Building them anyway and then not shipping them would
// leave a staged binary the gate would have to know to ignore.
if (sidecars) {
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
}

// Staged rather than referenced in place: Tauri looks for the triple in the
// file name and ships the file beside the application with the triple stripped,
// which is what lets the shell find the daemon next to its own executable.
const staging = path.join(root, "src-tauri", "binaries");
if (sidecars) {
  fs.mkdirSync(staging, { recursive: true });
  for (const binary of ["lepidy", "lepidy-agentd"]) {
    const built = path.join(root, "src-tauri", "target", "release", `${binary}${suffix}`);
    const staged = path.join(staging, `${binary}-${triple}${suffix}`);
    fs.copyFileSync(built, staged);
    process.stdout.write(`staged ${path.relative(root, staged)}\n`);
  }
} else if (fs.existsSync(staging)) {
  // Left over from a direct build on the same tree. Removed rather than
  // ignored: a staged binary beside a package that must not carry one is the
  // kind of thing that gets picked up by a later change to the config.
  fs.rmSync(staging, { recursive: true, force: true });
  process.stdout.write("removed staged sidecars: this variant carries none\n");
}

// `LEPIDY_VARIANT` is read at compile time by both the gate and the shell, so
// the binary that ships knows which package it is in.
process.env.LEPIDY_VARIANT = variant;
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
  variantConfig,
]);
