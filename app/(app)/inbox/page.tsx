import { ApprovalInbox } from "@/components/shell/approval-inbox";
import { workspaceApprovals } from "@/src/shell/approvals-context";
import { readCsrfToken } from "@/src/shell/session-cookies";

export default async function Page() {
  const state = await workspaceApprovals();

  if (state.status === "unavailable") {
    return (
      <section className="empty-state">
        <h2>Your inbox is unavailable</h2>
        <p>{state.reason}</p>
        <span className="next-step">Nothing was shown because authority could not be confirmed.</span>
      </section>
    );
  }

  return (
    <>
      <section className="panel">
        <h2>Inbox</h2>
        <p>
          Credential requests arrive here and as a direct message from @a.vault, so they can be
          answered wherever you already are. Mentions, thread replies and the rest of the notification
          tiers join them with C06.
        </p>
      </section>
      <section className="panel">
        <ApprovalInbox
          approvals={state.status === "ready" ? state.approvals : []}
          csrfToken={(await readCsrfToken()) ?? ""}
          hasPasskey={state.status === "ready" && state.hasPasskey}
        />
      </section>
    </>
  );
}
