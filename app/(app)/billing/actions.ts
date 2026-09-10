"use server";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createStripeCheckout } from "@/src/cloudflare/stripe-checkout";
import { BillingManagementService } from "@/src/control/billing-management";
import type { ShellEnvironment } from "@/src/shell/resolve-shell-source";
import { isFailure, shellErrorReason, viewerWorkspace } from "@/src/shell/viewer-workspace";

const text = (form: FormData, name: string) => typeof form.get(name) === "string" ? String(form.get(name)) : "";
const number = (form: FormData, name: string) => Number(text(form, name));

export async function reviewBillingChangeAction(form: FormData): Promise<never> {
  let destination: string;
  try {
    const workspace = await viewerWorkspace(text(form, "csrfToken"));
    if (isFailure(workspace)) throw new Error(workspace.reason);
    const env = (await getCloudflareContext({ async: true })).env as ShellEnvironment;
    if (!env.CONTROL_DB) throw new Error("billing is unavailable");
    const storage = await workspace.stub.storageStatus({ actor: workspace.actor });
    const change = await new BillingManagementService(env.CONTROL_DB).requestChange({ workspaceId: workspace.workspaceId, memberId: workspace.actor.memberId, plan: text(form, "plan"), seats: number(form, "seats"), storagePacks: number(form, "storagePacks"), usedStorageBytes: storage.usedBytes });
    destination = `/billing?request=${encodeURIComponent(change.id)}`;
  } catch (error) {
    destination = `/billing?notice=${encodeURIComponent(shellErrorReason(error))}`;
  }
  redirect(destination);
}

export async function confirmBillingCheckoutAction(form: FormData): Promise<never> {
  let destination: string;
  try {
    const workspace = await viewerWorkspace(text(form, "csrfToken"));
    if (isFailure(workspace)) throw new Error(workspace.reason);
    const env = (await getCloudflareContext({ async: true })).env as ShellEnvironment;
    if (!env.CONTROL_DB) throw new Error("billing is unavailable");
    const service = new BillingManagementService(env.CONTROL_DB);
    const request = await service.pendingRequest(workspace.workspaceId, workspace.actor.memberId, text(form, "requestId"));
    if (!request) throw new Error("billing request expired; review the change again");
    const incoming = await headers();
    const host = incoming.get("host");
    if (!host) throw new Error("checkout origin is unavailable");
    const origin = `${incoming.get("x-forwarded-proto") ?? "https"}://${host}`;
    const checkout = await createStripeCheckout({ config: { secretKey: env.STRIPE_SECRET_KEY, teamPriceId: env.STRIPE_TEAM_PRICE_ID, extraSeatPriceId: env.STRIPE_EXTRA_SEAT_PRICE_ID, storagePackPriceId: env.STRIPE_STORAGE_PACK_PRICE_ID }, request, workspaceId: workspace.workspaceId, origin });
    await service.markSubmitted(workspace.workspaceId, request.id, checkout.id);
    destination = checkout.url;
  } catch (error) {
    destination = `/billing?notice=${encodeURIComponent(shellErrorReason(error))}`;
  }
  redirect(destination);
}
