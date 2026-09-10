/**
 * The one suite that drives the real desktop application.
 *
 * Everything else about this shell is exercised as Rust, or as configuration,
 * or through a stand-in for the Tauri runtime in a browser. None of that proves
 * the application *runs* — that a window opens on the workspace, that the page
 * inside it can reach the native side at all, and that the navigation guard is
 * a guard rather than a closure nobody ever called. R03 deferred this and named
 * the harness; this is it.
 *
 * It speaks WebDriver to `tauri-driver` directly, over HTTP, rather than
 * through WebdriverIO. Two reasons, and the second is the load-bearing one:
 * four scenarios do not justify a two-hundred-package dependency tree in a
 * repository whose gate audits its dependencies, and the protocol they need is
 * five calls. The full runner also cannot be reached from the Linux side of
 * this development machine at all — the Windows firewall refuses inbound
 * connections from WSL — so the suite runs entirely on the platform whose GUI
 * it is driving, which a plain script can do and a framework's runner cannot.
 *
 * Run it through `npm run test:desktop-gui`, which starts the workspace this
 * window points at. It is not part of `npm run verify:local`: it needs
 * `tauri-driver` and a platform WebDriver whose version matches the installed
 * WebView2, which a fresh checkout does not have. See TESTING.md.
 */

import { spawn } from "node:child_process";
import process from "node:process";

const DRIVER_PORT = Number(process.env.LEPIDY_DRIVER_PORT ?? 4444);
const application = process.env.LEPIDY_DESKTOP_BINARY;
const origin = process.env.LEPIDY_ORIGIN;
const nativeDriver = process.env.LEPIDY_NATIVE_DRIVER;

for (const [name, value] of Object.entries({
  LEPIDY_DESKTOP_BINARY: application,
  LEPIDY_ORIGIN: origin,
  LEPIDY_NATIVE_DRIVER: nativeDriver,
})) {
  if (!value) {
    console.error(`lepidy: ${name} must be set; run this through npm run test:desktop-gui`);
    process.exit(1);
  }
}

/* -------------------------------------------------------------------------- */
/* A WebDriver client, in as much of the protocol as four scenarios need        */
/* -------------------------------------------------------------------------- */

const base = `http://127.0.0.1:${DRIVER_PORT}`;

async function call(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 400)}`);
  }
  if (payload?.value?.error) {
    throw new Error(`${method} ${path}: ${payload.value.error} — ${payload.value.message}`);
  }
  return payload.value;
}

/** Wait for something, without ever sleeping a fixed amount and hoping. */
async function until(what, probe, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
      last = value;
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${what} (last: ${last})`);
}

/* -------------------------------------------------------------------------- */
/* The scenarios                                                               */
/* -------------------------------------------------------------------------- */

const results = [];

function check(id, description, assertion) {
  if (assertion === true) {
    results.push({ id, description, ok: true });
    console.log(`  ok   ${id} ${description}`);
    return;
  }
  results.push({ id, description, ok: false, detail: assertion });
  console.log(`  FAIL ${id} ${description}\n       ${assertion}`);
}

async function scenarios(session) {
  const at = () => call("GET", `/session/${session}/url`);
  const run = (script, args = []) =>
    call("POST", `/session/${session}/execute/sync`, { script, args });

  // DESKTOP-GUI-001 — it opens, on the workspace, and the page is Lepidy's.
  const landed = await until("the window to load the workspace", async () => {
    const url = await at();
    return url && url.startsWith(origin) ? url : null;
  });
  check(
    "DESKTOP-GUI-001",
    "opens a window on the trusted origin and renders the application",
    landed.startsWith(origin) || `the window is at ${landed}`,
  );
  const title = await until("the document to have a title", () =>
    run("return document.title || null;"),
  );
  check(
    "DESKTOP-GUI-001",
    "the page in the window is Lepidy's own",
    /lepidy/i.test(title) || `the document title was ${JSON.stringify(title)}`,
  );

  // DESKTOP-GUI-002 — the shell tells the page which platform it is, which is
  // what reserves room for the native window controls.
  const platformMark = await until("the shell to mark the platform", () =>
    run("return document.documentElement.dataset.desktopPlatform || null;"),
  );
  check(
    "DESKTOP-GUI-002",
    "marks the document with the desktop platform",
    platformMark === "windows" ||
      platformMark === "macos" ||
      platformMark === "linux" ||
      `the mark was ${JSON.stringify(platformMark)}`,
  );

  // DESKTOP-GUI-003 — the native side answers the real page. This is the first
  // proof anywhere that the IPC boundary works outside a unit test: a real
  // webview, the real origin check, the real command.
  const reported = await run(`
    const done = arguments[arguments.length - 1];
    return window.__TAURI_INTERNALS__
      ? window.__TAURI_INTERNALS__.invoke('platform_name', {})
      : 'NO BRIDGE';
  `);
  const platform = await Promise.resolve(reported);
  check(
    "DESKTOP-GUI-003",
    "answers a native command from the page on the trusted origin",
    platform === platformMark || `platform_name answered ${JSON.stringify(platform)}`,
  );

  // DESKTOP-GUI-004 — the navigation guard is a guard. This is the look-alike
  // R03's origin rules refuse in Rust; here it is refused in a real window, by
  // a page that asked to go there, which is how a hostile link would ask.
  const before = await at();
  await run("location.href = 'https://lepidy.example.evil.test/';");
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const after = await at();
  check(
    "DESKTOP-GUI-004",
    "refuses to navigate the window to a look-alike origin",
    after === before || `the window moved from ${before} to ${after}`,
  );
  // And having refused, the window is still working rather than wedged.
  const stillThere = await run("return document.title || null;");
  check(
    "DESKTOP-GUI-004",
    "is still the same working window after the refusal",
    /lepidy/i.test(stillThere ?? "") || `the title is now ${JSON.stringify(stillThere)}`,
  );
}

/* -------------------------------------------------------------------------- */

// A driver left behind by an interrupted run still answers on this port, and a
// suite that quietly attached to it would be driving a binary built from
// whatever the tree looked like then. Refuse instead, and say what to do.
try {
  const stale = await fetch(`${base}/status`, { signal: AbortSignal.timeout(2_000) });
  if (stale.ok) {
    console.error(
      `lepidy: something is already answering WebDriver on port ${DRIVER_PORT}.\n` +
        "It is almost certainly a tauri-driver left by an interrupted run, and attaching\n" +
        "to it would drive whichever binary that run started. Stop it and try again.",
    );
    process.exit(1);
  }
} catch {
  // Nothing there, which is what we want.
}

// Named with its extension on Windows and spawned without a shell, so that
// `driver.kill()` reaches the driver itself. Through a shell it reaches the
// shell, and the driver survives to hold the port — which is what the check
// above then refuses on the next run.
const driver = spawn(
  process.platform === "win32" ? "tauri-driver.exe" : "tauri-driver",
  ["--port", String(DRIVER_PORT), "--native-driver", nativeDriver],
  { stdio: ["ignore", "inherit", "inherit"] },
);
driver.on("error", (error) => {
  console.error(`lepidy: could not start tauri-driver (${error.message})`);
  process.exit(1);
});

let session;
let failed = false;
try {
  await until("tauri-driver to answer", async () => {
    const response = await fetch(`${base}/status`);
    return response.ok;
  }, 20_000);

  session = await until("a session on the application", async () => {
    const value = await call("POST", "/session", {
      capabilities: {
        alwaysMatch: { "tauri:options": { application } },
      },
      desiredCapabilities: { "tauri:options": { application } },
    });
    return value?.sessionId ?? value?.["sessionId"] ?? null;
  }, 60_000);

  await scenarios(session);
} catch (error) {
  failed = true;
  console.error(`lepidy: ${error.stack ?? error.message}`);
} finally {
  if (session) {
    try {
      await call("DELETE", `/session/${session}`);
    } catch {
      // The window is going away with the driver either way.
    }
  }
  driver.kill();
}

// The driver spawns the platform WebDriver, which spawns the application. A
// suite that left either behind would make the next run attach to a stale one.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    driver.kill();
    process.exit(1);
  });
}

const broken = results.filter((result) => !result.ok);
console.log(
  `\n${results.length - broken.length} passed, ${broken.length} failed, ${results.length} total`,
);
process.exit(failed || broken.length > 0 || results.length === 0 ? 1 : 0);
