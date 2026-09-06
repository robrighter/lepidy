"use server";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

import { AuthorizationService } from "@/src/control/authorization";
import { SESSION_COOKIE, type ShellEnvironment } from "@/src/shell/resolve-shell-source";
import {
  resolveViewerWorkspace,
  shellErrorReason,
} from "@/src/shell/workspace-shell-source";
import { parseIdempotencyKey } from "@/src/domain/idempotency-key";

export type SendResult = { ok: true; messageId: string } | { ok: false; reason: string };

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
    const sent = await stub.sendMessage({
      actor: {
        memberId: resolved.row.member_id,
        authorizationEpoch: resolved.row.authorization_epoch,
      },
      idempotencyKey: key,
      channelId: input.channelId,
      bodyMarkdown: input.bodyMarkdown,
      threadParentId: input.threadParentId ?? null,
      now: Date.now(),
    });
    revalidatePath("/c/[channel]", "page");
    return { ok: true, messageId: sent.messageId };
  } catch (error) {
    return { ok: false, reason: shellErrorReason(error) };
  }
}
