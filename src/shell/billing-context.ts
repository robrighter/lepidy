import { getCloudflareContext } from "@opennextjs/cloudflare";
import { cache } from "react";
import { BillingManagementService, type BillingSnapshot } from "../control/billing-management";
import type { ShellEnvironment } from "./resolve-shell-source";
import { workspaceDirectory } from "./people-context";
import { shellErrorReason } from "./viewer-workspace";

export type BillingState = { status: "ready"; workspaceId: string; memberId: string; snapshot: BillingSnapshot } | { status: "signed_out" } | { status: "unavailable"; reason: string };

export const workspaceBilling = cache(async (): Promise<BillingState> => {
  const directory = await workspaceDirectory();
  if (directory.status !== "ready") return directory;
  try {
    const env = (await getCloudflareContext({ async: true })).env as ShellEnvironment;
    if (!env.CONTROL_DB) return { status: "unavailable", reason: "This deployment has no billing storage configured." };
    const snapshot = await new BillingManagementService(env.CONTROL_DB).snapshot(directory.workspaceRowId, directory.viewerMemberId);
    snapshot.usedStorageBytes = (await env.WORKSPACE?.get(env.WORKSPACE.idFromString(directory.durableObjectId)).storageStatus({ actor: { memberId: directory.viewerMemberId, authorizationEpoch: directory.authorizationEpoch } }))?.usedBytes ?? 0;
    return { status: "ready", workspaceId: directory.workspaceRowId, memberId: directory.viewerMemberId, snapshot };
  } catch (error) {
    return { status: "unavailable", reason: shellErrorReason(error) };
  }
});
