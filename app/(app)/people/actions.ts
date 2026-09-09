"use server";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { AdministrationService } from "@/src/control/administration";
import type { WorkspaceRole } from "@/src/domain/people";
import type { ShellEnvironment } from "@/src/shell/resolve-shell-source";
import { isFailure, shellErrorReason, viewerWorkspace, type ViewerWorkspace } from "@/src/shell/viewer-workspace";

const field = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

function minute(value: string): number | null {
  if (!value) return null;
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return Number.NaN;
  return Number(match[1]) * 60 + Number(match[2]);
}

async function finish(path: string, task: () => Promise<string>): Promise<never> {
  let notice: string;
  try {
    notice = await task();
    revalidatePath("/people");
    revalidatePath("/profile");
  } catch (error) {
    notice = shellErrorReason(error);
  }
  redirect(`${path}?notice=${encodeURIComponent(notice)}`);
}

export async function saveProfileAction(form: FormData): Promise<never> {
  return finish("/profile", async () => {
    const workspace = await viewerWorkspace(field(form, "csrfToken"));
    if (isFailure(workspace)) throw new Error(workspace.reason);
    await workspace.stub.updateOwnProfile({
      actor: workspace.actor,
      displayName: field(form, "displayName"),
      title: field(form, "title"),
      timezone: field(form, "timezone"),
      workingStartMinute: minute(field(form, "workingStart")),
      workingEndMinute: minute(field(form, "workingEnd")),
      customStatus: field(form, "customStatus"),
      availability: field(form, "availability"),
      now: Date.now(),
    });
    return "Profile saved.";
  });
}

export async function createGroupAction(form: FormData): Promise<never> {
  return finish("/people", async () => {
    const workspace = await viewerWorkspace(field(form, "csrfToken"));
    if (isFailure(workspace)) throw new Error(workspace.reason);
    await workspace.stub.createGroup({
      actor: workspace.actor,
      idempotencyKey: field(form, "idempotencyKey"),
      handle: field(form, "handle"),
      displayName: field(form, "displayName"),
      description: field(form, "description"),
      memberIds: form.getAll("memberId").filter((value): value is string => typeof value === "string"),
      now: Date.now(),
    });
    return "Group created.";
  });
}

export async function replaceGroupMembersAction(form: FormData): Promise<never> {
  return finish("/people", async () => {
    const workspace = await viewerWorkspace(field(form, "csrfToken"));
    if (isFailure(workspace)) throw new Error(workspace.reason);
    await workspace.stub.replaceGroupMembers({
      actor: workspace.actor,
      groupId: field(form, "groupId"),
      memberIds: form.getAll("memberId").filter((value): value is string => typeof value === "string"),
      now: Date.now(),
    });
    return "Group membership saved.";
  });
}

export async function archiveGroupAction(form: FormData): Promise<never> {
  return finish("/people", async () => {
    const workspace = await viewerWorkspace(field(form, "csrfToken"));
    if (isFailure(workspace)) throw new Error(workspace.reason);
    await workspace.stub.archiveGroup({ actor: workspace.actor, groupId: field(form, "groupId"), now: Date.now() });
    return "Group archived. Old mentions remain plain text.";
  });
}

async function administration(form: FormData): Promise<{ workspace: ViewerWorkspace; service: AdministrationService }> {
  const workspace = await viewerWorkspace(field(form, "csrfToken"));
  if (isFailure(workspace)) throw new Error(workspace.reason);
  const env = (await getCloudflareContext({ async: true })).env as ShellEnvironment;
  if (!env.CONTROL_DB || !env.WORKSPACE) throw new Error("This deployment has no control plane configured.");
  return { workspace, service: new AdministrationService(env.CONTROL_DB, env.WORKSPACE) };
}

export async function inviteMemberAction(form: FormData): Promise<never> {
  return finish("/people", async () => {
    const { workspace, service } = await administration(form);
    const role = field(form, "role") as Exclude<WorkspaceRole, "owner">;
    if (!(["admin", "member", "guest"] as const).includes(role)) throw new Error("invitation role is invalid");
    const invite = await service.inviteMember({
      workspaceId: workspace.workspaceId,
      invitedByMemberId: workspace.actor.memberId,
      email: field(form, "email"),
      role,
    });
    return invite.heldForPlan ? "Invitation held until an administrator confirms the seat change." : "Invitation created for delivery.";
  });
}

export async function invitationAction(form: FormData): Promise<never> {
  return finish("/people", async () => {
    const { workspace, service } = await administration(form);
    const action = field(form, "intent");
    if (action === "cancel") {
      await service.revokeInvitation(workspace.workspaceId, workspace.actor.memberId, field(form, "invitationId"));
      return "Invitation canceled.";
    }
    if (action === "confirm_plan") {
      await service.confirmInvitationPlan(workspace.workspaceId, workspace.actor.memberId, field(form, "invitationId"));
      return "Seat change confirmed; the invitation is ready for delivery.";
    }
    throw new Error("invitation action is invalid");
  });
}

export async function administerMemberAction(form: FormData): Promise<never> {
  return finish("/people", async () => {
    const { workspace, service } = await administration(form);
    const intent = field(form, "intent");
    if (intent === "transfer") {
      await service.transferOwnership({
        workspaceId: workspace.workspaceId,
        actorMemberId: workspace.actor.memberId,
        targetMemberId: field(form, "memberId"),
        confirmation: field(form, "confirmation"),
      });
      return "Workspace ownership transferred.";
    }
    const role = field(form, "role") as WorkspaceRole;
    await service.administerMember({
      workspaceId: workspace.workspaceId,
      actorMemberId: workspace.actor.memberId,
      memberId: field(form, "memberId"),
      ...(intent === "role" ? { role } : { status: intent === "restore" ? "active" : "removed" }),
    });
    return intent === "role" ? "Role updated." : intent === "restore" ? "Member restored." : "Member offboarded and active authority revoked.";
  });
}
