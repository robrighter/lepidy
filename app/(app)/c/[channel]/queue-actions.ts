"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { parseIdempotencyKey } from "@/src/domain/idempotency-key";
import type { QueuePreset } from "@/src/domain/work-queues";
import { isFailure, shellErrorReason, viewerWorkspace, type ViewerWorkspace } from "@/src/shell/viewer-workspace";

export type QueueActionResult = { ok: true; messageId?: string } | { ok: false; reason: string };

async function run(csrfToken: string | undefined, work: (workspace: ViewerWorkspace) => Promise<{ messageId?: string } | void>): Promise<QueueActionResult> {
  const workspace = await viewerWorkspace(csrfToken);
  if (isFailure(workspace)) return workspace;
  try {
    const result = await work(workspace);
    revalidatePath("/c/[channel]", "page");
    return { ok: true, ...(result ?? {}) };
  } catch (error) {
    return { ok: false, reason: shellErrorReason(error) };
  }
}

export async function configureQueueAction(input: {
  csrfToken?: string;
  channelId: string;
  postMode?: "open" | "form";
  formDefinition?: unknown;
  sortMode?: "chronological" | "ranked";
  sortEmoji?: string | null;
  statuses?: unknown;
  mainStatusLabel?: string;
  preset?: QueuePreset;
}): Promise<QueueActionResult> {
  return run(input.csrfToken, async (workspace) => {
    await workspace.stub.configureWorkQueue({ actor: workspace.actor, ...input, now: Date.now() });
  });
}

export async function submitFormAction(input: {
  csrfToken?: string;
  channelId: string;
  idempotencyKey: string;
  values: Readonly<Record<string, unknown>>;
}): Promise<QueueActionResult> {
  const key = parseIdempotencyKey(input.idempotencyKey);
  if (key === null) return { ok: false, reason: "invalid request key" };
  return run(input.csrfToken, async (workspace) => {
    const sent = await workspace.stub.submitForm({ actor: workspace.actor, channelId: input.channelId, idempotencyKey: key, values: input.values, now: Date.now() });
    return { messageId: sent.messageId };
  });
}

export async function setItemStatusAction(input: {
  csrfToken?: string;
  messageId: string;
  statusId: string | null;
}): Promise<QueueActionResult> {
  return run(input.csrfToken, async (workspace) => {
    await workspace.stub.setItemStatus({ actor: workspace.actor, messageId: input.messageId, statusId: input.statusId, now: Date.now() });
  });
}

const formField = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

/** Progressive form path: native submission works before hydration and without scripting. */
export async function submitFormDataAction(form: FormData): Promise<never> {
  const channelId = formField(form, "channelId");
  const returnPath = formField(form, "returnPath").startsWith("/c/") ? formField(form, "returnPath") : "/";
  const key = parseIdempotencyKey(formField(form, "idempotencyKey"));
  let notice: string;
  try {
    if (key === null) throw new Error("invalid request key");
    const workspace = await viewerWorkspace(formField(form, "csrfToken"));
    if (isFailure(workspace)) throw new Error(workspace.reason);
    const values: Record<string, string | string[]> = {};
    for (const [name, raw] of form.entries()) {
      if (!name.startsWith("field:") || typeof raw !== "string") continue;
      const id = name.slice(6);
      const current = values[id];
      values[id] = current === undefined ? raw : Array.isArray(current) ? [...current, raw] : [current, raw];
    }
    const sent = await workspace.stub.submitForm({ actor: workspace.actor, channelId, idempotencyKey: key, values, now: Date.now() });
    revalidatePath("/c/[channel]", "page");
    redirect(`${returnPath}?notice=${encodeURIComponent("Entry submitted.")}#message-${sent.messageId}`);
  } catch (error) {
    // redirect() throws its own sentinel and must not be converted into a notice.
    if (typeof error === "object" && error !== null && "digest" in error) throw error;
    notice = shellErrorReason(error);
  }
  redirect(`${returnPath}?notice=${encodeURIComponent(notice)}`);
}
