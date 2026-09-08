import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Actor, Workspace } from "../src/cloudflare/workspace";

/**
 * The designated runner (R01).
 *
 * What is being proved here is not that a socket can carry a message. It is
 * that the workspace can tell exactly one machine there is work, that it can
 * tell it to stop, and that neither of those is ever the thing the machine
 * relies on: a wake commits with the work it announces, an undelivered wake is
 * collected on reconnect, and a stop is a durable refusal with a frame as a
 * courtesy on top.
 *
 * The invariant that runs through all of it is D05a's: the workspace may *name*
 * a preset the machine already holds and may never describe one. Every frame
 * that leaves here is checked against that schema, and one scenario below opens
 * a wake frame and reads its keys to make sure.
 */

const NOW = 1_800_000_000_000;
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
    actor: owner, idempotencyKey: `${slug}:room`, kind: "public", slug: "general", memberIds: [other.memberId], now: NOW,
  });
  const agent = await stub.createAgent({ actor: owner, idempotencyKey: `${slug}:agent`, handle: "runner", now: NOW });
  const second = await stub.createAgent({ actor: owner, idempotencyKey: `${slug}:agent2`, handle: "second", now: NOW });
  const foreign = await stub.createAgent({ actor: other, idempotencyKey: `${slug}:agent3`, handle: "theirs", now: NOW });
  return { stub, slug, owner, other, room: room.channelId, agent: agent.agentId, second: second.agentId, foreign: foreign.agentId };
}

/** Mention the agent in a room, which is what puts work on its queue. */
async function mention(seeded: Awaited<ReturnType<typeof seed>>, body: string, at: number) {
  return seeded.stub.sendMessage({
    actor: seeded.owner,
    idempotencyKey: `${seeded.slug}:msg:${at}`,
    channelId: seeded.room,
    bodyMarkdown: body,
    now: at,
  });
}

type WakeRow = { agent_id: string; device_id: string; request_id: string; delivered_at: number | null };

async function wakeRows(stub: DurableObjectStub<Workspace>): Promise<WakeRow[]> {
  return runInDurableObject<Workspace, WakeRow[]>(stub, (_instance, state) =>
    state.storage.sql.exec<WakeRow>("SELECT agent_id, device_id, request_id, delivered_at FROM runner_wakes ORDER BY agent_id").toArray(),
  );
}

describe("R01 designated runner registration", () => {
  it("RUNNER-INT-001 registers a device for its owner's agents and refuses anybody else's", async () => {
    const seeded = await seed("runner-register");
    const registered = await seeded.stub.registerRunner({
      actor: seeded.owner,
      deviceId: "device-laptop",
      runnerEpoch: 1,
      presetRevision: 4,
      agents: [{ agentId: seeded.agent, presetId: "preset-default" }],
      now: NOW,
    });
    expect(registered).toMatchObject({ deviceId: "device-laptop", runnerEpoch: 1, agentIds: [seeded.agent], displacedDeviceIds: [] });

    // Somebody else's agent is reported as missing rather than forbidden: the
    // two answers together would tell a caller which agents exist.
    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      await expect(
        instance.registerRunner({
          actor: seeded.owner, deviceId: "device-laptop", runnerEpoch: 2, presetRevision: 4,
          agents: [{ agentId: seeded.foreign, presetId: "preset-default" }], now: NOW + 1,
        }),
      ).rejects.toThrow("agent not found");
    });

    // And that refusal changed nothing: the failed registration must not have
    // moved the epoch or dropped the agent it already answers for.
    const described = await seeded.stub.describeRunner({ actor: seeded.owner, deviceId: "device-laptop" });
    expect(described).toMatchObject({ runnerEpoch: 1, presetRevision: 4, connected: false, agentIds: [seeded.agent] });
  });

  it("RUNNER-INT-002 moves an agent to one device rather than sharing it", async () => {
    const seeded = await seed("runner-move");
    await seeded.stub.registerRunner({
      actor: seeded.owner, deviceId: "device-a", runnerEpoch: 1, presetRevision: 1,
      agents: [{ agentId: seeded.agent, presetId: "preset-a" }], now: NOW,
    });
    const moved = await seeded.stub.registerRunner({
      actor: seeded.owner, deviceId: "device-b", runnerEpoch: 1, presetRevision: 1,
      agents: [{ agentId: seeded.agent, presetId: "preset-b" }], now: NOW + 1,
    });
    // The first machine is named as displaced, which is what lets the workspace
    // tell it to stop. Two runners working one queue is the failure this
    // exists to prevent.
    expect(moved.displacedDeviceIds).toEqual(["device-a"]);

    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      const rows = state.storage.sql
        .exec<{ agent_id: string; device_id: string; preset_id: string }>("SELECT agent_id, device_id, preset_id FROM runner_agents")
        .toArray();
      expect(rows).toEqual([{ agent_id: seeded.agent, device_id: "device-b", preset_id: "preset-b" }]);
    });
    await expect(seeded.stub.describeRunner({ actor: seeded.owner, deviceId: "device-a" }))
      .resolves.toMatchObject({ agentIds: [] });
  });

  it("RUNNER-INT-003 refuses a stale epoch and releases agents a re-registration drops", async () => {
    const seeded = await seed("runner-epoch");
    await seeded.stub.registerRunner({
      actor: seeded.owner, deviceId: "device-a", runnerEpoch: 5, presetRevision: 1,
      agents: [{ agentId: seeded.agent, presetId: "p1" }, { agentId: seeded.second, presetId: "p2" }], now: NOW,
    });
    // A process that restarted with an older epoch would otherwise reclaim
    // agents a newer one had already taken.
    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      await expect(
        instance.registerRunner({
          actor: seeded.owner, deviceId: "device-a", runnerEpoch: 4, presetRevision: 1,
          agents: [{ agentId: seeded.agent, presetId: "p1" }], now: NOW + 1,
        }),
      ).rejects.toThrow("runner epoch has already moved on");
    });

    // Re-registering with fewer agents releases the rest rather than leaving
    // them pointing at a process that has stopped watching them.
    await seeded.stub.registerRunner({
      actor: seeded.owner, deviceId: "device-a", runnerEpoch: 6, presetRevision: 2,
      agents: [{ agentId: seeded.agent, presetId: "p1" }], now: NOW + 2,
    });
    await expect(seeded.stub.describeRunner({ actor: seeded.owner, deviceId: "device-a" }))
      .resolves.toMatchObject({ runnerEpoch: 6, presetRevision: 2, agentIds: [seeded.agent] });
  });

  it("RUNNER-INT-004 tells another member's device nothing at all", async () => {
    const seeded = await seed("runner-tenancy");
    await seeded.stub.registerRunner({
      actor: seeded.owner, deviceId: "device-a", runnerEpoch: 1, presetRevision: 1,
      agents: [{ agentId: seeded.agent, presetId: "p1" }], now: NOW,
    });
    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      // The same wording for a device that does not exist and one that belongs
      // to somebody else, so a caller cannot enumerate other people's machines.
      expect(() => instance.runnerQueueDepth({ actor: seeded.other, deviceId: "device-a", now: NOW + 1 }))
        .toThrow("runner is not registered");
      expect(() => instance.runnerQueueDepth({ actor: seeded.other, deviceId: "device-missing", now: NOW + 1 }))
        .toThrow("runner is not registered");
      await expect(instance.releaseRunner({ actor: seeded.other, deviceId: "device-a", now: NOW + 1 }))
        .rejects.toThrow("runner is not registered");
      // A member who cannot see the device also cannot take it over.
      await expect(
        instance.registerRunner({
          actor: seeded.other, deviceId: "device-a", runnerEpoch: 9, presetRevision: 1, agents: [], now: NOW + 1,
        }),
      ).rejects.toThrow("device is registered to another member");
    });
  });
});

describe("R01 wakes", () => {
  it("RUNNER-INT-005 persists a wake in the same transaction as the work it announces", async () => {
    const seeded = await seed("runner-wake");
    await seeded.stub.registerRunner({
      actor: seeded.owner, deviceId: "device-a", runnerEpoch: 1, presetRevision: 3,
      agents: [{ agentId: seeded.agent, presetId: "preset-default" }], now: NOW,
    });
    await mention(seeded, "@a.runner please look at this", NOW + 1);

    const rows = await wakeRows(seeded.stub);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agent_id: seeded.agent, device_id: "device-a" });
    // Nobody was listening, so the wake is still owed. That is the whole point
    // of writing it down: delivery may fail, the record may not.
    expect(rows[0].delivered_at).toBeNull();
  });

  it("RUNNER-INT-006 leaves no wake for an agent no device answers for", async () => {
    const seeded = await seed("runner-unassigned");
    await mention(seeded, "@a.runner nobody is registered for you", NOW + 1);
    expect(await wakeRows(seeded.stub)).toEqual([]);
  });

  it("RUNNER-INT-007 collapses repeated work into one pending wake", async () => {
    const seeded = await seed("runner-collapse");
    await seeded.stub.registerRunner({
      actor: seeded.owner, deviceId: "device-a", runnerEpoch: 1, presetRevision: 1,
      agents: [{ agentId: seeded.agent, presetId: "p1" }], now: NOW,
    });
    for (let i = 0; i < 3; i += 1) await mention(seeded, `@a.runner message ${i}`, NOW + 1 + i);

    // Three mentions, three queue items, one wake. A wake says "there is work",
    // not "there is this work" — the depth check is what says how much.
    const rows = await wakeRows(seeded.stub);
    expect(rows).toHaveLength(1);
    const depth = await seeded.stub.runnerQueueDepth({ actor: seeded.owner, deviceId: "device-a", now: NOW + 10 });
    expect(depth).toMatchObject({ runnerEpoch: 1 });
    expect(depth.agents).toEqual([
      { agentId: seeded.agent, handle: "a.runner", presetId: "p1", depth: 3, status: "active", localReviews: [] },
    ]);
  });

  it("RUNNER-INT-008 discards a wake staged by a transaction that failed", async () => {
    const seeded = await seed("runner-rollback");
    await seeded.stub.registerRunner({
      actor: seeded.owner, deviceId: "device-a", runnerEpoch: 1, presetRevision: 1,
      agents: [{ agentId: seeded.agent, presetId: "p1" }], now: NOW,
    });
    // A mutation that throws inside its transaction must leave nothing owed,
    // or the next mutation to commit would deliver a wake for work that was
    // rolled back.
    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      await expect(
        instance.sendMessage({
          actor: seeded.owner, idempotencyKey: `${seeded.slug}:bad`, channelId: "channel-missing",
          bodyMarkdown: "@a.runner", now: NOW + 1,
        }),
      ).rejects.toThrow();
    });
    expect(await wakeRows(seeded.stub)).toEqual([]);
  });

  it("RUNNER-INT-009 sends a wake that names a preset and describes nothing", async () => {
    const seeded = await seed("runner-frame");
    await seeded.stub.registerRunner({
      actor: seeded.owner, deviceId: "device-a", runnerEpoch: 1, presetRevision: 7,
      agents: [{ agentId: seeded.agent, presetId: "preset-default" }], now: NOW,
    });

    // Drive the socket the way a runner does, and read what actually comes back
    // over it. This is the scenario that guards the product's central promise:
    // the cloud never says what to run.
    const frames = await runInDurableObject<Workspace, string[]>(seeded.stub, async (instance) => {
      const response = await instance.fetch(
        new Request("https://workspace.invalid/_internal/runner-socket?runner_epoch=1", {
          headers: {
            upgrade: "websocket",
            "x-lepidy-member-id": seeded.owner.memberId,
            "x-lepidy-authorization-epoch": "1",
            "x-lepidy-device-id": "device-a",
          },
        }),
      );
      expect(response.status).toBe(101);
      const client = response.webSocket!;
      const received: string[] = [];
      client.accept();
      client.addEventListener("message", (event) => {
        received.push(String(event.data));
      });
      await instance.sendMessage({
        actor: seeded.owner, idempotencyKey: `${seeded.slug}:live`, channelId: seeded.room,
        bodyMarkdown: "@a.runner there is work", now: NOW + 1,
      });
      return received;
    });

    const wake = frames.map((raw) => JSON.parse(raw) as Record<string, unknown>).find((frame) => frame.type === "wake");
    expect(wake, `no wake frame among ${JSON.stringify(frames)}`).toBeDefined();
    const trigger = wake!.trigger as Record<string, unknown>;
    // Exactly the D05a keys, and no others. A field for an executable, an
    // argument, a path, an environment or a permission posture would show up
    // here as an unexpected key.
    expect(Object.keys(trigger).sort()).toEqual([
      "agentId", "configRevision", "deviceId", "presetId", "requestId", "workspaceId",
    ]);
    expect(trigger).toMatchObject({ agentId: seeded.agent, deviceId: "device-a", presetId: "preset-default", configRevision: 7 });
    // The preset is named, never described: what "preset-default" means lives
    // on the machine and is not in this frame.
    expect(JSON.stringify(wake)).not.toContain("claude");
  });

  it("RUNNER-INT-010 hands a reconnecting runner the wake it missed, once", async () => {
    const seeded = await seed("runner-reconnect");
    await seeded.stub.registerRunner({
      actor: seeded.owner, deviceId: "device-a", runnerEpoch: 1, presetRevision: 1,
      agents: [{ agentId: seeded.agent, presetId: "p1" }], now: NOW,
    });
    // Work arrives while the machine is off.
    await mention(seeded, "@a.runner while you were away", NOW + 1);
    expect((await wakeRows(seeded.stub))[0].delivered_at).toBeNull();

    const first = await runInDurableObject<Workspace, string[]>(seeded.stub, async (instance) => {
      const response = await instance.fetch(
        new Request("https://workspace.invalid/_internal/runner-socket?runner_epoch=1", {
          headers: {
            upgrade: "websocket",
            "x-lepidy-member-id": seeded.owner.memberId,
            "x-lepidy-authorization-epoch": "1",
            "x-lepidy-device-id": "device-a",
          },
        }),
      );
      const client = response.webSocket!;
      const received: string[] = [];
      client.accept();
      client.addEventListener("message", (event) => {
        received.push(String(event.data));
      });
      // Let the frames the upgrade sent settle before reading them.
      await scheduler.wait(10);
      return received;
    });
    const types = first.map((raw) => (JSON.parse(raw) as { type: string }).type);
    expect(types).toContain("welcome");
    expect(types).toContain("wake");

    // And it is marked delivered, so a reconnect loop does not replay the same
    // wake forever. Losing it again costs one depth check, not a lost message.
    expect((await wakeRows(seeded.stub))[0].delivered_at).not.toBeNull();
  });

  it("RUNNER-INT-011 refuses a socket for an unregistered device or a stale epoch", async () => {
    const seeded = await seed("runner-socket-auth");
    await seeded.stub.registerRunner({
      actor: seeded.owner, deviceId: "device-a", runnerEpoch: 2, presetRevision: 1,
      agents: [{ agentId: seeded.agent, presetId: "p1" }], now: NOW,
    });
    const statuses = await runInDurableObject<Workspace, number[]>(seeded.stub, async (instance) => {
      const attempt = async (headers: Record<string, string>, epoch: string) =>
        (
          await instance.fetch(
            new Request(`https://workspace.invalid/_internal/runner-socket?runner_epoch=${epoch}`, {
              headers: { upgrade: "websocket", ...headers },
            }),
          )
        ).status;
      const base = { "x-lepidy-member-id": seeded.owner.memberId, "x-lepidy-authorization-epoch": "1" };
      return [
        // A member who is not who they say they are.
        await attempt({ ...base, "x-lepidy-authorization-epoch": "99", "x-lepidy-device-id": "device-a" }, "2"),
        // A device that never registered. A socket is not a registration.
        await attempt({ ...base, "x-lepidy-device-id": "device-unknown" }, "2"),
        // A process whose registration has been superseded.
        await attempt({ ...base, "x-lepidy-device-id": "device-a" }, "1"),
        // Another member reaching for this device.
        await attempt({ "x-lepidy-member-id": seeded.other.memberId, "x-lepidy-authorization-epoch": "1", "x-lepidy-device-id": "device-a" }, "2"),
        await attempt({ ...base, "x-lepidy-device-id": "device-a" }, "2"),
      ];
    });
    expect(statuses).toEqual([403, 409, 409, 409, 101]);
  });

  it("RUNNER-INT-012 keeps a runner out of presence", async () => {
    const seeded = await seed("runner-presence");
    await seeded.stub.registerRunner({
      actor: seeded.owner, deviceId: "device-a", runnerEpoch: 1, presetRevision: 1,
      agents: [{ agentId: seeded.agent, presetId: "p1" }], now: NOW,
    });
    const presence = await runInDurableObject<Workspace, readonly string[]>(seeded.stub, async (instance) => {
      const response = await instance.fetch(
        new Request("https://workspace.invalid/_internal/runner-socket?runner_epoch=1", {
          headers: {
            upgrade: "websocket",
            "x-lepidy-member-id": seeded.owner.memberId,
            "x-lepidy-authorization-epoch": "1",
            "x-lepidy-device-id": "device-a",
          },
        }),
      );
      response.webSocket!.accept();
      return instance.presence().memberIds;
    });
    // A headless daemon reconnecting must not make its owner look like they are
    // at the keyboard.
    expect(presence).toEqual([]);
  });
});

describe("R01 stopping", () => {
  it("RUNNER-INT-013 stops a runner when its agent is paused, and drops the pending wake", async () => {
    const seeded = await seed("runner-pause");
    await seeded.stub.registerRunner({
      actor: seeded.owner, deviceId: "device-a", runnerEpoch: 1, presetRevision: 1,
      agents: [{ agentId: seeded.agent, presetId: "p1" }], now: NOW,
    });
    await mention(seeded, "@a.runner work exists", NOW + 1);
    expect(await wakeRows(seeded.stub)).toHaveLength(1);

    const frames = await runInDurableObject<Workspace, string[]>(seeded.stub, async (instance) => {
      const response = await instance.fetch(
        new Request("https://workspace.invalid/_internal/runner-socket?runner_epoch=1", {
          headers: {
            upgrade: "websocket",
            "x-lepidy-member-id": seeded.owner.memberId,
            "x-lepidy-authorization-epoch": "1",
            "x-lepidy-device-id": "device-a",
          },
        }),
      );
      const client = response.webSocket!;
      const received: string[] = [];
      client.accept();
      client.addEventListener("message", (event) => {
        received.push(String(event.data));
      });
      await scheduler.wait(10);
      await instance.setAgentStatus({ actor: seeded.owner, agentId: seeded.agent, status: "paused", now: NOW + 2 });
      await scheduler.wait(10);
      return received;
    });
    const stop = frames.map((raw) => JSON.parse(raw) as Record<string, unknown>).find((frame) => frame.type === "stop");
    expect(stop).toMatchObject({ type: "stop", agentId: seeded.agent, reason: "agent_paused" });

    // A wake nobody collected must not survive the stop that overtook it.
    expect(await wakeRows(seeded.stub)).toEqual([]);
    // And a paused agent reports no depth, so nothing on the machine starts a
    // process for it even if the frame never arrived.
    const depth = await seeded.stub.runnerQueueDepth({ actor: seeded.owner, deviceId: "device-a", now: NOW + 3 });
    expect(depth.agents).toEqual([{ agentId: seeded.agent, handle: "a.runner", presetId: "p1", depth: 0, status: "paused", localReviews: [] }]);
  });

  it("RUNNER-INT-014 releases a runner from anywhere, without the machine being reachable", async () => {
    const seeded = await seed("runner-release");
    await seeded.stub.registerRunner({
      actor: seeded.owner, deviceId: "device-a", runnerEpoch: 1, presetRevision: 1,
      agents: [{ agentId: seeded.agent, presetId: "p1" }], now: NOW,
    });
    await mention(seeded, "@a.runner work exists", NOW + 1);

    // Nothing is connected. The stop still has to work, because a machine that
    // is not listening is exactly the case an owner needs this for.
    await expect(seeded.stub.releaseRunner({ actor: seeded.owner, deviceId: "device-a", reason: "lost_laptop", now: NOW + 2 }))
      .resolves.toEqual({ released: 1 });
    expect(await wakeRows(seeded.stub)).toEqual([]);
    await runInDurableObject<Workspace, void>(seeded.stub, (instance) => {
      expect(() => instance.describeRunner({ actor: seeded.owner, deviceId: "device-a" }))
        .toThrow("runner is not registered");
    });

    // New work queues no wake for a device that has been released, and the
    // socket it used to hold cannot be reopened.
    await mention(seeded, "@a.runner more work", NOW + 3);
    expect(await wakeRows(seeded.stub)).toEqual([]);
    const status = await runInDurableObject<Workspace, number>(seeded.stub, async (instance) =>
      (
        await instance.fetch(
          new Request("https://workspace.invalid/_internal/runner-socket?runner_epoch=1", {
            headers: {
              upgrade: "websocket",
              "x-lepidy-member-id": seeded.owner.memberId,
              "x-lepidy-authorization-epoch": "1",
              "x-lepidy-device-id": "device-a",
            },
          }),
        )
      ).status,
    );
    expect(status).toBe(409);
  });

  it("RUNNER-INT-015 records a registration without recording what runs", async () => {
    const seeded = await seed("runner-audit");
    await seeded.stub.registerRunner({
      actor: seeded.owner, deviceId: "device-a", runnerEpoch: 3, presetRevision: 9,
      agents: [{ agentId: seeded.agent, presetId: "preset-secret-name" }], now: NOW,
    });
    const trail = await seeded.stub.auditTrail(0, 50);
    const entry = trail.find((row) => row.eventType === "runner.registered");
    expect(entry).toBeDefined();
    expect(entry!.metadata).toMatchObject({ agent_count: 1, runner_epoch: 3, config_revision: 9 });
    // Counts and revisions, never the preset's name: an audit record outlives
    // the thing it describes, and this one is replicated to the cloud.
    expect(JSON.stringify(entry!.metadata)).not.toContain("preset-secret-name");
    await expect(seeded.stub.verifyAuditTrail()).resolves.toMatchObject({ ok: true });
  });
});

describe("R02 the harness workflow", () => {
  /** A runner that answers for an agent with a live delegation. */
  async function seedWithDelegation(label: string) {
    const seeded = await seed(label);
    const delegation = await seeded.stub.createAgentDelegation({
      actor: seeded.owner,
      agent: seeded.agent,
      channelIds: [seeded.room],
      expiresAt: NOW + 24 * 60 * 60 * 1000,
      now: NOW,
    });
    await seeded.stub.registerRunner({
      actor: seeded.owner, deviceId: "device-a", runnerEpoch: 1, presetRevision: 5,
      agents: [{ agentId: seeded.agent, presetId: "p1" }], now: NOW,
    });
    return { ...seeded, delegation };
  }

  it("RUNNER-INT-016 issues a session bound to the device, epoch and preset revision", async () => {
    const seeded = await seedWithDelegation("runner-session");
    const grant = await seeded.stub.startRunnerSession({
      actor: seeded.owner, deviceId: "device-a", agentId: seeded.agent, now: NOW + 1,
    });
    expect(grant).toMatchObject({ agentId: seeded.agent, delegationId: seeded.delegation.id });
    // The daemon never names a delegation: the workspace finds the agent's own,
    // so a runner cannot ask for authority nobody gave it.
    expect(grant.mcpPath).toBe(`/w/${seeded.slug}/mcp`);
    expect(grant.token).toMatch(new RegExp(`^lpd_st_${seeded.slug}_`));
    // Exactly the tools a harness needs to work an item, answer in the room it
    // came from, and ask an unlocked release device to make an authorized
    // credential-bearing request. Nothing posts as a person, administers an
    // agent, or releases credential plaintext to the harness.
    expect([...grant.capabilities].sort()).toEqual([
      "agent_complete", "agent_inbox", "agent_next", "agent_post", "agent_renew", "agent_start",
      "list_channels", "proxy_request", "read_channel", "read_thread", "whoami",
    ]);

    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      const row = state.storage.sql
        .exec<{ device_id: string; runner_epoch: number; preset_revision: number; token_hash: string }>(
          "SELECT device_id, runner_epoch, preset_revision, token_hash FROM agent_sessions WHERE id = ?", grant.sessionId,
        )
        .one();
      // Bound to the configuration it was started under, so a preset edited
      // afterwards is distinguishable from the one this session began with.
      expect(row).toMatchObject({ device_id: "device-a", runner_epoch: 1, preset_revision: 5 });
      expect(row.token_hash).toMatch(/^[a-f0-9]{64}$/);
      // The token itself is never stored, and never lands in the audit chain.
      expect(JSON.stringify(state.storage.sql.exec("SELECT * FROM audit_events").toArray())).not.toContain(grant.token);
    });
  });

  it("RUNNER-INT-017 refuses a session for an agent this device does not answer for", async () => {
    const seeded = await seedWithDelegation("runner-session-scope");
    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      // An agent this member owns but this device is not the runner for is
      // reported as missing, the same as one that does not exist.
      await expect(
        instance.startRunnerSession({ actor: seeded.owner, deviceId: "device-a", agentId: seeded.second, now: NOW + 1 }),
      ).rejects.toThrow("agent not found");
      await expect(
        instance.startRunnerSession({ actor: seeded.owner, deviceId: "device-b", agentId: seeded.agent, now: NOW + 1 }),
      ).rejects.toThrow("runner is not registered");
      // And another member cannot mint one against this device at all.
      await expect(
        instance.startRunnerSession({ actor: seeded.other, deviceId: "device-a", agentId: seeded.agent, now: NOW + 1 }),
      ).rejects.toThrow("runner is not registered");
    });
  });

  it("RUNNER-INT-018 refuses a session for an agent with no live delegation", async () => {
    const seeded = await seedWithDelegation("runner-session-revoked");
    await seeded.stub.revokeAgentDelegation({ actor: seeded.owner, delegationId: seeded.delegation.id, now: NOW + 1 });
    await runInDurableObject<Workspace, void>(seeded.stub, async (instance) => {
      // The authority is the delegation, so removing it removes the runner's
      // ability to work at all rather than only its current session.
      await expect(
        instance.startRunnerSession({ actor: seeded.owner, deviceId: "device-a", agentId: seeded.agent, now: NOW + 2 }),
      ).rejects.toThrow("no live delegation");
    });
  });

  it("RUNNER-INT-019 turns a blocked harness into a decision waiting for a person", async () => {
    const seeded = await seedWithDelegation("runner-blocked");
    const grant = await seeded.stub.startRunnerSession({
      actor: seeded.owner, deviceId: "device-a", agentId: seeded.agent, now: NOW + 1,
    });
    await mention(seeded, "@a.runner please do the thing", NOW + 2);

    // The harness claims an item and then hits its own permission wall.
    const claimed = await seeded.stub.claimAgentWork({
      actor: seeded.owner,
      sessionToken: grant.token,
      agent: seeded.agent,
      claimId: "claim-blocked",
      leaseToken: `lease-blocked-${"x".repeat(40)}`,
      sessionId: grant.sessionId,
      now: NOW + 3,
    });
    expect(claimed.item).not.toBeNull();

    const reported = await seeded.stub.reportRunnerOutcome({
      actor: seeded.owner, deviceId: "device-a", agentId: seeded.agent, sessionId: grant.sessionId,
      outcome: "blocked", reason: "the harness was blocked by its permission posture", now: NOW + 4,
    });
    // Not retried and not dead-lettered. Retrying work that policy refused just
    // refuses again; this is a person's decision, and it waits where they look.
    expect(reported).toEqual({ agentId: seeded.agent, outcome: "blocked", itemsNeedingAttention: 1 });
    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      const states = state.storage.sql
        .exec<{ execution_state: string }>("SELECT execution_state FROM agent_queue WHERE agent_id = ?", seeded.agent)
        .toArray();
      expect(states).toEqual([{ execution_state: "needs_attention" }]);
    });
  });

  it("RUNNER-INT-020 leaves another runner's work alone", async () => {
    const seeded = await seedWithDelegation("runner-outcome-scope");
    const grant = await seeded.stub.startRunnerSession({
      actor: seeded.owner, deviceId: "device-a", agentId: seeded.agent, now: NOW + 1,
    });
    await mention(seeded, "@a.runner one", NOW + 2);
    await seeded.stub.claimAgentWork({
      actor: seeded.owner, sessionToken: grant.token, agent: seeded.agent, claimId: "claim-live",
      leaseToken: `lease-live-${"x".repeat(40)}`, sessionId: grant.sessionId, now: NOW + 3,
    });

    // A report naming a session that did not claim this item must not disturb
    // it: one machine reporting a failure cannot strand another's work.
    const reported = await seeded.stub.reportRunnerOutcome({
      actor: seeded.owner, deviceId: "device-a", agentId: seeded.agent, sessionId: "session-somebody-else",
      outcome: "failed", now: NOW + 4,
    });
    expect(reported.itemsNeedingAttention).toBe(0);
    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec<{ execution_state: string }>("SELECT execution_state FROM agent_queue WHERE agent_id = ?", seeded.agent)
          .toArray(),
      ).toEqual([{ execution_state: "claimed" }]);
    });
  });

  it("RUNNER-INT-021 records a run without recording what the harness said", async () => {
    const seeded = await seedWithDelegation("runner-outcome-audit");
    const grant = await seeded.stub.startRunnerSession({
      actor: seeded.owner, deviceId: "device-a", agentId: seeded.agent, now: NOW + 1,
    });
    await seeded.stub.reportRunnerOutcome({
      actor: seeded.owner, deviceId: "device-a", agentId: seeded.agent, sessionId: grant.sessionId,
      outcome: "completed", reason: "the harness finished", now: NOW + 2,
    });
    const entry = (await seeded.stub.auditTrail(0, 100)).find((row) => row.eventType === "runner.run_reported");
    expect(entry!.metadata).toMatchObject({
      device_id: "device-a", run_outcome: "completed", items_needing_attention: 0,
    });
    await expect(seeded.stub.verifyAuditTrail()).resolves.toMatchObject({ ok: true });
  });

  it("RUNNER-INT-022 keeps work that arrives while a run is in flight", async () => {
    const seeded = await seedWithDelegation("runner-race");
    const grant = await seeded.stub.startRunnerSession({
      actor: seeded.owner, deviceId: "device-a", agentId: seeded.agent, now: NOW + 1,
    });
    await mention(seeded, "@a.runner first", NOW + 2);
    await seeded.stub.claimAgentWork({
      actor: seeded.owner, sessionToken: grant.token, agent: seeded.agent, claimId: "claim-first",
      leaseToken: `lease-first-${"x".repeat(40)}`, sessionId: grant.sessionId, now: NOW + 3,
    });

    // More work arrives while the harness is mid-run. This is the exit race:
    // the process is about to end, the wake for this is delivered to a socket
    // that is about to be idle, and nothing durable would notice if the depth
    // check did not exist.
    await mention(seeded, "@a.runner second", NOW + 4);
    await seeded.stub.reportRunnerOutcome({
      actor: seeded.owner, deviceId: "device-a", agentId: seeded.agent, sessionId: grant.sessionId,
      outcome: "completed", now: NOW + 5,
    });

    // The depth a runner reads after an exit still shows the new item, so the
    // machine finds it on its very next question.
    const depth = await seeded.stub.runnerQueueDepth({ actor: seeded.owner, deviceId: "device-a", now: NOW + 6 });
    expect(depth.agents[0]).toMatchObject({ agentId: seeded.agent, depth: 1 });
  });
});
