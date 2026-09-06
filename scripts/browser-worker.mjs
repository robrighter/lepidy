import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const environment = process.argv[2];
if (!["development", "production"].includes(environment)) throw new Error("Expected a browser-test environment");
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
const child = spawn(process.execPath, [cli, "dev", "--port", environment === "development" ? "3100" : "3101", ...common], { stdio: "inherit" });
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => { cleanup(); throw error; });
child.on("exit", (code) => { cleanup(); process.exit(code ?? 0); });
