"use client";

import { KeyRound, ShieldAlert } from "lucide-react";
import { useActionState, useState } from "react";

import {
  beginApprovalAllowAction,
  denyApprovalAction,
  finishApprovalAllowAction,
  type ApprovalsResult,
} from "@/app/(app)/inbox/actions";
import type { VaultApprovalCard } from "@/src/cloudflare/workspace";
import { windowLabel, type ApprovalWindow } from "@/src/domain/vault-approval";
import { useHydrated } from "./use-hydrated";

/**
 * The approval card, where the decision actually happens.
 *
 * Deny is a real `<form action>` and works before this component has hydrated,
 * because refusing has to be the thing that always works. Allow cannot: it needs
 * a WebAuthn assertion, which is a browser API and has no pre-hydration
 * equivalent — so those buttons say they are not ready yet rather than
 * pretending, which is the rule C01a sets for a surface that cannot work early.
 */
export function ApprovalInbox({
  approvals,
  csrfToken,
  hasPasskey,
}: {
  approvals: readonly VaultApprovalCard[];
  csrfToken: string;
  hasPasskey: boolean;
}) {
  const [state, denyAction, denying] = useActionState<ApprovalsResult | null, FormData>(
    denyApprovalAction,
    null,
  );
  const hydrated = useHydrated();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answered, setAnswered] = useState<readonly VaultApprovalCard[] | null>(null);
  const current = answered ?? state?.approvals ?? approvals;
  const decidable = current.filter((approval) => approval.viewerMayDecide);
  const waiting = current.filter((approval) => !approval.viewerMayDecide);

  async function allow(approval: VaultApprovalCard, window: ApprovalWindow) {
    setError(null);
    setBusy(`${approval.approvalId}:${window}`);
    try {
      const decisions = approval.items.map((item) => ({
        credentialId: item.credentialId,
        outcome: "allowed" as const,
        window: item.windows.includes(window) ? window : ("once" as const),
      }));
      const begun = await beginApprovalAllowAction({ csrfToken, approvalId: approval.approvalId, decisions });
      if (!begun.ok) {
        setError(begun.reason);
        return;
      }
      const assertion = await navigator.credentials.get({
        publicKey: publicKeyRequestOptions(begun.options as PublicKeyOptions),
      });
      if (assertion === null) {
        setError("That approval gesture was cancelled.");
        return;
      }
      const finished = await finishApprovalAllowAction({
        csrfToken,
        approvalId: approval.approvalId,
        decisions,
        challengeId: begun.challengeId,
        credentialId: assertion.id,
        response: serialiseAssertion(assertion as PublicKeyCredential),
      });
      if (!finished.ok) setError(finished.reason ?? "That request could not be allowed.");
      if (finished.approvals) setAnswered(finished.approvals);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That approval gesture could not be completed.");
    } finally {
      setBusy(null);
    }
  }

  if (current.length === 0) {
    return (
      <section className="empty-state">
        <h2>Nothing is waiting on you</h2>
        <p>Credential requests arrive here and as a direct message from @a.vault.</p>
      </section>
    );
  }

  return (
    <div className="approval-list">
      {error ? (
        <p className="message-error" role="alert">
          {error}
        </p>
      ) : null}
      {state && !state.ok && state.reason ? (
        <p className="message-error" role="alert">
          {state.reason}
        </p>
      ) : null}

      {decidable.map((approval) => (
        <article key={approval.approvalId} className="approval-card" aria-label={`Credential request from ${approval.requesterHandle}`}>
          <header>
            <h3>
              {approval.agentHandle ? `@${approval.agentHandle}` : `@${approval.requesterHandle}`} wants a credential
            </h3>
            {approval.items.some((item) => item.highRisk) ? (
              <p className="approval-risk">
                <ShieldAlert aria-hidden="true" size={16} /> High risk
              </p>
            ) : null}
          </header>
          <dl>
            <dt>Why</dt>
            <dd>{approval.reason}</dd>
            <dt>Who is asking</dt>
            <dd>
              @{approval.requesterHandle}
              {approval.agentHandle ? `, through @${approval.agentHandle}` : ""} · device {approval.deviceId} ·
              project {approval.projectId}
            </dd>
            <dt>What they get</dt>
            <dd>{deliveryLabel(approval.delivery)}</dd>
            <dt>Expires</dt>
            <dd>
              <time dateTime={new Date(approval.expiresAt).toISOString()}>
                {new Date(approval.expiresAt).toISOString()}
              </time>{" "}
              — no answer is a denial
            </dd>
          </dl>
          <ul className="approval-items">
            {approval.items.map((item) => (
              <li key={item.credentialId}>
                <strong>{item.name}</strong>
                {item.description ? <span> — {item.description}</span> : null}
              </li>
            ))}
          </ul>

          <div className="approval-actions">
            <form action={denyAction}>
              <input type="hidden" name="csrfToken" value={csrfToken} />
              <input type="hidden" name="approvalId" value={approval.approvalId} />
              <input
                type="hidden"
                name="decisions"
                value={JSON.stringify(
                  approval.items.map((item) => ({ credentialId: item.credentialId, outcome: "denied", window: "once" })),
                )}
              />
              <button type="submit" className="primary" disabled={denying}>
                Deny
              </button>
            </form>
            {allowWindows(approval).map((window) => (
              <button
                key={window}
                type="button"
                disabled={!hydrated || !hasPasskey || busy !== null}
                onClick={() => void allow(approval, window)}
              >
                Allow {windowLabel(window)}
              </button>
            ))}
          </div>
          {!hasPasskey ? (
            <p className="approval-note">
              <KeyRound aria-hidden="true" size={14} /> Allowing needs a passkey on this account. You can still deny.
            </p>
          ) : !hydrated ? (
            <p className="approval-note">Allowing needs this page to finish loading. Denying works now.</p>
          ) : null}
        </article>
      ))}

      {waiting.map((approval) => (
        <article key={approval.approvalId} className="approval-card waiting">
          <h3>Waiting on an owner</h3>
          <p>
            {approval.items.map((item) => item.name).join(", ")} — asked for {approval.reason}. Only the people who
            manage {approval.items.length === 1 ? "it" : "them"} can answer.
          </p>
        </article>
      ))}
    </div>
  );
}

/** Only the windows this credential's own policy permits, from the server. */
function allowWindows(approval: VaultApprovalCard): readonly ApprovalWindow[] {
  const shared: ApprovalWindow[] = ["once", "fifteen_minutes", "session"];
  return shared.filter((window) => approval.items.every((item) => item.windows.includes(window)));
}

function deliveryLabel(delivery: VaultApprovalCard["delivery"]): string {
  switch (delivery) {
    case "inject":
      return "Injected into the command's environment.";
    case "file":
      return "Written to an owner-only temporary file, removed when the command exits.";
    case "device_proxy":
      return "Used by a device to make the request; the value is not handed to the agent.";
    case "reveal":
      return "⚠️ Revealed into the model's context and written to a transcript on disk.";
  }
}

type PublicKeyOptions = {
  challenge: string;
  timeout?: number;
  rpId?: string;
  userVerification?: UserVerificationRequirement;
  allowCredentials?: { id: string; type: "public-key"; transports?: AuthenticatorTransport[] }[];
};

function publicKeyRequestOptions(options: PublicKeyOptions): PublicKeyCredentialRequestOptions {
  return {
    challenge: fromBase64Url(options.challenge),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options.rpId === undefined ? {} : { rpId: options.rpId }),
    ...(options.userVerification === undefined ? {} : { userVerification: options.userVerification }),
    allowCredentials: (options.allowCredentials ?? []).map((credential) => ({
      id: fromBase64Url(credential.id),
      type: "public-key" as const,
      ...(credential.transports === undefined ? {} : { transports: credential.transports }),
    })),
  };
}

function serialiseAssertion(credential: PublicKeyCredential) {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: toBase64Url(response.clientDataJSON),
      authenticatorData: toBase64Url(response.authenticatorData),
      signature: toBase64Url(response.signature),
      ...(response.userHandle ? { userHandle: toBase64Url(response.userHandle) } : {}),
    },
  };
}

function fromBase64Url(value: string): ArrayBuffer {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function toBase64Url(value: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
