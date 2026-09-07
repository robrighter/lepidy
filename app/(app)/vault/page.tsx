import Link from "next/link";

import { switchWorkspaceVaultOffAction } from "@/app/(app)/vault/actions";
import { VaultStepUpSwitch, VaultSwitchOffForm } from "@/components/shell/vault-step-up";
import { ActivityLog, LiveGrants } from "@/components/shell/vault-tables";
import { workspaceApprovals } from "@/src/shell/approvals-context";
import { readCsrfToken } from "@/src/shell/session-cookies";
import { vaultOverview } from "@/src/shell/vault-context";

export default async function VaultPage() {
  const state = await vaultOverview();

  if (state.status !== "ready") {
    return (
      <section className="empty-state">
        <h2>The vault is unavailable</h2>
        <p>{state.status === "unavailable" ? state.reason : "Sign in to see your credentials."}</p>
        <span className="next-step">Nothing was shown because authority could not be confirmed.</span>
      </section>
    );
  }

  const { overview } = state;
  const csrfToken = (await readCsrfToken()) ?? "";
  const passkeys = await workspaceApprovals();
  const hasPasskey = passkeys.status === "ready" && passkeys.hasPasskey;

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>Vault</h2>
          <div className="vault-switch">
            {overview.agentAccessOn ? (
              <VaultSwitchOffForm
                action={switchWorkspaceVaultOffAction}
                csrfToken={csrfToken}
                label="Switch agent access off"
              />
            ) : (
              <VaultStepUpSwitch
                action="vault.access_on"
                subjectId="workspace"
                label="Switch agent access on"
                hasPasskey={hasPasskey}
              />
            )}
          </div>
        </div>
        <p>
          {overview.agentAccessOn
            ? "Agents may use credentials under their policies. Switching this off is immediate, revokes every live grant, and does not restore them when it goes back on."
            : "Agent access is off. Every grant was revoked, requests in flight are denied, and turning it back on does not restore anything."}
        </p>
        <ul className="stat-row">
          <li>
            <strong>{overview.credentials.length}</strong> <span>credentials</span>
          </li>
          <li>
            <strong>{overview.grants.length}</strong> <span>live grants</span>
          </li>
          <li>
            <strong>{overview.approvals.filter((approval) => approval.viewerMayDecide).length}</strong>{" "}
            <span>waiting on you</span>
          </li>
        </ul>
      </section>

      <section className="panel">
        <h2>Live grants</h2>
        <p>All of these end the moment agent access goes off.</p>
        <LiveGrants grants={overview.grants} csrfToken={csrfToken} />
      </section>

      <section className="panel">
        <h2>Credentials</h2>
        {overview.credentials.length === 0 ? (
          <p className="vault-empty">
            No credential is shared with you. Add one from an enrolled client with{" "}
            <code>lepidy add NAME</code> — the value is encrypted there and never reaches this page.
          </p>
        ) : (
          <ul className="vault-list">
            {overview.credentials.map((credential) => (
              <li key={credential.id}>
                <Link href={`/vault/${encodeURIComponent(credential.id)}`}>
                  <strong>{credential.name}</strong>
                  {credential.policy.highRisk ? <span className="tag">high risk</span> : null}
                  <span className="tag">{credential.policy.mode}</span>
                </Link>
                <p>{credential.description || "No description."}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>Recent activity</h2>
        <p>Hash-chained in the audit record. The value never appears here, and has never been stored where it could.</p>
        <ActivityLog activity={overview.activity} />
      </section>

      <section className="panel">
        <h2>Recovery belongs to you.</h2>
        <p>
          Lepidy never stores your vault key or recovery code. They were created on your own client and never sent
          here; these servers hold ciphertext they cannot open. If every enrolled device and the recovery code are
          lost, nobody at Lepidy can recover these credentials.
        </p>
      </section>
    </>
  );
}
