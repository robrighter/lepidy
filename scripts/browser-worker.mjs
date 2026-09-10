import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const environment = process.argv[2];
if (!["development", "production"].includes(environment)) throw new Error("Expected a browser-test environment");
const portBase = Number(process.env.LEPIDY_BROWSER_PORT_BASE ?? 3100);
const root = process.cwd();
const temporary = mkdtempSync(path.join(tmpdir(), "lepidy-browser-"));
const config = JSON.parse(readFileSync("wrangler.jsonc", "utf8"));
config.name = `lepidy-browser-${environment}`;
config.main = path.join(root, "tests/fixtures/browser-worker.ts");
config.assets.directory = path.join(root, config.assets.directory);
config.vars.ENVIRONMENT = environment;
for (const binding of config.d1_databases) binding.migrations_dir = path.join(root, binding.migrations_dir);
const configPath = path.join(temporary, "wrangler.json");
writeFileSync(configPath, JSON.stringify(config));
const cli = path.join(root, "node_modules/wrangler/bin/wrangler.js");
const common = ["--config", configPath, "--local", "--persist-to", path.join(temporary, "state")];
const cleanup = () => rmSync(temporary, { recursive: true, force: true });
const migrated = spawnSync(process.execPath, [cli, "d1", "migrations", "apply", "CONTROL_DB", ...common], { stdio: "inherit" });
if (migrated.status !== 0) {
  cleanup();
  process.exit(migrated.status ?? 1);
}
// Both of the dev server's output streams go to a file rather than being
// inherited, and this is not a tidiness preference. Playwright gives this
// script pipes that it does not keep draining; handing one to workerd means its
// logging fills the 64 KiB buffer partway through a long suite and then fails
// on `write(): Broken pipe`, taking the server down and failing every scenario
// after it. A file is always drainable, and unlike `/dev/null` it keeps
// whatever the dev server said about its own death, which is the thing you
// need when it dies.
//
// `stderr` matters as much as `stdout` and was the half still inherited until
// the whole matrix could no longer finish: this suite deliberately provokes
// server-side errors — refused canaries, forged actions, denied handles — and
// wrangler writes every one of them to stderr, so it fills first on a run long
// enough to matter. The parent still announces an unexpected exit on its own
// stderr below, so a mid-suite death is still named on the console.
// Not `playwright-report`: the HTML reporter clears that directory when a run
// starts, which silently emptied this log every time it was most wanted.
const logDirectory = path.join(root, ".wrangler");
mkdirSync(logDirectory, { recursive: true });
const logPath = path.join(logDirectory, `worker-${environment}.log`);
const logFd = openSync(logPath, "w");
const child = spawn(
  process.execPath,
  [cli, "dev", "--port", String(environment === "development" ? portBase : portBase + 1), ...common],
  { stdio: ["ignore", logFd, logFd] },
);
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => { cleanup(); throw error; });
child.on("exit", (code, signal) => {
  // Said on stderr, which Playwright drains, so a mid-suite death names itself
  // instead of appearing only as a hundred refused connections.
  process.stderr.write(`lepidy: the ${environment} worker exited (code ${code}, signal ${signal}); see ${logPath}\n`);
  cleanup();
  process.exit(code ?? 0);
});
