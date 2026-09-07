"use server";

import { redirect } from "next/navigation";

import { authorizationRedirect, checkAuthorizationRequest, normaliseIssuer } from "@/src/domain/mcp-oauth";
import { oauthEnvironment, readOauthClient, resolveWorkspaceBySlug } from "@/src/shell/oauth-server";
import { isFailure, viewerWorkspace } from "@/src/shell/viewer-workspace";

export type ConsentState = { reason: string } | null;

/**
 * Record a person's decision about one authorization request.
 *
 * Nothing the form carries is trusted. The request is validated again here from
 * the client registry and the workspace, exactly as the page validated it to
 * decide what to show — because between rendering and submitting, a
 * registration can change and a person's membership can end. The form's fields
 * say what is being decided; they never say that it was allowed.
 */
export async function decideAuthorization(
  _previous: ConsentState,
  form: FormData,
): Promise<ConsentState> {
  const field = (name: string): string | null => {
    const value = form.get(name);
    return typeof value === "string" && value.length > 0 ? value : null;
  };

  const env = await oauthEnvironment();
  if (env === null) return { reason: "This deployment has no control plane configured." };

  const workspaceSlug = field("workspace");
  if (workspaceSlug === null) return { reason: "That request did not name a workspace." };
  const workspace = await resolveWorkspaceBySlug(env, workspaceSlug);
  if (workspace === null) return { reason: "That workspace is not available." };

  const clientId = field("client_id");
  const client = clientId === null ? null : await readOauthClient(env, clientId);
  const expectedResource = field("resource") ?? "";
  const params = {
    response_type: field("response_type"),
    client_id: clientId,
    redirect_uri: field("redirect_uri"),
    code_challenge: field("code_challenge"),
    code_challenge_method: field("code_challenge_method"),
    resource: expectedResource,
    scope: field("scope"),
    state: field("state"),
  };
  const checked = checkAuthorizationRequest({ params, client, expectedResource });
  if (!checked.ok) {
    // A refusal that cannot be reported by redirecting is shown here instead.
    if (!checked.redirectable) return { reason: checked.description };
    redirect(
      authorizationRedirect({
        redirectUri: params.redirect_uri as string,
        issuer: field("issuer") ?? "",
        state: params.state,
        error: checked.error,
        errorDescription: checked.description,
      }),
    );
  }

  const viewer = await viewerWorkspace(field("csrfToken") ?? undefined);
  if (isFailure(viewer)) return { reason: viewer.reason };
  // A person may only authorize the workspace they are actually in. The URL
  // named a workspace; the session names a membership; they have to be the
  // same one.
  if (viewer.workspaceId !== (await workspaceId(env, workspaceSlug))) {
    return { reason: "You are not a member of that workspace." };
  }

  const issuer = normaliseIssuer(field("issuer") ?? "");
  if (field("decision") !== "approve") {
    redirect(
      authorizationRedirect({
        redirectUri: checked.request.redirectUri,
        issuer,
        state: checked.request.state,
        error: "access_denied",
        errorDescription: "the request was declined",
      }),
    );
  }

  const authorized = await viewer.stub.beginOauthAuthorization({
    actor: viewer.actor,
    workspaceSlug: workspace.slug,
    clientId: checked.request.clientId,
    clientName: client?.clientName ?? null,
    redirectUri: checked.request.redirectUri,
    codeChallenge: checked.request.codeChallenge,
    scope: checked.request.scope,
    resource: checked.request.resource,
    now: Date.now(),
  });
  if (!authorized.ok) {
    redirect(
      authorizationRedirect({
        redirectUri: checked.request.redirectUri,
        issuer,
        state: checked.request.state,
        error: authorized.error,
        errorDescription: authorized.description,
      }),
    );
  }

  redirect(
    authorizationRedirect({
      redirectUri: checked.request.redirectUri,
      issuer,
      code: authorized.code,
      state: checked.request.state,
    }),
  );
}

async function workspaceId(
  env: NonNullable<Awaited<ReturnType<typeof oauthEnvironment>>>,
  slug: string,
): Promise<string | null> {
  const row = await env.db
    .prepare("SELECT id FROM workspaces WHERE slug = ?")
    .bind(slug)
    .first<{ id: string }>();
  return row?.id ?? null;
}
