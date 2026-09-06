import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Actor, Workspace } from "../src/cloudflare/workspace";
import { SOCKET_PING, SOCKET_PONG, type ServerFrame } from "../src/domain/socket-protocol";

const NOW = 1_800_000_000_000;

type Seeded = {
  stub: DurableObjectStub<Workspace>;
  owner: Actor;
  member: Actor;
  outsider: Actor;
};

async function seedWorkspace(name: string): Promise<Seeded> {
  const stub = env.WORKSPACE.getByName(name);
  await stub.initializeWorkspace({ storageMode: "cloud", hostEpoch: 0, routingEpoch: 1, now: NOW });
  const people: readonly [string, string, string][] = [
    ["member-owner", "maya", "Maya Chen"],
    ["member-two", "daniel", "Daniel Park"],
    ["member-three", "priya", "Priya Singh"],
  ];
  for (const [index, [memberId, handle, displayName]] of people.entries()) {
    await stub.applyMembership({
      operationId: `${name}-op-${memberId}`,
      memberId,
      accountId: `account-${memberId}`,
      handle,
      displayName,
      role: index === 0 ? "owner" : "member",
      status: "active",
      authorizationEpoch: 1,
      version: 1,
      now: NOW,
    });
  }
  return {
    stub,
    owner: { memberId: "member-owner", authorizationEpoch: 1 },
    member: { memberId: "member-two", authorizationEpoch: 1 },
    outsider: { memberId: "member-three", authorizationEpoch: 1 },
  };
}

/** A real client socket against the object, with a queue of received frames. */
class TestSocket {
  readonly frames: ServerFrame[] = [];
  readonly raw: string[] = [];

  private constructor(private readonly socket: WebSocket) {}

  static async open(
    stub: DurableObjectStub<Workspace>,
    actor: Actor,
    since = 0,
  ): Promise<TestSocket> {
    const response = await stub.fetch(
      `https://workspace/_internal/member-socket?since=${since}`,
      {
        headers: {
          upgrade: "websocket",
          "x-lepidy-member-id": actor.memberId,
          "x-lepidy-authorization-epoch": String(actor.authorizationEpoch),
        },
      },
    );
    if (!response.webSocket) throw new Error(`socket refused with ${response.status}`);
    const client = new TestSocket(response.webSocket);
    // The listener goes on before accept, or frames already queued are lost.
    response.webSocket.addEventListener("message", (event) => {
      const data = String(event.data);
      client.raw.push(data);
      try {
        client.frames.push(JSON.parse(data) as ServerFrame);
      } catch {
        // A non-JSON frame is recorded raw; the pong auto-response is one.
      }
    });
    response.webSocket.accept();
    return client;
  }

  static async refuse(stub: DurableObjectStub<Workspace>, actor: Actor): Promise<number> {
    const response = await stub.fetch("https://workspace/_internal/member-socket", {
      headers: {
        upgrade: "websocket",
        "x-lepidy-member-id": actor.memberId,
        "x-lepidy-authorization-epoch": String(actor.authorizationEpoch),
      },
    });
    return response.status;
  }

  send(frame: unknown): void {
    this.socket.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  }

  close(): void {
    this.socket.close();
  }

  /** Waits on observable state, never on a fixed duration. */
  async waitFor(predicate: () => boolean, label = "socket state"): Promise<void> {
    for (let turn = 0; turn < 400; turn += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`timed out waiting for ${label}; frames: ${JSON.stringify(this.frames)}`);
  }

  /** Lets any in-flight frames arrive before asserting that none did. */
  async quiesce(): Promise<void> {
    let previous = -1;
    while (previous !== this.raw.length) {
      previous = this.raw.length;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  count<T extends ServerFrame["type"]>(type: T): number {
    return this.of(type).length;
  }

  of<T extends ServerFrame["type"]>(type: T): Extract<ServerFrame, { type: T }>[] {
    return this.frames.filter((frame) => frame.type === type) as Extract<ServerFrame, { type: T }>[];
  }
}

async function room(seeded: Seeded, slug: string, kind: "public" | "private", members: string[] = []) {
  return seeded.stub.createChannel({
    actor: seeded.owner,
    idempotencyKey: `channel:create:${slug}:00000000`,
    kind,
    slug,
    memberIds: members,
    now: NOW,
  });
}

describe("live delivery", () => {
  it("LIVE-INT-001 accepts an authorized socket, welcomes it and refuses a stale one", async () => {
    const seeded = await seedWorkspace("live-accept");
    const socket = await TestSocket.open(seeded.stub, seeded.owner);
    await socket.waitFor(() => socket.count("welcome") === 1, "welcome");

    expect(socket.of("welcome")[0]).toMatchObject({ memberId: "member-owner", sequence: expect.any(Number) });

    // A stale epoch and an unknown member are both refused at the upgrade.
    expect(await TestSocket.refuse(seeded.stub, { memberId: "member-owner", authorizationEpoch: 2 })).toBe(403);
    expect(await TestSocket.refuse(seeded.stub, { memberId: "member-ghost", authorizationEpoch: 1 })).toBe(403);
    socket.close();
  });

  it("LIVE-INT-002 answers a keepalive without waking the object or writing anything", async () => {
    const seeded = await seedWorkspace("live-keepalive");
    const socket = await TestSocket.open(seeded.stub, seeded.owner);
    await socket.waitFor(() => socket.count("welcome") === 1, "welcome");

    // The runtime holds the pair, so a heartbeat never reaches this object.
    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      const pair = state.getWebSocketAutoResponse();
      expect(pair?.request).toBe(SOCKET_PING);
      expect(pair?.response).toBe(SOCKET_PONG);
    });

    const before = await runInDurableObject<Workspace, number>(seeded.stub, (_instance, state) =>
      state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM channel_read_state").one().n,
    );
    for (let index = 0; index < 5; index += 1) socket.send(SOCKET_PING);
    await socket.waitFor(
      () => socket.raw.filter((frame) => frame === SOCKET_PONG).length === 5,
      "five pongs",
    );

    const after = await runInDurableObject<Workspace, number>(seeded.stub, (_instance, state) =>
      state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM channel_read_state").one().n,
    );
    expect(after).toBe(before);
    socket.close();
  });

  it("LIVE-INT-003 broadcasts a committed message only to sockets that may see the room", async () => {
    const seeded = await seedWorkspace("live-fanout");
    const open = await room(seeded, "eng", "public");
    const closed = await room(seeded, "design", "private", [seeded.member.memberId]);

    const ownerSocket = await TestSocket.open(seeded.stub, seeded.owner);
    const memberSocket = await TestSocket.open(seeded.stub, seeded.member);
    const outsiderSocket = await TestSocket.open(seeded.stub, seeded.outsider);
    await outsiderSocket.waitFor(() => outsiderSocket.count("welcome") === 1, "welcome");

    const inOpen = await seeded.stub.sendMessage({
      actor: seeded.owner,
      idempotencyKey: "message:send:live0000001",
      channelId: open.channelId,
      bodyMarkdown: "everyone can see this",
      now: NOW + 1,
    });
    const inClosed = await seeded.stub.sendMessage({
      actor: seeded.owner,
      idempotencyKey: "message:send:live0000002",
      channelId: closed.channelId,
      bodyMarkdown: "PRIVATE_FANOUT_CANARY",
      now: NOW + 2,
    });
    await memberSocket.waitFor(() => memberSocket.count("event") === 2, "two events");
    await outsiderSocket.quiesce();

    // The open room reaches every socket; the closed one reaches only its members.
    expect(outsiderSocket.of("event").map((frame) => frame.channelId)).toEqual([open.channelId]);
    expect(memberSocket.of("event").map((frame) => frame.channelId)).toEqual([
      open.channelId,
      closed.channelId,
    ]);
    expect(JSON.stringify(outsiderSocket.frames)).not.toContain(inClosed.messageId);
    expect(JSON.stringify(outsiderSocket.frames)).not.toContain("PRIVATE_FANOUT_CANARY");

    // Delivery carries identifiers, never the message body.
    const event = memberSocket.of("event").at(-1);
    expect(event?.payload).toMatchObject({ messageId: inClosed.messageId, channelId: closed.channelId });
    expect(JSON.stringify(memberSocket.frames)).not.toContain("PRIVATE_FANOUT_CANARY");
    expect(JSON.stringify(memberSocket.frames)).toContain(inOpen.messageId);

    ownerSocket.close();
    memberSocket.close();
    outsiderSocket.close();
  });

  it("LIVE-INT-004 replays from a reconnect cursor and filters what the member may now see", async () => {
    const seeded = await seedWorkspace("live-replay");
    const open = await room(seeded, "eng", "public");
    const closed = await room(seeded, "design", "private", [seeded.member.memberId]);

    await seeded.stub.sendMessage({
      actor: seeded.owner,
      idempotencyKey: "message:send:live0000010",
      channelId: open.channelId,
      bodyMarkdown: "first",
      now: NOW + 1,
    });
    await seeded.stub.sendMessage({
      actor: seeded.owner,
      idempotencyKey: "message:send:live0000011",
      channelId: closed.channelId,
      bodyMarkdown: "REPLAY_PRIVATE_CANARY",
      now: NOW + 2,
    });

    // A member who was in the closed room replays both.
    const memberSocket = await TestSocket.open(seeded.stub, seeded.member, 0);
    memberSocket.send({ type: "resume", since: 0 });
    await memberSocket.waitFor(() => memberSocket.count("event") >= 2, "replayed events");
    const memberChannels = memberSocket.of("event").map((frame) => frame.channelId);
    expect(memberChannels).toContain(open.channelId);
    expect(memberChannels).toContain(closed.channelId);
    memberSocket.close();

    // After leaving, the same stored events must not replay to them.
    await seeded.stub.leaveChannel({
      actor: seeded.member,
      channelId: closed.channelId,
      now: NOW + 3,
    });
    const afterLeaving = await TestSocket.open(seeded.stub, seeded.member, 0);
    afterLeaving.send({ type: "resume", since: 0 });
    await afterLeaving.waitFor(() => afterLeaving.count("event") >= 1, "replayed events");
    await afterLeaving.quiesce();
    expect(afterLeaving.of("event").map((frame) => frame.channelId)).not.toContain(closed.channelId);
    expect(JSON.stringify(afterLeaving.frames)).not.toContain("REPLAY_PRIVATE_CANARY");
    afterLeaving.close();

    // An outsider replaying from zero receives only the open room.
    const outsiderSocket = await TestSocket.open(seeded.stub, seeded.outsider, 0);
    outsiderSocket.send({ type: "resume", since: 0 });
    await outsiderSocket.waitFor(() => outsiderSocket.count("event") >= 1, "replayed events");
    await outsiderSocket.quiesce();
    expect(new Set(outsiderSocket.of("event").map((frame) => frame.channelId))).toEqual(
      new Set([open.channelId]),
    );
    outsiderSocket.close();
  });

  it("LIVE-INT-005 tells a client to refetch rather than leaving a silent gap", async () => {
    const seeded = await seedWorkspace("live-reset");
    const open = await room(seeded, "eng", "public");
    await seeded.stub.sendMessage({
      actor: seeded.owner,
      idempotencyKey: "message:send:live0000020",
      channelId: open.channelId,
      bodyMarkdown: "kept",
      now: NOW + 1,
    });

    // The replay window has moved past the client's cursor, as retention does.
    await runInDurableObject<Workspace, void>(seeded.stub, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM replay_events WHERE sequence < 3");
    });

    const socket = await TestSocket.open(seeded.stub, seeded.owner);
    socket.send({ type: "resume", since: 1 });
    await socket.waitFor(() => socket.count("reset") === 1, "reset");
    await socket.quiesce();
    expect(socket.of("reset")[0]).toEqual({ type: "reset", reason: "replay window has expired" });
    expect(socket.of("event")).toEqual([]);
    socket.close();
  });

  it("LIVE-INT-006 refuses a malformed frame and one from a member whose authority changed", async () => {
    const seeded = await seedWorkspace("live-frames");
    const socket = await TestSocket.open(seeded.stub, seeded.member);
    await socket.waitFor(() => socket.count("welcome") === 1, "welcome");

    socket.send("not json at all");
    socket.send(JSON.stringify({ type: "read", channelId: "channel-does-not-exist", sequence: 1 }));
    await socket.waitFor(() => socket.count("error") === 2, "two errors");
    expect(socket.of("error").map((frame) => frame.reason)).toEqual([
      "frame is not valid JSON",
      "channel not found",
    ]);

    // Authority is rechecked live, so an open tab stops working when it changes.
    await seeded.stub.applyMembership({
      operationId: "live-frames-op-suspend",
      memberId: seeded.member.memberId,
      accountId: `account-${seeded.member.memberId}`,
      handle: "daniel",
      displayName: "Daniel Park",
      role: "member",
      status: "suspended",
      authorizationEpoch: 2,
      version: 2,
      now: NOW + 1,
    });
    const before = socket.frames.length;
    socket.send(JSON.stringify({ type: "typing", channelId: "channel-1" }));
    await socket.quiesce();
    expect(socket.frames.length).toBe(before);
  });
});

describe("read state", () => {
  it("LIVE-INT-007 shares one read cursor across a member's own devices", async () => {
    const seeded = await seedWorkspace("live-read");
    const open = await room(seeded, "eng", "public");
    for (let index = 0; index < 3; index += 1) {
      await seeded.stub.sendMessage({
        actor: seeded.owner,
        idempotencyKey: `message:send:live000003${index}`,
        channelId: open.channelId,
        bodyMarkdown: `message ${index}`,
        now: NOW + 1 + index,
      });
    }

    const laptop = await TestSocket.open(seeded.stub, seeded.owner);
    const phone = await TestSocket.open(seeded.stub, seeded.owner);
    const other = await TestSocket.open(seeded.stub, seeded.member);
    await other.waitFor(() => other.count("welcome") === 1, "welcome");

    // Reading on the phone reads on the laptop.
    phone.send({ type: "read", channelId: open.channelId, sequence: 2 });
    await laptop.waitFor(() => laptop.count("read") === 1, "read on the other device");
    await other.quiesce();
    expect(laptop.of("read")[0]).toEqual({ type: "read", channelId: open.channelId, sequence: 2 });
    expect(phone.of("read")[0]).toEqual({ type: "read", channelId: open.channelId, sequence: 2 });
    // Somebody else's read state is not their business.
    expect(other.of("read")).toEqual([]);

    await expect(seeded.stub.unreadSummary({ actor: seeded.owner })).resolves.toEqual({
      channels: [{ channelId: open.channelId, unread: 1 }],
      total: 1,
    });

    // A cursor never moves backwards, and never past what exists.
    laptop.send({ type: "read", channelId: open.channelId, sequence: 1 });
    laptop.send({ type: "read", channelId: open.channelId, sequence: 99 });
    await laptop.waitFor(() => laptop.count("read") === 3, "both acknowledgements");
    await expect(
      seeded.stub.markChannelRead({
        actor: seeded.owner,
        channelId: open.channelId,
        sequence: 0,
        now: NOW + 10,
      }),
    ).resolves.toEqual({ sequence: 3 });
    await expect(seeded.stub.unreadSummary({ actor: seeded.owner })).resolves.toEqual({
      channels: [],
      total: 0,
    });

    laptop.close();
    phone.close();
    other.close();
  });

  it("LIVE-INT-008 keeps thread read state separate from the channel's", async () => {
    const seeded = await seedWorkspace("live-thread-read");
    const open = await room(seeded, "eng", "public");
    const root = await seeded.stub.sendMessage({
      actor: seeded.owner,
      idempotencyKey: "message:send:live0000040",
      channelId: open.channelId,
      bodyMarkdown: "why is the build red?",
      now: NOW + 1,
    });
    for (let index = 0; index < 2; index += 1) {
      await seeded.stub.sendMessage({
        actor: seeded.owner,
        idempotencyKey: `message:send:live000005${index}`,
        channelId: open.channelId,
        bodyMarkdown: `reply ${index}`,
        threadParentId: root.messageId,
        now: NOW + 2 + index,
      });
    }

    // Reading the channel does not read the thread.
    await seeded.stub.markChannelRead({
      actor: seeded.owner,
      channelId: open.channelId,
      sequence: 99,
      now: NOW + 10,
    });
    await expect(
      seeded.stub.markThreadRead({
        actor: seeded.owner,
        threadRootId: root.messageId,
        sequence: 1,
        now: NOW + 11,
      }),
    ).resolves.toEqual({ sequence: 1 });
    await expect(
      seeded.stub.markThreadRead({
        actor: seeded.owner,
        threadRootId: root.messageId,
        sequence: 99,
        now: NOW + 12,
      }),
    ).resolves.toEqual({ sequence: 2 });

    await runInDurableObject<Workspace, void>(seeded.stub, (instance, state) => {
      expect(() =>
        instance.markThreadRead({
          actor: seeded.outsider,
          threadRootId: "message-does-not-exist",
          sequence: 1,
          now: NOW + 13,
        }),
      ).toThrow("thread not found");
      // Channel and thread cursors are stored, and counted, separately.
      expect(
        state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM thread_read_state").one().n,
      ).toBe(1);
      expect(
        state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM channel_read_state").one().n,
      ).toBe(1);
    });
  });

  it("LIVE-INT-009 counts nothing unread in a room the member never joined", async () => {
    const seeded = await seedWorkspace("live-unread-nonmember");
    const open = await room(seeded, "eng", "public");
    await seeded.stub.sendMessage({
      actor: seeded.owner,
      idempotencyKey: "message:send:live0000060",
      channelId: open.channelId,
      bodyMarkdown: "visible to everyone",
      now: NOW + 1,
    });

    // The outsider can read the room but has never joined it, so there is no
    // cursor to derive unread from and nothing counts against them forever.
    await expect(seeded.stub.unreadSummary({ actor: seeded.outsider })).resolves.toEqual({
      channels: [],
      total: 0,
    });
    await expect(seeded.stub.unreadSummary({ actor: seeded.owner })).resolves.toEqual({
      channels: [{ channelId: open.channelId, unread: 1 }],
      total: 1,
    });

    await seeded.stub.joinChannel({
      actor: seeded.outsider,
      channelId: open.channelId,
      now: NOW + 2,
    });
    await expect(seeded.stub.unreadSummary({ actor: seeded.outsider })).resolves.toEqual({
      channels: [{ channelId: open.channelId, unread: 1 }],
      total: 1,
    });
  });
});

describe("presence and typing", () => {
  it("LIVE-INT-010 relays presence and typing without a durable write", async () => {
    const seeded = await seedWorkspace("live-presence");
    const open = await room(seeded, "eng", "public");
    // Created by the other member and never shared, so the owner is not in it.
    const closed = await seeded.stub.createChannel({
      actor: seeded.member,
      idempotencyKey: "channel:create:design:00000001",
      kind: "private",
      slug: "design",
      now: NOW,
    });

    const ownerSocket = await TestSocket.open(seeded.stub, seeded.owner);
    await ownerSocket.waitFor(() => ownerSocket.count("welcome") === 1, "welcome");
    await expect(seeded.stub.presence()).resolves.toMatchObject({ memberIds: ["member-owner"] });

    const memberSocket = await TestSocket.open(seeded.stub, seeded.member);
    await ownerSocket.waitFor(() => ownerSocket.count("presence") === 1, "presence arrival");
    expect(ownerSocket.of("presence")).toEqual([
      { type: "presence", memberId: "member-two", online: true },
    ]);
    await expect(seeded.stub.presence()).resolves.toMatchObject({
      memberIds: ["member-owner", "member-two"],
    });

    const rowsBefore = await runInDurableObject<Workspace, number>(seeded.stub, (_instance, state) =>
      state.storage.sql
        .exec<{ n: number }>(
          "SELECT (SELECT COUNT(*) FROM replay_events) + (SELECT COUNT(*) FROM channel_read_state) AS n",
        )
        .one().n,
    );

    memberSocket.send({ type: "typing", channelId: open.channelId });
    memberSocket.send({ type: "typing", channelId: closed.channelId });
    await ownerSocket.waitFor(() => ownerSocket.count("typing") === 1, "typing relay");
    await ownerSocket.quiesce();
    await memberSocket.quiesce();

    // Typing in the open room reaches the owner; typing in the room they are not
    // in does not, and neither writes anything down.
    expect(ownerSocket.of("typing").map((frame) => frame.channelId)).toEqual([open.channelId]);
    expect(memberSocket.of("typing")).toEqual([]);
    const rowsAfter = await runInDurableObject<Workspace, number>(seeded.stub, (_instance, state) =>
      state.storage.sql
        .exec<{ n: number }>(
          "SELECT (SELECT COUNT(*) FROM replay_events) + (SELECT COUNT(*) FROM channel_read_state) AS n",
        )
        .one().n,
    );
    expect(rowsAfter).toBe(rowsBefore);

    memberSocket.close();
    await ownerSocket.waitFor(() => ownerSocket.count("presence") === 2, "presence departure");
    expect(ownerSocket.of("presence").at(-1)).toEqual({
      type: "presence",
      memberId: "member-two",
      online: false,
    });
    ownerSocket.close();
  });
});
