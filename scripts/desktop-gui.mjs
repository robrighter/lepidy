import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * Run the desktop GUI suite against a real workspace.
 *
 * The window this drives is a real application on the host operating system,
 * and the workspace it points at is the same built Worker the browser suite
 * uses. On WSL those are two different machines: the Worker runs on the Linux
 * side and the application on the Windows side, which reaches it through the
 * localhost forwarding WSL provides in that direction. The reverse direction is
 * refused by the Windows firewall, which is why the suite itself runs over
 * there rather than here.
 *
 * This is not part of `npm run verify:local`. It needs `tauri-driver` and a
 * platform WebDriver whose version matches the installed WebView2 runtime, and
 * a fresh checkout has neither; a gate that could not run on a fresh checkout
 * would be a gate people stop running. See TESTING.md for when to run it.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3101;
const origin = `http://localhost:${PORT}`;
const wsl = process.platform === "linux" && os.release().toLowerCase().includes("microsoft");

function fail(message) {
  process.stderr.write(`lepidy: ${message}\n`);
  process.exit(1);
}

/** The compiled application, and a clear refusal rather than a driver timeout. */
function applicationPath() {
  const configured = process.env.LEPIDY_DESKTOP_BINARY;
  if (configured) return configured;
  const name = wsl || process.platform === "win32" ? "lepidy-desktop.exe" : "lepidy-desktop";
  const built = path.join(root, "src-tauri", "target", "debug", name);
  if (!fs.existsSync(built)) {
    fail(
      `${path.relative(root, built)} does not exist.\n` +
        "Build it first: cargo build --manifest-path src-tauri/Cargo.toml -p lepidy-desktop",
    );
  }
  return built;
}

/** The platform WebDriver, which must match the installed WebView2 runtime. */
function nativeDriverPath() {
  if (process.env.LEPIDY_NATIVE_DRIVER) return process.env.LEPIDY_NATIVE_DRIVER;
  if (wsl || process.platform === "win32") {
    const home = windowsUserProfile();
    const guess = `${home}\\.lepidy-webdriver\\msedgedriver.exe`;
    return guess;
  }
  return "/usr/bin/WebKitWebDriver";
}

function windowsUserProfile() {
  return execFileSync(
    "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "$env:USERPROFILE"],
    { encoding: "utf8" },
  ).trim();
}

async function answering(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status > 0) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

const application = applicationPath();
const nativeDriver = nativeDriverPath();

process.stdout.write("\n=== Workspace for the desktop window ===\n");
const worker = spawn(process.execPath, [path.join(root, "scripts/browser-worker.mjs"), "production"], {
  cwd: root,
  stdio: "inherit",
});
/**
 * Stop the workspace, and wait for it to actually be gone.
 *
 * Signalling and exiting is not enough: `wrangler dev` forwards the signal to a
 * workerd that takes a moment to release the port, and this process leaving
 * first means the next run — or the local gate, which uses the same ports —
 * finds the port still held by something nobody can see. That is exactly how
 * this was discovered.
 */
async function stop() {
  if (worker.exitCode !== null || worker.signalCode !== null) return;
  const gone = new Promise((resolve) => worker.once("exit", resolve));
  worker.kill("SIGTERM");
  const killed = setTimeout(() => worker.kill("SIGKILL"), 10_000);
  await gone;
  clearTimeout(killed);
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void stop().then(() => process.exit(1));
  });
}

if (!(await answering(origin, 120_000))) {
  await stop();
  fail(`the workspace did not answer at ${origin}; see .wrangler/worker-production.log`);
}

process.stdout.write("\n=== Desktop GUI scenarios ===\n");
let status;
if (wsl) {
  // Over the boundary: the suite, the driver and the window all live on the
  // Windows side, and only the workspace stays here.
  const suite = execFileSync("wslpath", ["-w", path.join(root, "tests/desktop/gui.mjs")], {
    encoding: "utf8",
  }).trim();
  const windowsApplication = execFileSync("wslpath", ["-w", application], {
    encoding: "utf8",
  }).trim();
  const command = [
    `$env:LEPIDY_ORIGIN='${origin}'`,
    `$env:LEPIDY_DESKTOP_BINARY='${windowsApplication.replaceAll("'", "''")}'`,
    `$env:LEPIDY_NATIVE_DRIVER='${nativeDriver.replaceAll("'", "''")}'`,
    `node '${suite.replaceAll("'", "''")}'`,
  ].join("; ");
  status = spawnSync(
    "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { cwd: root, stdio: "inherit" },
  ).status;
} else {
  status = spawnSync(process.execPath, [path.join(root, "tests/desktop/gui.mjs")], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      LEPIDY_ORIGIN: origin,
      LEPIDY_DESKTOP_BINARY: application,
      LEPIDY_NATIVE_DRIVER: nativeDriver,
    },
  }).status;
}

await stop();
process.exit(status ?? 1);
