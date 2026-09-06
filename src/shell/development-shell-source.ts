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
        schemaVersion: 7,
      },
    };
  }
}
