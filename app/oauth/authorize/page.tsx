import Link from "next/link";

import { ConsentForm } from "@/components/shell/consent-form";
import {
  authorizationRedirect,
  checkAuthorizationRequest,
  normaliseIssuer,
  workspaceSlugFromResource,
} from "@/src/domain/mcp-oauth";
import {
  oauthEnvironment,
  originFromHeaders,
  readOauthClient,
  resolveWorkspaceBySlug,
} from "@/src/shell/oauth-server";
import { readCsrfToken } from "@/src/shell/session-cookies";
import { headers } from "next/headers";
import { shellState } from "@/src/shell/shell-context";
import { redirect } from "next/navigation";

/**
 * The consent screen: the one moment in the whole protocol where a person, not
 * a rule, decides something.
 *
 * Everything a rule can decide has already been decided by the time this
 * renders, so the page shows only what somebody is actually being asked: which
 * client, which workspace, and what it will be able to do.
 */
export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const single = (name: string): string | null => {
    const value = params[name];
    if (typeof value === "string" && value.length > 0) return value;
    return null;
  };

  const env = await oauthEnvironment();
  if (env === null) {
    return <Refused reason="This deployment has no control plane configured." />;
  }

  const resource = single("resource");
  const slug = resource === null ? null : workspaceSlugFromResource(resource);
  if (slug === null) {
    return <Refused reason="That request did not name a workspace to connect to." />;
  }
  const workspace = await resolveWorkspaceBySlug(env, slug);
  if (workspace === null) return <Refused reason="That workspace is not available." />;

  const clientId = single("client_id");
  const client = clientId === null ? null : await readOauthClient(env, clientId);
  const checked = checkAuthorizationRequest({
    params: {
      response_type: single("response_type"),
      client_id: clientId,
      redirect_uri: single("redirect_uri"),
      code_challenge: single("code_challenge"),
      code_challenge_method: single("code_challenge_method"),
      resource,
      scope: single("scope"),
      state: single("state"),
    },
    client,
    expectedResource: resource as string,
  });

  const origin = await requestOriginFromHeaders();
  if (!checked.ok) {
    // A request that names a redirect we recognise is answered there, so the
    // waiting client sees a protocol error rather than a hung browser tab.
    if (checked.redirectable) {
      redirect(
        authorizationRedirect({
          redirectUri: single("redirect_uri") as string,
          issuer: origin,
          state: single("state"),
          error: checked.error,
          errorDescription: checked.description,
        }),
      );
    }
    return <Refused reason={checked.description} />;
  }

  const state = await shellState();
  if (state.status !== "ready") {
    const target = `/oauth/authorize?${new URLSearchParams(
      Object.entries(params).flatMap(([key, value]) =>
        typeof value === "string" ? [[key, value] as [string, string]] : [],
      ),
    ).toString()}`;
    return (
      <>
        <h1>Sign in to connect</h1>
        <p className="auth-intro">
          {client?.clientName ?? "An MCP client"} is asking to connect to a Lepidy workspace. Sign in
          first, and you will come straight back here.
        </p>
        <Link className="primary-link" href={`/signin?next=${encodeURIComponent(target)}`}>
          Go to sign in
        </Link>
      </>
    );
  }

  if (state.workspace.slug !== slug) {
    return (
      <Refused
        reason={`You are signed in to ${state.workspace.name}, and this request is for a different workspace.`}
      />
    );
  }

  return (
    <ConsentForm
      clientName={client?.clientName ?? "An unnamed MCP client"}
      workspaceName={state.workspace.name}
      viewerName={state.snapshot.viewer.displayName}
      scopes={checked.request.scope.split(" ")}
      redirectHost={new URL(checked.request.redirectUri).host}
      csrfToken={(await readCsrfToken()) ?? ""}
      request={{
        workspace: slug,
        issuer: normaliseIssuer(origin),
        response_type: "code",
        client_id: checked.request.clientId,
        redirect_uri: checked.request.redirectUri,
        code_challenge: checked.request.codeChallenge,
        code_challenge_method: "S256",
        resource: checked.request.resource,
        scope: checked.request.scope,
        state: checked.request.state ?? "",
      }}
    />
  );
}

function Refused({ reason }: { reason: string }) {
  return (
    <>
      <h1>That connection cannot be made</h1>
      <p className="auth-intro">{reason}</p>
      <p className="auth-footer">
        Nothing was connected. <Link href="/workspace">Go to your workspace</Link>
      </p>
    </>
  );
}

/**
 * The origin this page was reached at, which is the issuer every URI in the
 * response is built from. Derived exactly as the route handlers derive it, so
 * a code minted here is audience-bound to the same string the resource server
 * will compare against.
 */
async function requestOriginFromHeaders(): Promise<string> {
  const list = await headers();
  return originFromHeaders(list.get("host"), list.get("x-forwarded-proto"), "http://localhost");
}
