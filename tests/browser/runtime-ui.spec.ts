import AxeBuilder from "@axe-core/playwright";

import { blockPrefetch, expect, test } from "./harness";
import { freshAccount, signUp } from "./auth-helpers";
import { BASE, enrolDevice, signedRequest, slugFor, type DeviceKeys, type Enrolment } from "./device-helpers";

/**
 * The runtime configuration screen, driven against the built Worker (R05).
 *
 * This is the page where a person decides who may cause a process to start on
 * their own computer, so what is tested is both halves of that: that the
 * controls work, and that the page cannot do the one thing it must never do.
 *
 * `RUNTIME-UI-INT-002` is the scenario that matters most. It renders the local
 * runtime with a real registered machine and then goes looking for a launch
 * editor — a field for a program, an argument, a directory, an environment
 * value or a limit, or a button that would reset or replace a preset. If one
 * ever appears, it fails.
 */

const PRESET = "api-worktree";

type Seeded = { agentId: string; agentHandle: string; channelId: string; delegationId: string };

async function seedRuntime(page: Parameters<typeof signUp>[0]) {
  const account = freshAccount();
  await signUp(page, account);
  const session = (await page.context().cookies()).find((cookie) => cookie.name === "lepidy_session");
  const seeded = (await (
    await page.request.post(`${BASE}/__fixture/runner-queue`, {
      headers: { authorization: session!.value },
      data: { mentions: 0 },
    })
  ).json()) as Seeded;
  const device = await enrolDevice(page, {
    email: account.email,
    password: account.password,
    workspaceSlug: slugFor(account),
    label: "browser-runtime-runner",
  });
  return { account, session: session!.value, seeded, ...device };
}

/** Register the way `lepidy-agentd register` does, at a chosen revision. */
async function register(
  page: Parameters<typeof signUp>[0],
  input: { keys: DeviceKeys; enrolment: Enrolment; agentId: string; runnerEpoch: number; configRevision: number },
) {
  const response = await signedRequest(page.request, {
    keys: input.keys,
    enrolment: input.enrolment,
    path: "/api/device/runner/register",
    body: { runnerEpoch: input.runnerEpoch, agents: [{ agentId: input.agentId, presetId: PRESET }] },
    configRevision: input.configRevision,
  });
  expect(response.status()).toBe(200);
  return response;
}

async function openRuntime(page: Parameters<typeof signUp>[0], agentId: string) {
  await page.goto(`${BASE}/agents/${agentId}/runtime`);
  await expect(page.getByRole("heading", { name: "How this agent runs" })).toBeVisible();
}

test("RUNTIME-UI-INT-001 states where an agent's authority comes from, and lets an owner change it", async ({ page }) => {
  const { seeded } = await seedRuntime(page);
  await openRuntime(page, seeded.agentId);

  // All four runtimes are on the page, divided by the question that decides
  // where authority comes from rather than by where the model runs.
  for (const name of ["Connected", "Local session", "Claude Cloud", "Custom"]) {
    await expect(page.getByText(name, { exact: true })).toBeVisible();
  }
  await expect(page.getByText("A person is at the keyboard", { exact: true })).toBeVisible();
  await expect(page.getByText("Nobody is at the keyboard", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Lepidy never runs the loop.")).toBeVisible();

  // Nothing has been chosen, so it reads as connected and says how to use it.
  await expect(page.getByRole("heading", { name: "Nothing to configure" })).toBeVisible();
  await expect(page.getByText(/claude mcp add lepidy/)).toBeVisible();

  // The delegation, restated as one sentence somebody could repeat out loud.
  await expect(page.getByRole("heading", { name: "Where its authority comes from" })).toBeVisible();
  await expect(page.getByText(/Runs as whichever owner has an MCP client open/)).toBeVisible();

  await page.getByRole("radio", { name: /Local session/ }).check();
  await page.getByRole("button", { name: "Use this runtime" }).click();

  await expect(page.getByText("This agent now runs on a machine you own.")).toBeVisible();
  // With no machine registered, the page says so plainly and says why it cannot
  // be fixed from here.
  await expect(page.getByRole("heading", { name: /No machine answers for/ })).toBeVisible();
  await expect(page.getByText(/It cannot be done from here/)).toBeVisible();

  // And the sentence is now the real delegation.
  await expect(page.getByText(/^Runs as @/)).toBeVisible();
  await expect(page.getByText(/May use no credential\./)).toBeVisible();
});

test("RUNTIME-UI-INT-002 shows a real machine and offers no way to edit what it runs", async ({ page }) => {
  const { seeded, keys, enrolment } = await seedRuntime(page);
  await register(page, { keys, enrolment, agentId: seeded.agentId, runnerEpoch: 1, configRevision: 14 });
  await openRuntime(page, seeded.agentId);
  await page.getByRole("radio", { name: /Local session/ }).check();
  await page.getByRole("button", { name: "Use this runtime" }).click();

  await expect(page.getByRole("heading", { name: "Where it runs" })).toBeVisible();
  // The name somebody gave the machine, beside the id a wake is addressed to.
  await expect(page.getByText("browser-runtime-runner").first()).toBeVisible();
  await expect(page.getByText(enrolment.deviceId).first()).toBeVisible();
  // The preset appears as the opaque name and revision the machine reported,
  // which is the whole of what the cloud is allowed to know about it.
  await expect(page.getByText(PRESET)).toBeVisible();
  await expect(page.getByText("revision 14").first()).toBeVisible();
  await expect(page.getByText(/Stored only on/)).toBeVisible();
  await expect(page.getByText(/unavailable to remote clients/)).toBeVisible();
  await expect(page.getByText(/can never send or edit a command/)).toBeVisible();

  // The security assertion. Not one of these exists on this page, under any
  // name a launch editor could plausibly use.
  for (const forbidden of [
    /program/i, /executable/i, /^script$/i, /^command$/i, /argument/i, /working directory/i,
    /environment variable/i, /permission mode/i, /max concurrent/i, /cooldown/i, /timeout/i,
  ]) {
    await expect(page.getByLabel(forbidden)).toHaveCount(0);
  }
  for (const forbidden of [/^Edit$/, /Reset to preset/i, /Replace preset/i, /Edit launch/i]) {
    await expect(page.getByRole("button", { name: forbidden })).toHaveCount(0);
  }
  // And the rendered page never carries a path or a command anywhere in it.
  const content = await page.content();
  for (const canary of ["/bin/sh", "cmd.exe", "acceptEdits", "--dangerously"]) {
    expect(content).not.toContain(canary);
  }

  // The consequence is stated rather than buried.
  await expect(page.getByRole("heading", { name: "What this actually allows" })).toBeVisible();
  await expect(page.getByText(/It does not sandbox what the harness does once it is running/)).toBeVisible();
});

test("RUNTIME-UI-INT-003 keeps a local change pending until that machine confirms it", async ({ page }) => {
  const { seeded, keys, enrolment } = await seedRuntime(page);
  await register(page, { keys, enrolment, agentId: seeded.agentId, runnerEpoch: 1, configRevision: 7 });
  await openRuntime(page, seeded.agentId);
  await page.getByRole("radio", { name: /Local session/ }).check();
  await page.getByRole("button", { name: "Use this runtime" }).click();

  await expect(page.getByRole("heading", { name: "Changes only that machine can make" })).toBeVisible();
  await expect(page.getByText("Nothing is pending on that machine.")).toBeVisible();

  await page.getByLabel("Ask that machine to").selectOption("approve_agent");
  await page.getByRole("button", { name: "Send the request" }).click();

  await expect(page.getByText("Asked. It stays pending until that machine confirms it.")).toBeVisible();
  await expect(page.getByText("Pending on the machine.")).toBeVisible();
  await expect(page.getByText("Asked by @", { exact: false })).toBeVisible();

  // The machine reconnecting at the same revision confirms nothing. This is the
  // case the pending state exists for.
  await register(page, { keys, enrolment, agentId: seeded.agentId, runnerEpoch: 2, configRevision: 7 });
  await page.reload();
  await expect(page.getByText("Pending on the machine.")).toBeVisible();

  // A revision that has moved on is the machine saying somebody did the work
  // in front of the operating system's own verification prompt.
  await register(page, { keys, enrolment, agentId: seeded.agentId, runnerEpoch: 3, configRevision: 8 });
  await page.reload();
  await expect(page.getByText("Pending on the machine.")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Confirmed by the machine" })).toBeVisible();
  await expect(page.getByText(/Confirmed at revision 8/)).toBeVisible();
});

test("RUNTIME-UI-INT-004 stops what is running, and shows nothing at all to a non-owner", async ({ page, browser }) => {
  const { seeded, keys, enrolment } = await seedRuntime(page);
  await register(page, { keys, enrolment, agentId: seeded.agentId, runnerEpoch: 1, configRevision: 1 });
  await openRuntime(page, seeded.agentId);
  await page.getByRole("radio", { name: /Local session/ }).check();
  await page.getByRole("button", { name: "Use this runtime" }).click();

  // The fixture starts this agent with a live session, so there is something to
  // stop rather than a button that only claims to work.
  await expect(page.getByRole("heading", { name: "Recent sessions" })).toBeVisible();
  await expect(page.getByText("live now")).toBeVisible();

  await page.getByRole("button", { name: "Stop everything" }).click();
  await expect(page.getByText("Stopped 1 session.")).toBeVisible();
  await expect(page.getByText("live now")).toHaveCount(0);

  // Who may start one is a cloud decision, and it saves.
  await page.getByLabel("Who may start it").selectOption("owners");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();

  // A different, fully valid account in a different workspace is shown nothing
  // — not a partial page, not a forbidden message that confirms the agent.
  const context = await browser.newContext();
  // A context built by hand does not get the fixture's prefetch block, and an
  // abandoned Next prefetch is what takes the dev server down mid-suite.
  await blockPrefetch(context);
  const stranger = await context.newPage();
  try {
    await stranger.goto(`${BASE}/signin`);
    await signUp(stranger, freshAccount());
    await stranger.goto(`${BASE}/agents/${seeded.agentId}/runtime`);
    await expect(stranger.getByRole("heading", { name: "Runtime not available" })).toBeVisible();
    await expect(stranger.getByText(/Only an owner of the agent can see or change this/)).toBeVisible();
    await expect(stranger.getByRole("heading", { name: "How this agent runs" })).toHaveCount(0);
    expect(await stranger.content()).not.toContain(PRESET);
  } finally {
    // Let what is still in the air finish before the context is torn down, for
    // the same reason the fixture does it.
    await stranger.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    await context.close();
  }
});

test("RUNTIME-UI-INT-005 DESKTOP-INT survives a keyboard, dark mode and an accessibility scan", async ({ page }) => {
  const { seeded, keys, enrolment } = await seedRuntime(page);
  await register(page, { keys, enrolment, agentId: seeded.agentId, runnerEpoch: 1, configRevision: 3 });
  await openRuntime(page, seeded.agentId);
  await page.getByRole("radio", { name: /Local session/ }).check();
  await page.getByRole("button", { name: "Use this runtime" }).click();
  await expect(page.getByRole("heading", { name: "Where it runs" })).toBeVisible();

  // The radio group is a real one, so the arrow keys move through it and the
  // page is usable without a pointer.
  await page.getByRole("radio", { name: /Connected/ }).focus();
  await expect(page.getByRole("radio", { name: /Connected/ })).toBeFocused();

  const scan = async (label: string) => {
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(results.violations, `${label}: ${JSON.stringify(results.violations, null, 2)}`).toEqual([]);
  };
  await scan("light");

  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await expect(page.getByRole("heading", { name: "Where it runs" })).toBeVisible();
  await scan("dark");
});

test("RUNTIME-UI-INT-006 offers the cloud and custom runtimes without pretending they are configured", async ({ page }) => {
  const { seeded } = await seedRuntime(page);
  await openRuntime(page, seeded.agentId);

  // They are not radio choices, because a runtime is not chosen until the thing
  // it points at has been proved to exist.
  await expect(page.getByRole("radio", { name: /Claude Cloud/ })).toBeDisabled();
  await expect(page.getByRole("radio", { name: /Custom/ })).toBeDisabled();

  await page.getByText("Set up Claude Cloud or a custom webhook instead").click();
  await expect(page.getByRole("heading", { name: "Connection" })).toBeVisible();
  await expect(page.getByText(/no Anthropic API key is accepted/)).toBeVisible();
  await expect(page.getByText(/hooks\/anthropic/)).toBeVisible();
  await expect(page.getByText(/shown there exactly once/)).toBeVisible();

  // The two scheduling facts that otherwise become support tickets.
  await expect(page.getByText(/spread out by up to nine minutes/)).toBeVisible();
  await expect(page.getByText(/a time that does not exist on the spring-forward day is skipped/)).toBeVisible();
  await expect(page.getByText(/Works even while a deployment is paused/)).toBeVisible();

  // A budget somebody typed wrongly is refused rather than rounded.
  await page.getByLabel("Cap per run").fill("5.005");
  await page.getByRole("button", { name: "Save the connection" }).click();
  await expect(page.getByText("Give the cap in dollars, like 5 or 5.00.")).toBeVisible();

  // The custom runtime states its boundary before it asks for anything.
  await expect(page.getByRole("heading", { name: "Your webhook" })).toBeVisible();
  await expect(page.getByText(/The wake it receives is metadata only/)).toBeVisible();
  await expect(page.getByText(/An address that resolves to a private/)).toBeVisible();
  await page.getByRole("textbox", { name: /^Signing secret/ }).fill("too-short");
  await page.getByLabel("Endpoint", { exact: true }).fill("https://hooks.example.test/lepidy");
  await page.getByRole("button", { name: "Connect and send a test wake" }).click();
  await expect(page.getByText("The signing secret needs at least 32 characters.")).toBeVisible();
});
