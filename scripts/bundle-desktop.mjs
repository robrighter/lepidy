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
// The rationale for each variant lives here rather than in its JSON: Tauri
// validates the merged configuration against a schema that forbids unknown
// keys, so a `"//"` comment in those files makes every bundle refuse to build.
const VARIANTS = {
  /**
   * The direct-download build's extras, merged over tauri.conf.json by `npm run desktop:build`.
   * They live in their own file for two reasons. Tauri validates externalBin when the crate is
   * compiled, so a sidecar declared in the base configuration would make `cargo check` require
   * a release build of the CLI — and the local gate compiles this crate on every run. And PRD
   * §10.1 splits this product into a direct build that carries the injection engine and a Mac
   * App Store build that cannot, so the direct build's extras belonging to the direct build is
   * the shape that split will need; P02 owns the store variant.
   */
  direct: { config: "bundle.direct.json", sidecars: true },
  /**
   * The Mac App Store build, merged over tauri.conf.json by `npm run desktop:build -- --variant
   * mas`. It is the collaboration and approvals client: chat, agents, the vault UI, approvals
   * with Touch ID, audit — complete for everyone whose job is to supervise agents. What is
   * deliberately absent is absent because of one rule, not an oversight: a sandboxed App Store
   * application may not spawn an arbitrary child process with an injected environment, which is
   * exactly and only what `lepidy run --with GITHUB_TOKEN -- gh pr list` does (PRD §10.1). So
   * there is no externalBin here, and the same rule means this build cannot host a runner
   * either — it can configure a local agent and watch its sessions. The bundle gate refuses if
   * this file ever grows a sidecar. Updates come from the store, so no updater artifact is
   * produced.
   */
  mas: { config: "bundle.mas.json", sidecars: false },
  /**
   * The Microsoft Store build, merged over tauri.conf.json by `npm run desktop:build --
   * --variant msix`. Windows is unconstrained: an MSIX package declares runFullTrust, so this
   * is the whole product with the injection engine in it (PRD §10.1, §10.2). Tauri has no MSIX
   * target, so this produces the MSI payload that MSIX packaging wraps; validating the packaged
   * artifact and its declared capabilities belongs to P04. Updates come from the store, so no
   * updater artifact is produced — a self-updater inside a store package is a rejection, and a
   * way to strand somebody on a version the store believes it already replaced.
   */
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

/** The triple rustc defaults to, asked rather than assumed. */
function hostTriple() {
  const version = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const host = version.split("\n").find((line) => line.startsWith("host: "));
  if (!host) throw new Error("rustc did not report a host triple");
  return host.slice("host: ".length).trim();
}

/**
 * The triple everything in this build agrees on.
 *
 * Passed to cargo, compiled into the gate as `LEPIDY_TARGET_TRIPLE`, used to
 * name the staged sidecars, and handed to `tauri build` — because those four
 * have to name the same triple or the bundle looks for a sidecar nobody built.
 *
 * It is a flag rather than rustc's host because the two can legitimately
 * disagree: on an ARM64 Windows machine running an x64 toolchain under
 * emulation, rustc reports `x86_64-pc-windows-msvc` while Tauri targets the
 * machine's own `aarch64`, and the staged names then match neither.
 */
const triple = process.argv.includes("--target")
  ? process.argv[process.argv.indexOf("--target") + 1]
  : hostTriple();
if (!triple) throw new Error("--target needs a triple, e.g. aarch64-pc-windows-msvc");
const windows = triple.includes("windows");
const suffix = windows ? ".exe" : "";

// The Mac App Store build carries neither, because its sandbox forbids the one
// thing they are for. Building them anyway and then not shipping them would
// leave a staged binary the gate would have to know to ignore.
if (sidecars) {
  run("Build the injection engine and the daemon", "cargo", [
    "build",
    "--release",
    "--target",
    triple,
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
    const built = path.join(root, "src-tauri", "target", triple, "release", `${binary}${suffix}`);
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
  "--target",
  triple,
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
  "--target",
  triple,
  "--config",
  // Resolved against this script's own root rather than left relative: the
  // Tauri CLI resolves `--config` from the working directory, which is the
  // repository root here, while the variant configs live beside the crate.
  path.join("src-tauri", variantConfig),
]);
