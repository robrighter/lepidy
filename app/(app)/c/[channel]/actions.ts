"use server";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

import { AuthorizationService } from "@/src/control/authorization";
import { StorageEntitlementService } from "@/src/control/storage-entitlement";
import { SESSION_COOKIE, type ShellEnvironment } from "@/src/shell/resolve-shell-source";
import {
  resolveViewerWorkspace,
  shellErrorReason,
} from "@/src/shell/workspace-shell-source";
import { parseIdempotencyKey } from "@/src/domain/idempotency-key";

export type SendResult =
  | { ok: true; messageId: string }
  | { ok: true; acted: "join" | "leave" | "archive" }
  | { ok: false; reason: string };

/**
 * Post a message as the signed-in viewer.
 *
 * The actor is taken from the session cookie, never from the form: a client may
 * say what it wants to send, and nothing about who is sending it. Authorization,
 * the plan-authority check and idempotency all live in the workspace object;
 * this only carries the request to it.
 */
export async function sendChannelMessage(input: {
  csrfToken?: string;
  channelId: string;
  bodyMarkdown: string;
  idempotencyKey: string;
  threadParentId?: string | null;
  confirmedBroadcastRecipients?: number;
  fileIds?: readonly string[];
}): Promise<SendResult> {
  const key = parseIdempotencyKey(input.idempotencyKey);
  if (key === null) return { ok: false, reason: "invalid request key" };

  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  if (!token) return { ok: false, reason: "Sign in to post in this channel." };

  let env: ShellEnvironment = {};
  try {
    env = (await getCloudflareContext({ async: true })).env as ShellEnvironment;
  } catch {
    env = {};
  }
  if (!env.CONTROL_DB || !env.WORKSPACE) {
    return { ok: false, reason: "This deployment has no workspace storage configured." };
  }

  const authorization = new AuthorizationService(env.CONTROL_DB, env.WORKSPACE);
  const resolved = await resolveViewerWorkspace(
    {
      db: env.CONTROL_DB,
      workspaces: env.WORKSPACE,
      authenticateSession: (value) => authorization.authenticateBrowserSession(value, input.csrfToken ?? ""),
    },
    token,
  );
  if (resolved.status !== "ok") {
    return { ok: false, reason: "Sign in to post in this channel." };
  }

  try {
    const stub = env.WORKSPACE.get(env.WORKSPACE.idFromString(resolved.row.durable_object_id));
    // Whatever was typed goes through the composer entry point, so a slash
    // command reaches exactly the authority the equivalent button would.
    const outcome = await stub.runComposerInput({
      actor: {
        memberId: resolved.row.member_id,
        authorizationEpoch: resolved.row.authorization_epoch,
      },
      idempotencyKey: key,
      channelId: input.channelId,
      raw: input.bodyMarkdown,
      threadParentId: input.threadParentId ?? null,
      confirmedBroadcastRecipients: input.confirmedBroadcastRecipients,
      now: Date.now(),
    });
    // Files bind to the message only once it exists, and only files this
    // person uploaded to this same room are accepted.
    if (outcome.kind === "sent" && input.fileIds && input.fileIds.length > 0) {
      await stub.attachFilesToMessage({
        actor: { memberId: resolved.row.member_id, authorizationEpoch: resolved.row.authorization_epoch },
        messageId: outcome.messageId,
        fileIds: input.fileIds,
        now: Date.now(),
      });
    }
    revalidatePath("/c/[channel]", "page");
    if (outcome.kind === "rejected") return { ok: false, reason: outcome.reason };
    if (outcome.kind === "acted") return { ok: true, acted: outcome.command };
    return { ok: true, messageId: outcome.messageId };
  } catch (error) {
    return { ok: false, reason: shellErrorReason(error) };
  }
}

export type ReservedUpload =
  | { ok: true; fileId: string; expiresAt: number; warn: boolean }
  | { ok: false; reason: string };

/**
 * Step one of attaching a file: the authority decides, then the browser sends
 * the bytes to `/files/<id>`. The action never carries the bytes themselves.
 */
export async function reserveAttachment(input: {
  csrfToken?: string;
  channelId: string;
  idempotencyKey: string;
  fileName: string;
  mediaType: string;
  byteLength: number;
}): Promise<ReservedUpload> {
  const key = parseIdempotencyKey(input.idempotencyKey);
  if (key === null) return { ok: false, reason: "invalid request key" };
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  if (!token) return { ok: false, reason: "Sign in to attach a file." };

  let env: ShellEnvironment = {};
  try {
    env = (await getCloudflareContext({ async: true })).env as ShellEnvironment;
  } catch {
    env = {};
  }
  if (!env.CONTROL_DB || !env.WORKSPACE) return { ok: false, reason: "This deployment has no workspace storage configured." };

  const authorization = new AuthorizationService(env.CONTROL_DB, env.WORKSPACE);
  const resolved = await resolveViewerWorkspace(
    {
      db: env.CONTROL_DB,
      workspaces: env.WORKSPACE,
      authenticateSession: (value) => authorization.authenticateBrowserSession(value, input.csrfToken ?? ""),
    },
    token,
  );
  if (resolved.status !== "ok") return { ok: false, reason: "Sign in to attach a file." };

  try {
    // The allowance is refreshed from D1 before it is spent, so a seat or pack
    // bought a minute ago is usable now rather than at the next projection.
    await new StorageEntitlementService(env.CONTROL_DB, env.WORKSPACE).project(resolved.row.id);
    const stub = env.WORKSPACE.get(env.WORKSPACE.idFromString(resolved.row.durable_object_id));
    const reserved = await stub.reserveUpload({
      actor: { memberId: resolved.row.member_id, authorizationEpoch: resolved.row.authorization_epoch },
      idempotencyKey: key,
      channelId: input.channelId,
      fileName: input.fileName,
      mediaType: input.mediaType,
      byteLength: input.byteLength,
      now: Date.now(),
    });
    return { ok: true, fileId: reserved.fileId, expiresAt: reserved.expiresAt, warn: reserved.warn };
  } catch (error) {
    return { ok: false, reason: shellErrorReason(error) };
  }
}
