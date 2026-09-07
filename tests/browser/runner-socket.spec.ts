import WebSocket from "ws";

import { expect, test } from "./harness";
import { freshAccount, signUp } from "./auth-helpers";
import { BASE, enrolDevice, signedHeaders, signedRequest, slugFor, type DeviceKeys, type Enrolment } from "./device-helpers";

/**
 * The runner's outbound socket, against the built Worker (R01).
 *
 * The object-level suite proves what the workspace decides; this proves that a
 * real machine can reach it. Everything here goes over real HTTP and a real
 * WebSocket handshake to the Worker under `wrangler dev`, with the same signed
 * device envelope the Rust daemon builds — because a socket that is easier to
 * open than the endpoints beside it is the weakest thing in the design, and the
 * only way to know it is not is to try.
 *
 * The scenario that matters most is `RUNNER-SOCKET-INT-002`: it opens the wake
 * frame the Worker actually sent and reads its keys. If a field for an
 * executable, an argument, a path, an environment or a permission posture ever
 * appears there, this fails.
 */

const SOCKET_PATH = "/api/device/runner/socket";
const PRESET = "preset-browser-default";

type Seeded = { agentId: string; agentHandle: string; channelId: string };

async function seedRunner(page: Parameters<typeof signUp>[0]) {
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
    label: "browser-runner",
  });
  return { account, session: session!.value, seeded, ...device };
}

/** Open the socket exactly as `lepidy-agentd` does. */
async function openSocket(input: {
  keys: DeviceKeys;
  enrolment: Enrolment;
  runnerEpoch: number;
  tamper?: "signature";
}): Promise<{ frames: Record<string, unknown>[]; socket: WebSocket; closed: Promise<number> }> {
  const headers = await signedHeaders({
    keys: input.keys,
    enrolment: input.enrolment,
    method: "GET",
    path: SOCKET_PATH,
    body: "",
    ...(input.tamper === undefined ? {} : { tamper: input.tamper }),
  });
  const socket = new WebSocket(`ws://127.0.0.1:3100${SOCKET_PATH}?runner_epoch=${input.runnerEpoch}`, { headers });
  const frames: Record<string, unknown>[] = [];
  socket.on("message", (data) => {
    frames.push(JSON.parse(String(data)) as Record<string, unknown>);
  });
  const closed = new Promise<number>((resolve) => {
    socket.on("close", (code) => resolve(code));
    socket.on("error", () => resolve(-1));
  });
  return { frames, socket, closed };
}

async function waitForFrame(
  frames: Record<string, unknown>[],
  type: string,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = frames.find((frame) => frame.type === type);
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no ${type} frame arrived; saw ${JSON.stringify(frames)}`);
}

async function register(
  page: Parameters<typeof signUp>[0],
  input: { keys: DeviceKeys; enrolment: Enrolment; agentId: string; runnerEpoch: number },
) {
  return signedRequest(page.request, {
    keys: input.keys,
    enrolment: input.enrolment,
    path: "/api/device/runner/register",
    body: { runnerEpoch: input.runnerEpoch, agents: [{ agentId: input.agentId, presetId: PRESET }] },
  });
}

test("RUNNER-SOCKET-INT-001 opens an outbound socket only for a registered device", async ({ page }) => {
  const { keys, enrolment, seeded } = await seedRunner(page);

  // A socket is not a registration. Before registering there is nothing for
  // this device to listen for, and the Worker says so rather than accepting a
  // connection that would sit there silently forever.
  const early = await openSocket({ keys, enrolment, runnerEpoch: 1 });
  expect(await early.closed).toBe(-1);

  const registered = await register(page, { keys, enrolment, agentId: seeded.agentId, runnerEpoch: 1 });
  expect(registered.status()).toBe(200);
  expect(await registered.json()).toMatchObject({ agentIds: [seeded.agentId], displacedDeviceIds: [] });

  const live = await openSocket({ keys, enrolment, runnerEpoch: 1 });
  const welcome = await waitForFrame(live.frames, "welcome");
  expect(welcome).toMatchObject({ deviceId: enrolment.deviceId, runnerEpoch: 1, agentIds: [seeded.agentId] });
  live.socket.close();
});

test("RUNNER-SOCKET-INT-002 sends a wake that names a preset and describes nothing", async ({ page }) => {
  const { keys, enrolment, seeded, session } = await seedRunner(page);
  expect((await register(page, { keys, enrolment, agentId: seeded.agentId, runnerEpoch: 1 })).status()).toBe(200);

  const live = await openSocket({ keys, enrolment, runnerEpoch: 1 });
  await waitForFrame(live.frames, "welcome");

  // A person mentions the agent in a room. Everything after this is the
  // product working: a message, a queue row, and a machine finding out.
  const mentioned = await page.request.post(`${BASE}/__fixture/runner-enqueue`, {
    headers: { authorization: session },
    data: { channelId: seeded.channelId, agentHandle: seeded.agentHandle, count: 1 },
  });
  expect(mentioned.status()).toBe(200);

  const wake = await waitForFrame(live.frames, "wake");
  const trigger = wake.trigger as Record<string, unknown>;
  // Exactly the six keys of the D05a schema. This is the assertion the whole
  // "the cloud never says what to run" promise rests on at the wire.
  expect(Object.keys(trigger).sort()).toEqual([
    "agentId",
    "configRevision",
    "deviceId",
    "presetId",
    "requestId",
    "workspaceId",
  ]);
  expect(trigger).toMatchObject({ agentId: seeded.agentId, deviceId: enrolment.deviceId, presetId: PRESET });
  // And the frame as a whole carries nothing that could be an instruction.
  const serialised = JSON.stringify(wake).toLowerCase();
  for (const forbidden of ["command", "argv", "\"args\"", "cwd", "\"env\"", "permission", "executable", "bash", "sh -c"]) {
    expect(serialised, `the wake carried ${forbidden}`).not.toContain(forbidden);
  }
  live.socket.close();
});

test("RUNNER-SOCKET-INT-003 hands a reconnecting runner the wake it missed", async ({ page }) => {
  const { keys, enrolment, seeded, session } = await seedRunner(page);
  expect((await register(page, { keys, enrolment, agentId: seeded.agentId, runnerEpoch: 1 })).status()).toBe(200);

  // Work arrives while the machine is off. The wake commits with the queue row,
  // so nothing depends on a delivery that was never attempted.
  const mentioned = await page.request.post(`${BASE}/__fixture/runner-enqueue`, {
    headers: { authorization: session },
    data: { channelId: seeded.channelId, agentHandle: seeded.agentHandle, count: 2 },
  });
  expect(mentioned.status()).toBe(200);

  const live = await openSocket({ keys, enrolment, runnerEpoch: 1 });
  const wake = await waitForFrame(live.frames, "wake");
  expect((wake.trigger as Record<string, unknown>).agentId).toBe(seeded.agentId);

  // And asking directly agrees with what the socket said, which is the other
  // half of the design: the wake is a hint, the depth is the answer.
  const depth = await signedRequest(page.request, {
    keys,
    enrolment,
    path: "/api/device/runner/depth",
    body: {},
  });
  expect(depth.status()).toBe(200);
  const body = (await depth.json()) as { agents: { agentId: string; depth: number; presetId: string }[] };
  expect(body.agents).toEqual([
    expect.objectContaining({ agentId: seeded.agentId, presetId: PRESET, depth: 2 }),
  ]);
  live.socket.close();
});

test("RUNNER-SOCKET-INT-004 refuses an unsigned upgrade and a stale epoch", async ({ page }) => {
  const { keys, enrolment, seeded } = await seedRunner(page);
  expect((await register(page, { keys, enrolment, agentId: seeded.agentId, runnerEpoch: 2 })).status()).toBe(200);

  // No envelope at all: this is the connection anybody on the network could
  // make, and it must not become a way to receive another member's wakes.
  const bare = new WebSocket(`ws://127.0.0.1:3100${SOCKET_PATH}?runner_epoch=2`);
  await new Promise<void>((resolve) => {
    bare.on("error", () => resolve());
    bare.on("close", () => resolve());
  });

  // A signature that does not verify.
  const tampered = await openSocket({ keys, enrolment, runnerEpoch: 2, tamper: "signature" });
  expect(await tampered.closed).toBe(-1);

  // A process whose registration has been superseded — the older daemon after a
  // restart, which must not be left racing the newer one for the same queue.
  const stale = await openSocket({ keys, enrolment, runnerEpoch: 1 });
  expect(await stale.closed).toBe(-1);

  const live = await openSocket({ keys, enrolment, runnerEpoch: 2 });
  await waitForFrame(live.frames, "welcome");
  live.socket.close();
});

test("RUNNER-SOCKET-INT-005 stops a runner from anywhere, with the machine still connected", async ({ page }) => {
  const { keys, enrolment, seeded } = await seedRunner(page);
  expect((await register(page, { keys, enrolment, agentId: seeded.agentId, runnerEpoch: 1 })).status()).toBe(200);
  const live = await openSocket({ keys, enrolment, runnerEpoch: 1 });
  await waitForFrame(live.frames, "welcome");

  // Standing the machine down. The rows go away whether or not anything is
  // listening, and the socket that was open is closed rather than left to
  // receive wakes for agents this device no longer answers for.
  const released = await signedRequest(page.request, {
    keys,
    enrolment,
    path: "/api/device/runner/release",
    body: { reason: "browser-scenario" },
  });
  expect(released.status()).toBe(200);
  expect(await released.json()).toMatchObject({ released: 1 });

  const stop = await waitForFrame(live.frames, "stop");
  expect(stop).toMatchObject({ agentId: seeded.agentId, reason: "browser-scenario" });
  expect(await live.closed).toBeGreaterThan(0);

  // And a released device cannot simply reconnect: standing down is durable,
  // not a frame the machine could choose to ignore.
  const again = await openSocket({ keys, enrolment, runnerEpoch: 1 });
  expect(await again.closed).toBe(-1);

  const depth = await signedRequest(page.request, { keys, enrolment, path: "/api/device/runner/depth", body: {} });
  expect(depth.status()).toBe(409);
});
