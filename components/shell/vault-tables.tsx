"use client";

import { useActionState } from "react";

import { revokeGrantAction, type VaultActionResult } from "@/app/(app)/vault/actions";
import type { VaultActivityRow, VaultGrantRow } from "@/src/cloudflare/workspace";

/**
 * The two tables the vault is really made of: what is live now, and what has
 * happened.
 *
 * Both keep the three parties apart — the person a credential was released to,
 * the agent operating under them, and whoever approved it. Collapsing those
 * into one "who" column is what makes an access log useless in the moment
 * somebody actually needs it.
 */

export function LiveGrants({
  grants,
  csrfToken,
  scope,
  emptyLabel = "No credential is released right now.",
}: {
  grants: readonly VaultGrantRow[];
  csrfToken: string;
  /** What the table was rendered for, so a revoke gets the same list back. */
  scope?: { credentialId?: string; agentId?: string };
  emptyLabel?: string;
}) {
  const [state, revoke, pending] = useActionState<VaultActionResult | null, FormData>(revokeGrantAction, null);
  const current = state?.grants ?? grants;

  if (current.length === 0) {
    return <p className="vault-empty">{emptyLabel}</p>;
  }

  return (
    <>
      {state && state.reason ? (
        <p className={state.ok ? "vault-empty" : "message-error"} role="alert">
          {state.reason}
        </p>
      ) : null}
      <div className="table-scroll">
        <table className="vault-table">
          <caption className="visually-hidden">Credentials released right now</caption>
          <thead>
            <tr>
              <th scope="col">Credential</th>
              <th scope="col">Who has it</th>
              <th scope="col">How</th>
              <th scope="col">Until</th>
              <th scope="col">
                <span className="visually-hidden">Revoke</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {current.map((grant) => (
              <tr key={grant.grantId}>
                <th scope="row">{grant.credentialName}</th>
                <td data-label="Who has it">
                  {grant.agentHandle ? (
                    <>
                      <strong>@{grant.agentHandle}</strong> <span className="via">via @{grant.memberHandle}</span>
                    </>
                  ) : (
                    <strong>@{grant.memberHandle}</strong>
                  )}
                  <span className="via"> · approved by @{grant.approverHandle}</span>
                </td>
                <td data-label="How">
                  {deliveryLabel(grant.delivery)} · {grant.deviceId} · {grant.projectId}
                </td>
                <td data-label="Until">
                  {grant.singleUse ? (
                    "one use"
                  ) : (
                    <time dateTime={new Date(grant.expiresAt ?? 0).toISOString()}>
                      {new Date(grant.expiresAt ?? 0).toISOString()}
                    </time>
                  )}
                </td>
                <td>
                  {grant.viewerMayRevoke ? (
                    <form action={revoke}>
                      <input type="hidden" name="csrfToken" value={csrfToken} />
                      <input type="hidden" name="grantId" value={grant.grantId} />
                      <input type="hidden" name="credentialId" value={scope?.credentialId ?? ""} />
                      <input type="hidden" name="agentId" value={scope?.agentId ?? ""} />
                      <button type="submit" disabled={pending}>
                        Revoke
                      </button>
                    </form>
                  ) : (
                    <span className="via">an owner can revoke this</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function ActivityLog({ activity }: { activity: readonly VaultActivityRow[] }) {
  if (activity.length === 0) {
    return <p className="vault-empty">Nothing has happened yet.</p>;
  }
  return (
    <div className="table-scroll">
      <table className="vault-table">
        <caption className="visually-hidden">Recent credential activity</caption>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">What</th>
            <th scope="col">Who asked</th>
            <th scope="col">Why</th>
            <th scope="col">Outcome</th>
          </tr>
        </thead>
        <tbody>
          {activity.map((row, index) => (
            <tr key={`${row.kind}-${row.at}-${row.credentialId}-${index}`}>
              <td data-label="When">
                <time dateTime={new Date(row.at).toISOString()}>{new Date(row.at).toISOString()}</time>
              </td>
              <td data-label="What">
                {kindLabel(row.kind)} · {row.credentialName}
              </td>
              <td data-label="Who asked">
                {row.agentHandle ? (
                  <>
                    <strong>@{row.agentHandle}</strong> <span className="via">via @{row.memberHandle}</span>
                  </>
                ) : (
                  <strong>@{row.memberHandle}</strong>
                )}
              </td>
              <td data-label="Why">{row.detail}</td>
              <td data-label="Outcome">
                {row.outcome ? `${row.outcome} ` : ""}
                {row.approverHandle ? <span className="via">by @{row.approverHandle}</span> : null}
                {!row.outcome && !row.approverHandle ? "—" : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function kindLabel(kind: VaultActivityRow["kind"]): string {
  switch (kind) {
    case "used":
      return "Used";
    case "asked":
      return "Asked";
    case "decided":
      return "Answered";
    case "timed_out":
      return "Timed out";
  }
}

function deliveryLabel(delivery: VaultGrantRow["delivery"]): string {
  switch (delivery) {
    case "inject":
      return "Injected";
    case "file":
      return "In a file";
    case "device_proxy":
      return "Proxied";
    case "reveal":
      return "Revealed";
  }
}
