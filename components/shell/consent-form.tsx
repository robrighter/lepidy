"use client";

import { useActionState } from "react";

import { decideAuthorization, type ConsentState } from "@/app/oauth/authorize/actions";

const SCOPE_MEANINGS: Record<string, string> = {
  "chat:read": "Read the rooms you can already see",
  "chat:write": "Post messages as you",
  agent: "Work the queues of agents you own",
  vault: "Ask for credentials you are allowed to use, with your approval each time",
};

/**
 * The consent screen's form.
 *
 * It submits through a server action rather than a click handler, so a decision
 * made before the page has hydrated is still carried out rather than silently
 * turned into a page reload.
 */
export function ConsentForm({
  clientName,
  workspaceName,
  viewerName,
  scopes,
  redirectHost,
  csrfToken,
  request,
}: {
  clientName: string;
  workspaceName: string;
  viewerName: string;
  scopes: readonly string[];
  redirectHost: string;
  csrfToken: string;
  request: Record<string, string>;
}) {
  const [state, formAction, pending] = useActionState<ConsentState, FormData>(decideAuthorization, null);

  return (
    <>
      <h1>Connect {clientName}?</h1>
      <p className="auth-intro">
        It will act as <strong>{viewerName}</strong> in <strong>{workspaceName}</strong>, and can do
        nothing you could not do yourself.
      </p>

      <ul className="consent-scopes">
        {scopes.map((scope) => (
          <li key={scope}>
            <code>{scope}</code>
            <span>{SCOPE_MEANINGS[scope] ?? "An unrecognised permission"}</span>
          </li>
        ))}
      </ul>

      <form action={formAction} className="auth-form consent-form">
        {Object.entries(request).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <input type="hidden" name="csrfToken" value={csrfToken} />
        <button type="submit" name="decision" value="approve" className="primary" disabled={pending}>
          {pending ? "Connecting" : "Connect"}
        </button>
        <button type="submit" name="decision" value="deny" disabled={pending}>
          Cancel
        </button>
        {state ? (
          <p className="auth-error" role="alert">
            {state.reason}
          </p>
        ) : null}
      </form>

      <p className="auth-footer">
        The code goes back to <strong>{redirectHost}</strong>. You can end this connection at any time
        from your profile.
      </p>
    </>
  );
}
