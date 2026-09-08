import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "./harness";
import { freshAccount, signUp } from "./auth-helpers";
import { LOCALHOST_BASE, slugFor } from "./device-helpers";
import { registerPasskey } from "./vault-helpers";

const ROOT = process.cwd();
const EXE = process.platform === "win32" ? ".exe" : "";
const LEPIDY = path.join(ROOT, "src-tauri", "target", "debug", `lepidy${EXE}`);
const AGENTD = path.join(ROOT, "src-tauri", "target", "debug", `lepidy-agentd${EXE}`);
const HARNESS = path.join(ROOT, "src-tauri", "target", "debug", `lepidy-harness-reference${EXE}`);
const PASSPHRASE = "gate-local-vault-passphrase";
const CANARY = "g01-synthetic-secret-canary-7419";
const CREDENTIAL = "GATE_TOKEN";

type CommandResult = { status: number | null; stdout: string; stderr: string };

function command(
  binary: string,
  args: string[],
  home: string,
  input: string[],
  environment: Record<string, string> = {},
): CommandResult {
  const result = spawnSync(binary, args, {
    cwd: ROOT,
    env: { ...process.env, LEPIDY_HOME: home, ...environment },
    input: `${input.join("\n")}\n`,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function waitFor(output: () => string, needle: string, timeoutMs = 20_000): Promise<string> {
  return expect
    .poll(output, { timeout: timeoutMs, message: `waiting for ${JSON.stringify(needle)}` })
    .toContain(needle)
    .then(() => output());
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/**
 * G01's release gate, against the built Worker and the compiled native tools.
 *
 * The browser is the approval device. The separate CLI profile is the runner
 * device. The barrier is local launch configuration: it lets the gate observe
 * a process start on the mention while holding the agent reply until the real
 * injector has received an answer. No credential, passphrase, executable or
 * argument is supplied by the workspace.
 */
test("GATE-INT-001 completes the two-device approved runner journey and stops it", async ({ page }) => {
  test.setTimeout(120_000);
  for (const binary of [LEPIDY, AGENTD, HARNESS]) {
    expect(existsSync(binary), `${binary} must be built by the browser test command`).toBe(true);
  }

  const home = mkdtempSync(path.join(tmpdir(), "lepidy-g01-"));
  const marker = path.join(home, "credential-used");
  const running = path.join(home, "barrier-running");
  const barrier = path.join(home, "barrier.mjs");
  const probe = path.join(home, "injection-probe.mjs");
  let daemon: ChildProcessWithoutNullStreams | null = null;
  let daemonOutput = "";

  try {
    const account = freshAccount();
    await signUp(page, account, LOCALHOST_BASE);
    const session = (await page.context().cookies()).find((cookie) => cookie.name === "lepidy_session");
    expect(session).toBeDefined();

    const login = command(
      LEPIDY,
      ["login", "--server", LOCALHOST_BASE, "--workspace", slugFor(account), "--label", "G01 runner", "--project", "cli-project", "--kind", "runner"],
      home,
      [account.email, account.password, PASSPHRASE],
    );
    expect(login.status, login.stderr).toBe(0);
    expect(`${login.stdout}${login.stderr}`).not.toContain(account.password);
    expect(`${login.stdout}${login.stderr}`).not.toContain(PASSPHRASE);

    const added = command(
      LEPIDY,
      ["add", CREDENTIAL, "--mode", "ask", "--delivery", "inject", "--policy-project", "cli-project", "--high-risk"],
      home,
      [PASSPHRASE, account.password, CANARY],
    );
    expect(added.status, added.stderr).toBe(0);
    expect(`${added.stdout}${added.stderr}`).not.toContain(CANARY);
    const credentialId = added.stdout.match(/Added GATE_TOKEN as ([^.]+)\./)?.[1];
    expect(credentialId).toBeDefined();

    const seededResponse = await page.request.post(`${LOCALHOST_BASE}/__fixture/runner-queue`, {
      headers: { authorization: session!.value },
      data: { mentions: 0, credentialIds: [credentialId] },
    });
    expect(seededResponse.status()).toBe(200);
    const seeded = (await seededResponse.json()) as {
      agentId: string;
      agentHandle: string;
      channelId: string;
      delegationId: string;
    };

    // A local barrier process waits for the injected command's success marker,
    // then replaces itself with the real reference harness. Its pid is written
    // so the final stop can prove the process tree is gone.
    writeFileSync(
      barrier,
      `import { spawn } from "node:child_process";\nimport { existsSync, writeFileSync } from "node:fs";\nconst [marker, running, harness] = process.argv.slice(2);\nwriteFileSync(running, String(process.pid));\nwhile (!existsSync(marker)) await new Promise((resolve) => setTimeout(resolve, 25));\nconst child = spawn(harness, [], { env: process.env, stdio: "inherit" });\nchild.on("exit", (code) => process.exit(code ?? 1));\n`,
    );
    // The child proves it received the plaintext through its environment, then
    // tries to print it on both streams. The production CLI scrubber must keep
    // the recognizable canary out of everything the harness or gate records.
    writeFileSync(
      probe,
      `import { writeFileSync } from "node:fs";\nconst value = process.env.${CREDENTIAL};\nif (value !== ${JSON.stringify(CANARY)}) process.exit(9);\nprocess.stdout.write(value + "\\n");\nprocess.stderr.write(value + "\\n");\nwriteFileSync(process.argv[2], "used");\n`,
    );

    const preset = command(
      AGENTD,
      [
        "preset", "set", "g01", "--program", process.execPath,
        "--arg", barrier, "--arg", marker, "--arg", running, "--arg", HARNESS,
        "--cooldown", "0", "--timeout", "120",
      ],
      home,
      [PASSPHRASE],
    );
    expect(preset.status, preset.stderr).toBe(0);
    const registered = command(
      AGENTD,
      ["register", "--agent", `${seeded.agentId}=g01`],
      home,
      [PASSPHRASE],
    );
    expect(registered.status, registered.stderr).toBe(0);

    daemon = spawn(AGENTD, ["run", "--idle-check", "60"], {
      cwd: ROOT,
      env: { ...process.env, LEPIDY_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    daemon.stdout.on("data", (chunk) => (daemonOutput += String(chunk)));
    daemon.stderr.on("data", (chunk) => (daemonOutput += String(chunk)));
    daemon.stdin.write(`${PASSPHRASE}\n`);
    await waitFor(() => daemonOutput, "session ready");

    const enqueued = await page.request.post(`${LOCALHOST_BASE}/__fixture/runner-enqueue`, {
      headers: { authorization: session!.value },
      data: { channelId: seeded.channelId, agentHandle: seeded.agentHandle, count: 1 },
    });
    expect(enqueued.status()).toBe(200);
    const firstMessage = ((await enqueued.json()) as { messageIds: string[] }).messageIds[0];
    await waitFor(() => daemonOutput, "started work");
    await expect.poll(() => existsSync(running), { timeout: 20_000 }).toBe(true);

    const provenance = {
      LEPIDY_AGENT_ID: seeded.agentId,
      LEPIDY_DELEGATION_ID: seeded.delegationId,
      LEPIDY_ORIGIN_ID: firstMessage,
    };
    const injectionArgs = [
      "run", "--with", CREDENTIAL,
      "--origin-channel", seeded.channelId,
      "--origin-message", firstMessage,
      "--reason", "answer the G01 synthetic request",
      "--scrub", "always", "--", process.execPath, probe, marker,
    ];

    // No answer is a refusal: the process does not start while a card waits.
    const awaiting = command(LEPIDY, injectionArgs, home, [PASSPHRASE], provenance);
    expect(awaiting.status).toBe(78);
    expect(existsSync(marker)).toBe(false);
    expect(`${awaiting.stdout}${awaiting.stderr}`).not.toContain(CANARY);

    await page.goto(`${LOCALHOST_BASE}/inbox`);
    await page.getByRole("button", { name: "Deny" }).click();
    await expect(page.getByText("Nothing is waiting on you")).toBeVisible();
    expect(existsSync(marker)).toBe(false);

    // Asking again creates a fresh, bounded decision. This time the approval
    // device supplies a genuine user-verified WebAuthn assertion.
    const awaitingAgain = command(LEPIDY, injectionArgs, home, [PASSPHRASE], provenance);
    expect(awaitingAgain.status).toBe(78);
    await registerPasskey(page);
    await page.goto(`${LOCALHOST_BASE}/inbox`);
    await page.getByRole("button", { name: "Allow once" }).click();
    await expect(page.getByText("Nothing is waiting on you")).toBeVisible();

    const injected = command(LEPIDY, injectionArgs, home, [PASSPHRASE], provenance);
    expect(injected.status, injected.stderr).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("used");
    expect(`${injected.stdout}${injected.stderr}`).toContain("[redacted:GATE_TOKEN]");
    expect(`${injected.stdout}${injected.stderr}`).not.toContain(CANARY);
    await waitFor(() => daemonOutput, "finished with status 0 (completed)");

    // The reply is attached to the mention's thread, not posted as another
    // room-root message. The browser sees the resulting thread count.
    await page.goto(`${LOCALHOST_BASE}/c/${seeded.channelId}`);
    await expect(page.locator(".messages > li").filter({ hasText: `@${seeded.agentHandle}` })).toContainText("1 reply");
    expect(await page.content()).not.toContain(CANARY);

    // A second mention costs another harness process, but not another scoped
    // session. The daemon says "session ready" exactly once across both runs.
    const second = await page.request.post(`${LOCALHOST_BASE}/__fixture/runner-enqueue`, {
      headers: { authorization: session!.value },
      data: { channelId: seeded.channelId, agentHandle: seeded.agentHandle, count: 1 },
    });
    expect(second.status()).toBe(200);
    await waitFor(() => daemonOutput, "finished with status 0 (completed)", 20_000);
    await expect.poll(() => count(daemonOutput, "finished with status 0 (completed)"), { timeout: 20_000 }).toBe(2);
    expect(count(daemonOutput, "session ready")).toBe(1);

    // Hold a third process in the barrier, then revoke from the browser device.
    // Stop has no confirmation and kills the whole local process group.
    rmSync(marker);
    rmSync(running);
    const third = await page.request.post(`${LOCALHOST_BASE}/__fixture/runner-enqueue`, {
      headers: { authorization: session!.value },
      data: { channelId: seeded.channelId, agentHandle: seeded.agentHandle, count: 1 },
    });
    expect(third.status()).toBe(200);
    await expect.poll(() => existsSync(running), { timeout: 20_000 }).toBe(true);
    const barrierPid = Number(readFileSync(running, "utf8"));

    const stopped = await page.request.post(`${LOCALHOST_BASE}/__fixture/runner-revoke`, {
      headers: { authorization: session!.value },
      data: { delegationId: seeded.delegationId },
    });
    expect(stopped.status()).toBe(200);
    await waitFor(() => daemonOutput, "stopped");
    await expect.poll(() => {
      try {
        process.kill(barrierPid, 0);
        return false;
      } catch {
        return true;
      }
    }, { timeout: 20_000 }).toBe(true);

    const stored = `${readFileSync(path.join(home, "profile.json"), "utf8")}\n${readFileSync(path.join(home, "presets.json"), "utf8")}`;
    expect(stored).not.toContain(CANARY);
    expect(stored).not.toContain(PASSPHRASE);
    expect(daemonOutput).not.toContain(CANARY);
    expect(daemonOutput).not.toContain(PASSPHRASE);
  } finally {
    if (existsSync(running)) {
      const pid = Number(readFileSync(running, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 0) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already stopped is the desired teardown state.
        }
      }
    }
    if (daemon !== null && daemon.exitCode === null) daemon.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  }
});
