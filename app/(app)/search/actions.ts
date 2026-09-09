"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { isFailure, shellErrorReason, viewerWorkspace } from "@/src/shell/viewer-workspace";

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function destination(query: string, notice: string): string {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  params.set("notice", notice);
  return `/search?${params}`;
}

export async function saveSearchAction(form: FormData): Promise<void> {
  const query = field(form, "query");
  const workspace = await viewerWorkspace(field(form, "csrfToken"));
  if (isFailure(workspace)) redirect(destination(query, workspace.reason));
  let notice = "Search saved.";
  try {
    await workspace.stub.saveSearch({
      actor: workspace.actor, idempotencyKey: field(form, "idempotencyKey"),
      name: field(form, "name"), query, now: Date.now(),
    });
    revalidatePath("/search");
  } catch (error) {
    notice = shellErrorReason(error);
  }
  redirect(destination(query, notice));
}

export async function deleteSearchAction(form: FormData): Promise<void> {
  const query = field(form, "query");
  const workspace = await viewerWorkspace(field(form, "csrfToken"));
  if (isFailure(workspace)) redirect(destination(query, workspace.reason));
  let notice = "Saved search removed.";
  try {
    const result = await workspace.stub.deleteSavedSearch({ actor: workspace.actor, searchId: field(form, "searchId") });
    if (!result.removed) notice = "That saved search was already gone.";
    revalidatePath("/search");
  } catch (error) {
    notice = shellErrorReason(error);
  }
  redirect(destination(query, notice));
}
