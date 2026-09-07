import Link from "next/link";

import { freezeCredentialAction } from "@/app/(app)/vault/actions";
import { VaultStepUpSwitch, VaultSwitchOffForm } from "@/components/shell/vault-step-up";
import { ActivityLog, LiveGrants } from "@/components/shell/vault-tables";
import { workspaceApprovals } from "@/src/shell/approvals-context";
import { readCsrfToken } from "@/src/shell/session-cookies";
import { credentialDetail } from "@/src/shell/vault-context";

export default async function CredentialPage({ params }: { params: Promise<{ credential: string }> }) {
  const { credential: credentialId } = await params;
  const state = await credentialDetail(decodeURIComponent(credentialId));

  // A credential this member has no right to is reported as missing, never as
  // forbidden: the page must not become a way to ask which credentials exist.
  if (state.status !== "ready") {
    return (
      <section className="empty-state">
        <h2>Credential not available</h2>
        <p>{state.status === "unavailable" ? state.reason : "Sign in to see your credentials."}</p>
        <span className="next-step">A credential is only listed for the people it is shared with.</span>
      </section>
    );
  }

  const { detail, grants, activity } = state;
  const csrfToken = (await readCsrfToken()) ?? "";
  const passkeys = await workspaceApprovals();
  const hasPasskey = passkeys.status === "ready" && passkeys.hasPasskey;

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>{detail.credential.name}</h2>
          <Link href="/vault" className="via">
            Back to the vault
          </Link>
        </div>
        <p>
          {detail.credential.description || "No description."} Added by @{detail.createdByHandle}.
        </p>
        <p className="vault-note">
          <strong>Only your own clients can unlock this.</strong> The vault key and recovery code were created on an
          enrolled client and never sent here. This page shows what the credential is and who may use it; it has no
          way to receive the value, and the servers behind it hold ciphertext they cannot open.
        </p>
        {detail.rotation === "none" ? null : (
          <p className={detail.rotation === "overdue" ? "vault-frozen" : "approval-note"}>
            {detail.rotation === "overdue"
              ? "This credential is past the date it was meant to be replaced."
              : "This credential is due to be replaced within a week."}{" "}
            Rotate it from a client that holds its key: <code>lepidy rotate {detail.credential.name}</code>. This page
            cannot do it — rotation re-encrypts the value, and the key for that has never been here.
          </p>
        )}
        <div className="vault-switch">
          {detail.awaitingCaptureReview ? (
            <>
              <p className="vault-frozen">
                Captured from <code>{detail.capturedFrom ?? "a command"}</code> and switched off until you confirm it.
                An agent can create a credential this way but cannot make one usable, which is what stops a captured
                value from quietly replacing something you rely on.
              </p>
              {detail.viewer.mayManage ? (
                <VaultStepUpSwitch
                  action="vault.credential_on"
                  subjectId={detail.credential.id}
                  label="Confirm this capture"
                  hasPasskey={hasPasskey}
                />
              ) : null}
            </>
          ) : detail.frozen ? (
            <>
              <p className="vault-frozen">
                Switched off by @{detail.frozenByHandle ?? "somebody"}. Nobody can use it until it goes back on.
              </p>
              {detail.viewer.mayManage ? (
                <VaultStepUpSwitch
                  action="vault.credential_on"
                  subjectId={detail.credential.id}
                  label="Switch this credential on"
                  hasPasskey={hasPasskey}
                />
              ) : null}
            </>
          ) : (
            <VaultSwitchOffForm
              action={freezeCredentialAction}
              csrfToken={csrfToken}
              fields={{ credentialId: detail.credential.id }}
              label="Switch this credential off"
            />
          )}
        </div>
      </section>

      <section className="panel">
        <h2>How it can reach an agent</h2>
        <ul className="vault-deliveries">
          {detail.credential.policy.allowedDeliveries.includes("inject") ? (
            <li>
              <strong>Injected — the default.</strong> The agent runs{" "}
              <code>lepidy run --with {detail.credential.name} -- …</code> and sees only the command&rsquo;s output.
              The value exists in one child process and nowhere else.
            </li>
          ) : null}
          {detail.credential.policy.allowedDeliveries.includes("file") ? (
            <li>
              <strong>In a file.</strong> Written owner-only for the length of one command and removed when it exits,
              for tools that will not take a credential any other way.
            </li>
          ) : null}
          {detail.credential.policy.allowedDeliveries.includes("device_proxy") ? (
            <li>
              <strong>Proxied.</strong> An enrolled, unlocked device attaches the credential and makes the request.
              Allowed hosts: {detail.credential.proxyHosts.join(", ") || "none yet"}.
            </li>
          ) : null}
          <li>
            <strong>Revealed — {detail.credential.policy.allowedDeliveries.includes("reveal") ? "on" : "off"}.</strong>{" "}
            Hands the plaintext to the agent, which means it reaches the model provider and is written into a
            transcript on disk.
          </li>
        </ul>
      </section>

      <section className="panel">
        <h2>Policy</h2>
        <dl className="vault-facts">
          <dt>Mode</dt>
          <dd>
            {detail.credential.policy.mode === "ask"
              ? "Asks a human every time"
              : detail.credential.policy.mode === "auto"
                ? "Released automatically under policy"
                : "Never available to agents"}
          </dd>
          <dt>Grant lasts</dt>
          <dd>
            {detail.credential.policy.grantTtlMs === undefined
              ? "a single use"
              : `up to ${Math.round(detail.credential.policy.grantTtlMs / 60_000)} minutes`}
          </dd>
          <dt>Ceiling</dt>
          <dd>
            {detail.credential.policy.maxUsesPerHour === undefined
              ? "no hourly limit"
              : `${detail.credential.policy.maxUsesPerHour} uses per hour`}
          </dd>
          {detail.credential.kind === "structured" ? (
            <>
              <dt>Expands into</dt>
              <dd>
                {(detail.credential.fields ?? [])
                  .map((field) => `${detail.credential.name}_${field}`)
                  .join(", ")}
              </dd>
            </>
          ) : null}
          {detail.credential.rotateAt === undefined ? null : (
            <>
              <dt>Replace by</dt>
              <dd>
                <time dateTime={new Date(detail.credential.rotateAt).toISOString()}>
                  {new Date(detail.credential.rotateAt).toISOString()}
                </time>
              </dd>
            </>
          )}
          <dt>Projects</dt>
          <dd>
            {detail.credential.policy.projectIds.length === 0
              ? "any registered project"
              : detail.credential.policy.projectIds.join(", ")}
          </dd>
        </dl>
      </section>

      <section className="panel">
        <h2>Who can do what</h2>
        <p>Three different privileges, on purpose.</p>
        <dl className="vault-facts">
          <dt>Use it</dt>
          <dd>{detail.use.map((subject) => subject.label).join(", ") || "nobody"}</dd>
          <dt>See the value</dt>
          <dd>{detail.reveal.map((subject) => subject.label).join(", ") || "nobody"}</dd>
          <dt>Change it</dt>
          <dd>{detail.manage.map((subject) => subject.label).join(", ") || "nobody"}</dd>
        </dl>
        <p className="vault-note">
          Managing a credential means holding a key that opens it, so the people listed under &ldquo;change it&rdquo;
          are the ones who can decrypt it on their own clients. Scoping use to a room means an agent working there may
          ask for it; a request from anywhere else is refused, and the refusal says so.
        </p>
      </section>

      <section className="panel">
        <h2>Live grants</h2>
        <LiveGrants
          grants={grants}
          csrfToken={csrfToken}
          scope={{ credentialId: detail.credential.id }}
          emptyLabel="Nobody holds this credential right now."
        />
      </section>

      <section className="panel">
        <h2>Access log</h2>
        <ActivityLog activity={activity} />
      </section>
    </>
  );
}
