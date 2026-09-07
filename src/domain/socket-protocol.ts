/**
 * The realtime frame contract.
 *
 * Parsing is pure and total: every frame a client can send is either one of the
 * shapes below or an explicit rejection with a reason. A socket frame is
 * untrusted input that arrives after authentication, so it decides nothing about
 * who is acting — the object takes that from the socket's own attachment.
 */

/** Handled by the runtime's auto-response, so a keepalive never wakes the object. */
export const SOCKET_PING = "ping";
export const SOCKET_PONG = "pong";

export const MAX_CLIENT_FRAME_BYTES = 4_096;

export type ClientFrame =
  | { type: "resume"; since: number }
  | { type: "read"; channelId: string; sequence: number }
  | { type: "thread_read"; threadRootId: string; sequence: number }
  | { type: "typing"; channelId: string };

export type ParsedClientFrame = ClientFrame | { type: "invalid"; reason: string };

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function identifier(value: unknown): string | null {
  return typeof value === "string" && ID.test(value) ? value : null;
}

function sequence(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function parseClientFrame(raw: unknown): ParsedClientFrame {
  if (typeof raw !== "string") return { type: "invalid", reason: "frame must be text" };
  if (raw.length > MAX_CLIENT_FRAME_BYTES) return { type: "invalid", reason: "frame is too large" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { type: "invalid", reason: "frame is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { type: "invalid", reason: "frame must be an object" };
  }

  const frame = parsed as Record<string, unknown>;
  switch (frame.type) {
    case "resume": {
      const since = sequence(frame.since);
      return since === null
        ? { type: "invalid", reason: "resume needs a whole sequence number" }
        : { type: "resume", since };
    }
    case "read": {
      const channelId = identifier(frame.channelId);
      const value = sequence(frame.sequence);
      return channelId === null || value === null
        ? { type: "invalid", reason: "read needs a channel and a sequence" }
        : { type: "read", channelId, sequence: value };
    }
    case "thread_read": {
      const threadRootId = identifier(frame.threadRootId);
      const value = sequence(frame.sequence);
      return threadRootId === null || value === null
        ? { type: "invalid", reason: "thread_read needs a thread and a sequence" }
        : { type: "thread_read", threadRootId, sequence: value };
    }
    case "typing": {
      const channelId = identifier(frame.channelId);
      return channelId === null
        ? { type: "invalid", reason: "typing needs a channel" }
        : { type: "typing", channelId };
    }
    default:
      return { type: "invalid", reason: "unknown frame type" };
  }
}

export type ServerFrame =
  | { type: "welcome"; memberId: string; sequence: number; presence: readonly string[] }
  | { type: "event"; sequence: number; kind: string; channelId: string; payload: unknown }
  | { type: "read"; channelId: string; sequence: number }
  | { type: "thread_read"; threadRootId: string; sequence: number }
  | { type: "typing"; channelId: string; memberId: string; at: number }
  | { type: "presence"; memberId: string; online: boolean }
  /**
   * A vault decision addressed to one member rather than to a room.
   *
   * An approval's card is an ordinary message and arrives as a channel event
   * like any other. This carries the decision itself, which the person who
   * *asked* has no room to hear it in — their request was made from a CLI, not
   * from a conversation they are sitting in.
   */
  | { type: "vault"; kind: string; approvalId: string; payload: unknown }
  /** The client's cursor is older than the replay window; refetch current state. */
  | { type: "reset"; reason: string }
  | { type: "error"; reason: string };

export function encodeServerFrame(frame: ServerFrame): string {
  return JSON.stringify(frame);
}
