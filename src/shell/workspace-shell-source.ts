import type { Workspace, WorkspaceShellSnapshot } from "../cloudflare/workspace";

/**
 * The data the shell renders. The layout depends on this shape, never on where
 * it came from, so the same rail works against the control plane, a development
 * workspace, or a future offline cache.
 */
export type ShellWorkspace = {
  id: string;
  slug: string;
  name: string;
  plan: "solo" | "team";
  jurisdiction: "global" | "eu";
};

export type ShellData = {
  workspace: ShellWorkspace;
  snapshot: WorkspaceShellSnapshot;
  /** True when the data came from a real control-plane session. */
  authenticated: boolean;
};

export type ShellState =
  | ({ status: "ready" } & ShellData)
  | { status: "signed_out" }
  | { status: "unavailable"; reason: string };

export type WorkspaceShellSource = { load(): Promise<ShellState> };

export type ControlPlaneShellDeps = {
  db: D1Database;
  workspaces: DurableObjectNamespace<Workspace>;
  authenticateSession: (token: string) => Promise<{ accountId: string }>;
};

export type WorkspaceRow = {
  id: string;
  slug: string;
  name: string;
  plan: "solo" | "team";
  jurisdiction: "global" | "eu";
  durable_object_id: string;
  member_id: string;
  authorization_epoch: number;
  /** The account behind the membership, for ceremonies that live in the control plane. */
  account_id: string;
};

/**
 * Resolves the viewer's workspace from the real control plane and asks that
 * workspace object what this member may see. Authority is never taken from the
 * request: the session names an account, D1 names its active membership, and the
 * object rechecks the membership epoch before returning anything.
 */
/**
 * Resolve the one workspace a session speaks for. Shared by every server-side
 * reader so the session, the membership and the object id are looked up the same
 * way once, rather than each surface inventing its own path to authority.
 */
export async function resolveViewerWorkspace(
  deps: ControlPlaneShellDeps,
  sessionToken: string | null,
  workspaceSlug: string | null = null,
): Promise<
  { status: "ok"; row: WorkspaceRow } | { status: "signed_out" } | { status: "unavailable"; reason: string }
> {
  if (!sessionToken) return { status: "signed_out" };

  let accountId: string;
  try {
    ({ accountId } = await deps.authenticateSession(sessionToken));
  } catch {
    return { status: "signed_out" };
  }

  const base = `SELECT w.id, w.slug, w.name, w.plan, w.jurisdiction, w.durable_object_id,
                       m.member_id, m.authorization_epoch, m.account_id
                FROM memberships m
                JOIN workspaces w ON w.id = m.workspace_id
                WHERE m.account_id = ? AND m.status = 'active' AND w.status = 'active'`;
  const statement = workspaceSlug
    ? deps.db.prepare(`${base} AND w.slug = ?`).bind(accountId, workspaceSlug)
    : deps.db.prepare(`${base} ORDER BY m.created_at LIMIT 1`).bind(accountId);
  const row = await statement.first<WorkspaceRow>();
  if (!row) return { status: "unavailable", reason: "no active workspace membership" };
  return { status: "ok", row };
}

export class ControlPlaneShellSource implements WorkspaceShellSource {
  constructor(
    private readonly deps: ControlPlaneShellDeps,
    private readonly sessionToken: string | null,
    private readonly workspaceSlug: string | null = null,
  ) {}

  async load(): Promise<ShellState> {
    const resolved = await resolveViewerWorkspace(this.deps, this.sessionToken, this.workspaceSlug);
    if (resolved.status !== "ok") return resolved;
    const row = resolved.row;

    try {
      const stub = this.deps.workspaces.get(this.deps.workspaces.idFromString(row.durable_object_id));
      const snapshot = await stub.shellSnapshot({
        memberId: row.member_id,
        authorizationEpoch: row.authorization_epoch,
      });
      return {
        status: "ready",
        authenticated: true,
        workspace: {
          id: row.id,
          slug: row.slug,
          name: row.name,
          plan: row.plan,
          jurisdiction: row.jurisdiction,
        },
        snapshot,
      };
    } catch (error) {
      // A revoked member, a quarantined workspace or an unreachable object are
      // all states the shell must render honestly rather than crash on.
      return { status: "unavailable", reason: shellErrorReason(error) };
    }
  }
}

/** Bounded and free of identifiers a workspace should not disclose to a viewer. */
export function shellErrorReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replaceAll(/\s+/g, " ").trim().slice(0, 160);
}
