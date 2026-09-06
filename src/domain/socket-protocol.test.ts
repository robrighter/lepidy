import { describe, expect, it } from "vitest";

import {
  MAX_CLIENT_FRAME_BYTES,
  SOCKET_PING,
  SOCKET_PONG,
  encodeServerFrame,
  parseClientFrame,
} from "./socket-protocol";

describe("client frames", () => {
  it("SOCKET-RULE-001 accepts every frame a client may send", () => {
    expect(parseClientFrame(JSON.stringify({ type: "resume", since: 12 }))).toEqual({
      type: "resume",
      since: 12,
    });
    expect(parseClientFrame(JSON.stringify({ type: "read", channelId: "channel-1", sequence: 4 }))).toEqual(
      { type: "read", channelId: "channel-1", sequence: 4 },
    );
    expect(
      parseClientFrame(JSON.stringify({ type: "thread_read", threadRootId: "message-1", sequence: 2 })),
    ).toEqual({ type: "thread_read", threadRootId: "message-1", sequence: 2 });
    expect(parseClientFrame(JSON.stringify({ type: "typing", channelId: "channel-1" }))).toEqual({
      type: "typing",
      channelId: "channel-1",
    });
  });

  it("SOCKET-RULE-002 refuses anything that is not one of those shapes", () => {
    for (const raw of [
      "",
      "not json",
      "[]",
      "null",
      '"a string"',
      JSON.stringify({ type: "unknown" }),
      JSON.stringify({}),
    ]) {
      expect(parseClientFrame(raw).type, raw).toBe("invalid");
    }
    expect(parseClientFrame(null).type).toBe("invalid");
    expect(parseClientFrame({ type: "typing" }).type).toBe("invalid");
  });

  it("SOCKET-RULE-003 refuses a malformed identifier or sequence", () => {
    const cases = [
      { type: "resume", since: -1 },
      { type: "resume", since: 1.5 },
      { type: "resume" },
      { type: "read", channelId: "channel-1" },
      { type: "read", channelId: "has space", sequence: 1 },
      { type: "read", channelId: "", sequence: 1 },
      { type: "read", channelId: "-leading", sequence: 1 },
      { type: "read", channelId: "channel-1", sequence: -2 },
      { type: "thread_read", threadRootId: "message-1" },
      { type: "typing", channelId: 7 },
    ];
    for (const frame of cases) {
      expect(parseClientFrame(JSON.stringify(frame)).type, JSON.stringify(frame)).toBe("invalid");
    }
  });

  it("SOCKET-RULE-004 refuses a frame larger than the cap without parsing it", () => {
    const oversized = JSON.stringify({ type: "typing", channelId: "c".repeat(MAX_CLIENT_FRAME_BYTES) });
    expect(oversized.length).toBeGreaterThan(MAX_CLIENT_FRAME_BYTES);
    expect(parseClientFrame(oversized)).toEqual({ type: "invalid", reason: "frame is too large" });
  });

  it("SOCKET-RULE-005 carries no actor: a frame never says who is acting", () => {
    const frame = parseClientFrame(
      JSON.stringify({ type: "read", channelId: "channel-1", sequence: 4, memberId: "member-other" }),
    );
    expect(frame).toEqual({ type: "read", channelId: "channel-1", sequence: 4 });
    expect(JSON.stringify(frame)).not.toContain("member-other");
  });

  it("SOCKET-RULE-006 keeps the keepalive pair out of the frame grammar", () => {
    // Ping and pong are answered by the runtime, so they are never parsed here.
    expect(parseClientFrame(SOCKET_PING).type).toBe("invalid");
    expect(SOCKET_PONG).not.toBe(SOCKET_PING);
  });

  it("SOCKET-RULE-007 encodes a server frame as one JSON line", () => {
    expect(encodeServerFrame({ type: "reset", reason: "replay window has expired" })).toBe(
      '{"type":"reset","reason":"replay window has expired"}',
    );
  });
});
