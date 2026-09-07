import { type APIRequestContext } from "@playwright/test";
import { expect, test } from "./harness";

import { freshAccount, signUp } from "./auth-helpers";

/**
 * The waiting spike (D03).
 *
 * The question this answers is not "does the queue work" — A03 proved that
 * against the object. It is whether a harness can be given repeated work in one
 * session *without* the workspace holding a request open for it, and what that
 * costs. The tempting design is a parked `agent_next` that blocks until work
 * arrives: one line in a client, and a Durable Object request held for ten
 * minutes per idle agent, on a product whose free tier is "unlimited agents".
 *
 * So every call here is bounded and answered now, waiting happens on the
 * runner's own clock, and a wake that never arrives costs one extra call rather
 * than a permanently open one. These scenarios drive the built Worker over real
 * HTTP and record how long each call actually took, because "bounded" is a
 * claim about time and has to be measured to mean anything.
 */

const BASE = "http://127.0.0.1:3100";

/**
 * A generous ceiling, not a latency target. It is here to fail loudly if a call
 * ever starts blocking — a parked wait would be seconds or minutes, not this.
 */
const BOUNDED_CALL_MS = 5_000;

function slugFor(account: ReturnType<typeof freshAccount>): string {
  return account.workspaceName.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-");
}

type Seeded = {
  token: string;
  sessionId: string;
  delegationId: string;
  agentId: string;
  agentHandle: string;
  channelId: string;
  messageIds: string[];
};

type Measured<T> = { value: T; ms: number };

async function measure<T>(work: () => Promise<T>): Promise<Measured<T>> {
  const started = Date.now();
  const value = await work();
  return { value, ms: Date.now() - started };
}

async function callTool(
  request: APIRequestContext,
  input: { slug: string; token: string; id: number; name: string; arguments?: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  const response = await request.post(`${BASE}/w/${input.slug}/mcp`, {
    headers: { authorization: `Bearer ${input.token}` },
    data: {
      jsonrpc: "2.0",
      id: input.id,
      method: "tools/call",
      params: { name: input.name, arguments: input.arguments ?? {} },
    },
  });
  // A dead session is refused at the transport, before there is a tool result
  // to read, so the status is part of the answer rather than an assertion.
  if (response.status() !== 200) {
    return { status: response.status(), refused: true, isError: true, text: await response.text() };
  }
  const body = (await response.json()) as {
    error?: { message?: string };
    result?: { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { text: string }[] };
  };
  // A protocol-level error is a different failure from a tool saying no, and
  // conflating them would hide a broken call behind an expected refusal.
  if (body.result === undefined) {
    throw new Error(`${input.name} was refused at the protocol level: ${JSON.stringify(body.error ?? body)}`);
  }
  return {
    status: 200,
    refused: body.result.isError === true,
    isError: body.result.isError === true,
    ...(body.result.structuredContent ?? {}),
    text: body.result.content?.[0]?.text ?? "",
  };
}

async function seedRunner(page: Parameters<typeof signUp>[0], mentions: number) {
  const account = freshAccount();
  await signUp(page, account);
  const session = (await page.context().cookies()).find((cookie) => cookie.name === "lepidy_session");
  const seeded = (await (
    await page.request.post(`${BASE}/__fixture/runner-queue`, {
      headers: { authorization: session!.value },
      data: { mentions },
    })
  ).json()) as Seeded;
  return { account, slug: slugFor(account), sessionValue: session!.value, seeded };
}

/** One turn of the loop a runner drives: claim, start, answer, complete. */
async function drainOne(
  request: APIRequestContext,
  input: { slug: string; seeded: Seeded; turn: number },
): Promise<{ item: Record<string, unknown> | null; calls: number[] }> {
  const calls: number[] = [];
  // The lease token is the caller's own secret: the workspace stores only its
  // digest, so the same token has to be presented again on every later call.
  const leaseToken = `spike-lease-${input.turn}-${Date.now()}-${"x".repeat(40)}`;
  const claimed = await measure(() =>
    callTool(request, {
      slug: input.slug,
      token: input.seeded.token,
      id: 1000 + input.turn * 10,
      name: "agent_next",
      arguments: {
        agent: input.seeded.agentId,
        claim_id: `spike-claim-${input.turn}-${Date.now()}`,
        lease_token: leaseToken,
        session_id: input.seeded.sessionId,
      },
    }),
  );
  calls.push(claimed.ms);
  const item = (claimed.value.item ?? null) as Record<string, unknown> | null;
  if (item === null) return { item: null, calls };

  const lease = claimed.value.lease as { leaseGeneration: number };
  const proof = {
    agent: input.seeded.agentId,
    item_id: item.item_id as string,
    lease_generation: lease.leaseGeneration,
    lease_token: leaseToken,
    session_id: input.seeded.sessionId,
  };

  const started = await measure(() =>
    callTool(request, { slug: input.slug, token: input.seeded.token, id: 1001 + input.turn * 10, name: "agent_start", arguments: proof }),
  );
  calls.push(started.ms);
  const posted = await measure(() =>
    callTool(request, {
      slug: input.slug,
      token: input.seeded.token,
      id: 1002 + input.turn * 10,
      name: "agent_post",
      arguments: {
        agent: input.seeded.agentId,
        channel_id: input.seeded.channelId,
        content: `Answered turn ${input.turn}.`,
        idempotency_key: `spike-post-${input.turn}-${Date.now()}`,
      },
    }),
  );
  calls.push(posted.ms);
  const completed = await measure(() =>
    callTool(request, {
      slug: input.slug,
      token: input.seeded.token,
      id: 1003 + input.turn * 10,
      name: "agent_complete",
      arguments: {
        ...proof,
        completion_id: `spike-completion-${input.turn}-${Date.now()}`,
        output_digest: `digest-${input.turn}`,
      },
    }),
  );
  calls.push(completed.ms);
  return { item, calls };
}

test("MCP-WAIT-INT-001 drains repeated work in one session with every call answered now", async ({ page }) => {
  const { slug, seeded } = await seedRunner(page, 3);

  // Three separate pieces of work, one session, one set of credentials: the
  // reuse a runner depends on, without anything being held open between them.
  const calls: number[] = [];
  const answered: string[] = [];
  for (let turn = 0; turn < 3; turn += 1) {
    const drained = await drainOne(page.request, { slug, seeded, turn });
    expect(drained.item, `turn ${turn} found no work`).not.toBeNull();
    answered.push(drained.item!.item_id as string);
    calls.push(...drained.calls);
  }
  expect(new Set(answered).size).toBe(3);

  // The queue is empty now, and this is the measurement the whole decision
  // rests on: asking an empty queue answers immediately rather than parking.
  const empty = await measure(() =>
    callTool(page.request, {
      slug,
      token: seeded.token,
      id: 2000,
      name: "agent_next",
      arguments: {
        agent: seeded.agentId,
        claim_id: `spike-empty-${Date.now()}`,
        lease_token: `spike-empty-lease-${"x".repeat(40)}`,
        session_id: seeded.sessionId,
      },
    }),
  );
  expect(empty.value.item).toBeNull();
  expect(empty.ms).toBeLessThan(BOUNDED_CALL_MS);

  calls.push(empty.ms);
  const slowest = Math.max(...calls);
  // Every call the harness made was bounded. A parked wait would show up here
  // as one call orders of magnitude longer than the rest.
  expect(slowest).toBeLessThan(BOUNDED_CALL_MS);
  // eslint-disable-next-line no-console -- the measurement is the point of a spike
  console.log(
    `MCP-WAIT-INT-001 calls=${calls.length} slowest=${slowest}ms empty_queue=${empty.ms}ms total=${calls.reduce((sum, ms) => sum + ms, 0)}ms`,
  );
});

test("MCP-WAIT-INT-002 costs one bounded call to recover from a wake that never arrived", async ({ page }) => {
  const { slug, sessionValue, seeded } = await seedRunner(page, 1);
  await drainOne(page.request, { slug, seeded, turn: 0 });

  // The session is idle. Nothing is parked, so the workspace is serving nothing
  // at all for this agent — the harness is waiting on its own clock.
  const idleFrom = Date.now();
  await page.waitForTimeout(1_500);
  const idleMs = Date.now() - idleFrom;

  // Work arrives while nobody is listening: the lost-wake case.
  const enqueued = await page.request.post(`${BASE}/__fixture/runner-enqueue`, {
    headers: { authorization: sessionValue },
    data: { channelId: seeded.channelId, agentHandle: seeded.agentHandle, count: 1 },
  });
  expect(enqueued.status()).toBe(200);

  // One bounded call on reconnect finds it. That is the whole cost of losing a
  // wake, and it is why the design does not need a request held open to avoid
  // losing one.
  const recovered = await measure(() =>
    callTool(page.request, {
      slug,
      token: seeded.token,
      id: 3000,
      name: "agent_next",
      arguments: {
        agent: seeded.agentId,
        claim_id: `spike-recover-${Date.now()}`,
        lease_token: `spike-recover-lease-${"x".repeat(40)}`,
        session_id: seeded.sessionId,
      },
    }),
  );
  expect(recovered.value.item).not.toBeNull();
  expect(recovered.ms).toBeLessThan(BOUNDED_CALL_MS);
  // eslint-disable-next-line no-console -- the measurement is the point of a spike
  console.log(`MCP-WAIT-INT-002 idle=${idleMs}ms recovery_call=${recovered.ms}ms`);
});

test("MCP-WAIT-INT-003 tells a live session it has been stopped, within one call", async ({ page }) => {
  const { slug, sessionValue, seeded } = await seedRunner(page, 2);
  const first = await drainOne(page.request, { slug, seeded, turn: 0 });
  expect(first.item).not.toBeNull();

  // Cancellation, as a person would do it: the delegation the session runs
  // under is revoked while the session is alive and has work left.
  const revoked = await page.request.post(`${BASE}/__fixture/runner-revoke`, {
    headers: { authorization: sessionValue },
    data: { delegationId: seeded.delegationId },
  });
  expect(revoked.status()).toBe(200);

  // The next bounded call refuses rather than hanging, so a harness learns it
  // has been stopped at its next turn instead of sitting in a parked request
  // that nobody can interrupt.
  const afterStop = await measure(() =>
    callTool(page.request, {
      slug,
      token: seeded.token,
      id: 4000,
      name: "agent_next",
      arguments: {
        agent: seeded.agentId,
        claim_id: `spike-stopped-${Date.now()}`,
        lease_token: `spike-stopped-lease-${"x".repeat(40)}`,
        session_id: seeded.sessionId,
      },
    }),
  );
  // Refused, whether the transport rejects the dead session or the tool does.
  // Either way the harness has its answer inside one bounded call rather than
  // sitting in a parked request nobody can interrupt.
  expect(afterStop.value.refused).toBe(true);
  expect(afterStop.ms).toBeLessThan(BOUNDED_CALL_MS);

  // And it stays stopped: a second attempt is refused the same way rather than
  // finding the work that is still queued.
  const again = await callTool(page.request, {
    slug,
    token: seeded.token,
    id: 4001,
    name: "agent_next",
    arguments: {
      agent: seeded.agentId,
      claim_id: `spike-stopped-again-${Date.now()}`,
      lease_token: `spike-stopped-again-lease-${"x".repeat(40)}`,
      session_id: seeded.sessionId,
    },
  });
  expect(again.refused).toBe(true);
  // eslint-disable-next-line no-console -- the measurement is the point of a spike
  console.log(`MCP-WAIT-INT-003 stop_observed_in=${afterStop.ms}ms status=${String(afterStop.value.status)}`);
});
