import { getCloudflareContext } from "@opennextjs/cloudflare";
import { cookies } from "next/headers";
import { cache } from "react";

import type { StoredFile } from "../cloudflare/workspace";
import { AuthorizationService } from "../control/authorization";
import { StorageEntitlementService } from "../control/storage-entitlement";
import { SESSION_COOKIE, type ShellEnvironment } from "./resolve-shell-source";
import { resolveViewerWorkspace, shellErrorReason } from "./workspace-shell-source";

export type ChannelFiles = {
  files: readonly StoredFile[];
  /** Grouped for the renderer, which needs them per message rather than per room. */
  byMessage: ReadonlyMap<string, readonly StoredFile[]>;
};

const EMPTY: ChannelFiles = { files: [], byMessage: new Map() };

async function viewer(): Promise<
  | { ok: true; stub: ReturnType<NonNullable<ShellEnvironment["WORKSPACE"]>["get"]>; actor: { memberId: string; authorizationEpoch: number }; workspaceRowId: string; db: D1Database; workspaces: NonNullable<ShellEnvironment["WORKSPACE"]> }
  | { ok: false }
> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  if (!token) return { ok: false };
  let env: ShellEnvironment = {};
  try {
    env = (await getCloudflareContext({ async: true })).env as ShellEnvironment;
  } catch {
    return { ok: false };
  }
  if (!env.CONTROL_DB || !env.WORKSPACE) return { ok: false };
  const authorization = new AuthorizationService(env.CONTROL_DB, env.WORKSPACE);
  const resolved = await resolveViewerWorkspace(
    { db: env.CONTROL_DB, workspaces: env.WORKSPACE, authenticateSession: (value) => authorization.authenticateBrowserSession(value) },
    token,
  );
  if (resolved.status !== "ok") return { ok: false };
  return {
    ok: true,
    stub: env.WORKSPACE.get(env.WORKSPACE.idFromString(resolved.row.durable_object_id)),
    actor: { memberId: resolved.row.member_id, authorizationEpoch: resolved.row.authorization_epoch },
    workspaceRowId: resolved.row.id,
    db: env.CONTROL_DB,
    workspaces: env.WORKSPACE,
  };
}

/** Files in one room, as the signed-in reader is allowed to see them. */
export const channelFiles = cache(async (channelId: string): Promise<ChannelFiles> => {
  const context = await viewer();
  if (!context.ok) return EMPTY;
  try {
    const { files } = await context.stub.listFiles({ actor: context.actor, channelId, limit: 200 });
    const byMessage = new Map<string, StoredFile[]>();
    for (const file of files) {
      if (file.messageId === null) continue;
      const existing = byMessage.get(file.messageId);
      if (existing) existing.push(file);
      else byMessage.set(file.messageId, [file]);
    }
    return { files, byMessage };
  } catch {
    // A room whose files cannot be read still renders its messages.
    return EMPTY;
  }
});

/** The workspace's allowance and what it has spent, refreshed from D1 first. */
export const storageStatus = cache(async (): Promise<{ quotaBytes: number; usedBytes: number; warn: boolean } | null> => {
  const context = await viewer();
  if (!context.ok) return null;
  try {
    await new StorageEntitlementService(context.db, context.workspaces).project(context.workspaceRowId);
    return await context.stub.storageStatus({ actor: context.actor });
  } catch (error) {
    void shellErrorReason(error);
    return null;
  }
});
