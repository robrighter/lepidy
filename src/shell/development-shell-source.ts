import type { MessagePage } from "../cloudflare/workspace-rooms";
import type { ShellState, WorkspaceShellSource } from "./workspace-shell-source";

/**
 * A deterministic workspace for local development and for the browser suite,
 * used only when `ENVIRONMENT` is `development` and no control-plane binding or
 * session is available. It reports `authenticated: false`, and the shell renders
 * a standing banner from that flag, so this content can never be mistaken for a
 * real workspace.
 */
export class DevelopmentShellSource implements WorkspaceShellSource {
  async load(): Promise<ShellState> {
    return {
      status: "ready",
      authenticated: false,
      workspace: {
        id: "workspace-development",
        slug: "development",
        name: "Development workspace",
        plan: "solo",
        jurisdiction: "global",
      },
      snapshot: {
        viewer: {
          memberId: "member-development",
          handle: "maya",
          displayName: "Maya Chen",
          role: "owner",
          authorizationEpoch: 1,
        },
        channels: [
          { id: "channel-eng", kind: "public", slug: "eng", name: "Engineering", isMember: true },
          { id: "channel-release", kind: "public", slug: "release", name: "Release", isMember: true },
          { id: "channel-design", kind: "private", slug: "design", name: "Design", isMember: true },
        ],
        agents: [
          { id: "agent-releasebot", handle: "a.releasebot", displayName: "Release Bot", status: "active" },
          { id: "agent-triage", handle: "a.triage", displayName: "Triage", status: "active" },
        ],
        storageMode: "local_host",
        schemaVersion: 8,
      },
    };
  }
}

const DEVELOPMENT_MESSAGES: Record<string, MessagePage> = {
  "channel-eng": {
    messages: [
      {
        id: "message-dev-1",
        channelId: "channel-eng",
        threadRootId: null,
        authorKind: "member",
        authorId: "member-development",
        authorDisplaySnapshot: "Maya Chen",
        bodyMarkdown: "Rolling the failed-charge retry out behind a flag this afternoon.",
        createdAt: 1_800_000_000_000,
        editedAt: null,
        deletedAt: null,
        channelSequence: 1,
        replyCount: 2,
        lastReplyAt: 1_800_000_060_000,
      },
      {
        id: "message-dev-2",
        channelId: "channel-eng",
        threadRootId: null,
        authorKind: "agent",
        authorId: "agent-releasebot",
        authorDisplaySnapshot: "a.releasebot",
        bodyMarkdown: "Deploy `api@2.14.0` finished. 3 migrations applied, no rollbacks.",
        createdAt: 1_800_000_120_000,
        editedAt: null,
        deletedAt: null,
        channelSequence: 2,
        replyCount: 0,
        lastReplyAt: null,
      },
    ],
    nextCursor: null,
  },
};

/** Fixture history for the development workspace only. */
export function developmentChannelHistory(channelId: string): MessagePage {
  return DEVELOPMENT_MESSAGES[channelId] ?? { messages: [], nextCursor: null };
}
