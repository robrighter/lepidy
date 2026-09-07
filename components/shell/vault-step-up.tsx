"use client";

import { KeyRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useState } from "react";

import {
  beginVaultStepUpAction,
  finishVaultStepUpAction,
  type VaultActionResult,
  type VaultSwitchOnAction,
} from "@/app/(app)/vault/actions";
import { browserCsrfToken } from "@/src/shell/browser-csrf";
import { useHydrated } from "./use-hydrated";

/**
 * Switching a protection back on.
 *
 * This is the only direction in the vault that asks for a person. Turning
 * something off is a plain form that works before this page has hydrated,
 * because that is the action somebody takes when they think something is wrong.
 * Turning it back on needs a verified gesture, which is a browser API and has
 * no pre-hydration equivalent — so the button says it is not ready rather than
 * pretending, and says when the account has no passkey to make one with.
 */
export function VaultStepUpSwitch({
  action,
  subjectId,
  label,
  hasPasskey,
}: {
  action: VaultSwitchOnAction;
  subjectId: string;
  label: string;
  hasPasskey: boolean;
}) {
  const hydrated = useHydrated();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function run() {
    setError(null);
    setBusy(true);
    try {
      const csrfToken = browserCsrfToken();
      const begun = await beginVaultStepUpAction({ csrfToken, action, subjectId });
      if (!begun.ok) {
        setError(begun.reason);
        return;
      }
      const assertion = (await navigator.credentials.get({
        publicKey: requestOptions(begun.options as RequestOptions),
      })) as PublicKeyCredential | null;
      if (assertion === null) {
        setError("That gesture was cancelled.");
        return;
      }
      const finished = await finishVaultStepUpAction({
        csrfToken,
        action,
        subjectId,
        challengeId: begun.challengeId,
        credentialId: assertion.id,
        response: serialiseAssertion(assertion),
      });
      if (!finished.ok) {
        setError(finished.reason ?? "That change could not be made.");
        return;
      }
      setDone(true);
      // Re-read from the workspace rather than trusting local state, but as an
      // ordinary refresh: a full reload tears the page down mid-flight and
      // aborts whatever request is still in the air, which the dev server
      // treats as a lost connection.
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That gesture could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" disabled={!hydrated || !hasPasskey || busy || done} onClick={() => void run()}>
        {label}
      </button>
      {!hasPasskey ? (
        <p className="approval-note">
          <KeyRound aria-hidden="true" size={14} /> Switching this back on needs a passkey on your account.
        </p>
      ) : !hydrated ? (
        <p className="approval-note">Switching this back on needs the page to finish loading.</p>
      ) : null}
      {error ? (
        <p className="message-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

type RequestOptions = {
  challenge: string;
  timeout?: number;
  rpId?: string;
  userVerification?: UserVerificationRequirement;
  allowCredentials?: { id: string; type: "public-key"; transports?: AuthenticatorTransport[] }[];
};

function requestOptions(options: RequestOptions): PublicKeyCredentialRequestOptions {
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

/**
 * Switching a protection off.
 *
 * A real `<form action>` posting to a server action, so a submission made
 * before this tree has hydrated is carried out rather than becoming a page
 * reload that does nothing. The protective direction has to be the one that
 * always works.
 */
export function VaultSwitchOffForm({
  action,
  csrfToken,
  fields,
  label,
}: {
  action: (previous: VaultActionResult | null, form: FormData) => Promise<VaultActionResult>;
  csrfToken: string;
  fields?: Readonly<Record<string, string>>;
  label: string;
}) {
  const [state, submit, pending] = useActionState<VaultActionResult | null, FormData>(action, null);
  return (
    <form action={submit}>
      <input type="hidden" name="csrfToken" value={csrfToken} />
      {Object.entries(fields ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <button type="submit" className="danger" disabled={pending}>
        {label}
      </button>
      {state && !state.ok && state.reason ? (
        <p className="message-error" role="alert">
          {state.reason}
        </p>
      ) : null}
    </form>
  );
}
