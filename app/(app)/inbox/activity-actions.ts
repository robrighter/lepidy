"use server";

import { revalidatePath } from "next/cache";
import { isFailure, viewerWorkspace } from "@/src/shell/viewer-workspace";

export async function markNotificationAction(form: FormData): Promise<void> {
  const field = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  const workspace = await viewerWorkspace(field("csrfToken"));
  if (isFailure(workspace)) return;
  await workspace.stub.markNotification({
    actor: workspace.actor,
    notificationId: field("notificationId"),
    unread: field("unread") === "true",
    now: Date.now(),
  });
  revalidatePath("/inbox");
  revalidatePath("/");
}

function parseMinute(value: string): number | null {
  if (value === "") return null;
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error("invalid time");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error("invalid time");
  return hour * 60 + minute;
}

export async function configureNotificationsAction(form: FormData): Promise<void> {
  const field = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  const workspace = await viewerWorkspace(field("csrfToken"));
  if (isFailure(workspace)) return;
  const channelId = field("channelId");
  const start = parseMinute(field("dndStart"));
  const end = parseMinute(field("dndEnd"));
  await workspace.stub.configureNotifications({
    actor: workspace.actor,
    ...(channelId ? { channelId, notifyLevel: field("notifyLevel") as "everything" | "mentions" | "nothing" | "mute" } : {}),
    keywords: field("keywords").split(",").map((value) => value.trim()).filter(Boolean),
    dndStartMinute: start,
    dndEndMinute: end,
    now: Date.now(),
  });
  revalidatePath("/inbox");
}
