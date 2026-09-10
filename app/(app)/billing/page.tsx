import { getCloudflareContext } from "@opennextjs/cloudflare";
import { BillingManagementService } from "@/src/control/billing-management";
import { formatMoney } from "@/src/domain/billing-management";
import { workspaceBilling } from "@/src/shell/billing-context";
import { readCsrfToken } from "@/src/shell/session-cookies";
import type { ShellEnvironment } from "@/src/shell/resolve-shell-source";
import { confirmBillingCheckoutAction, reviewBillingChangeAction } from "./actions";

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ notice?: string; request?: string }> }) {
  const [state, query, csrfToken] = await Promise.all([workspaceBilling(), searchParams, readCsrfToken()]);
  if (state.status !== "ready") return <section className="empty-state"><h2>Billing is unavailable</h2><p>{state.status === "unavailable" ? state.reason : "Sign in to continue."}</p></section>;
  const { snapshot } = state;
  const canManage = snapshot.role === "owner" || snapshot.role === "admin";
  let request = null;
  if (query.request && canManage) {
    const env = (await getCloudflareContext({ async: true })).env as ShellEnvironment;
    if (env.CONTROL_DB) request = await new BillingManagementService(env.CONTROL_DB).pendingRequest(state.workspaceId, state.memberId, query.request);
  }
  return <>
    {query.notice ? <p className="notice" role="status">{query.notice}</p> : null}
    <section className="billing-hero panel">
      <div><p className="eyebrow">Workspace billing</p><h2>{snapshot.plan === "team" ? "Team" : "Solo"} <span className={`billing-status ${snapshot.status}`}>{snapshot.status.replace("_", " ")}</span></h2><p>{snapshot.status === "active" ? snapshot.currentPeriodEnd ? `Renews ${new Date(snapshot.currentPeriodEnd).toLocaleDateString()}` : "No renewal is scheduled." : "Your data is retained. Restore billing to make the workspace writable again."}</p></div>
      <strong>{formatMoney(snapshot.monthlyPriceCents)}<small>/month</small></strong>
    </section>
    {snapshot.status !== "active" ? <section className="notice warn"><strong>Workspace paused.</strong> Nothing was deleted. Review the plan below to restore access after payment confirmation.</section> : null}
    <section className="panel billing-ledger"><div className="panel-head"><div><h2>Plan and capacity</h2><p>One explicit change summary before secure checkout.</p></div></div>
      <form action={reviewBillingChangeAction} className="billing-form">
        <input type="hidden" name="csrfToken" value={csrfToken ?? ""} />
        <label><span>Plan</span><select name="plan" defaultValue={snapshot.plan} disabled={!canManage}><option value="solo">Solo — free, 1 seat</option><option value="team">Team — $19/month, 5 seats</option></select></label>
        <label><span>Seats</span><input name="seats" type="number" min="5" max="50" defaultValue={snapshot.plan === "team" ? snapshot.seats : 5} disabled={!canManage} /><small>Seats above 5 add $4/month each.</small></label>
        <label><span>100 GB storage packs</span><input name="storagePacks" type="number" min="0" max="100" defaultValue={snapshot.storagePacks} disabled={!canManage} /><small>Each pack adds $5/month.</small></label>
        <div className="billing-current"><span>Reserved now</span><strong>{snapshot.activeHumans} people + {snapshot.readyInvitations} invitations</strong></div>
        {canManage ? <button className="primary-link" type="submit">Review change</button> : <p className="muted">Only an owner or admin can change billing.</p>}
      </form>
    </section>
    {request ? <section className="panel billing-review" aria-labelledby="billing-review-title"><p className="eyebrow">Final review</p><h2 id="billing-review-title">Confirm the exact change</h2><dl><div><dt>Plan</dt><dd>{request.plan === "team" ? "Team" : "Solo"}</dd></div><div><dt>Seats</dt><dd>{request.seats}</dd></div><div><dt>Added storage</dt><dd>{request.storagePacks * 100} GB</dd></div><div><dt>New monthly total</dt><dd>{formatMoney(request.monthlyPriceCents)}</dd></div><div><dt>Timing</dt><dd>{request.direction === "decrease" ? "At renewal; no refund" : request.direction === "restore" ? "After payment confirmation" : "Immediately; added capacity is prorated"}</dd></div></dl><p>Continuing opens Stripe test-mode checkout. Lepidy changes access only after the signed payment event arrives.</p><form action={confirmBillingCheckoutAction}><input type="hidden" name="csrfToken" value={csrfToken ?? ""} /><input type="hidden" name="requestId" value={request.id} /><button className="primary-link" type="submit">Continue to secure checkout</button> <a href="/billing">Cancel</a></form></section> : null}
    <section className="panel"><h2>Invoices</h2>{snapshot.invoices.length ? <div className="invoice-list">{snapshot.invoices.map((invoice) => <div key={invoice.id}><time>{new Date(invoice.issuedAt).toLocaleDateString()}</time><strong>{formatMoney(invoice.amountDueCents, invoice.currency.toUpperCase())}</strong><span className="tag">{invoice.status}</span>{invoice.hostedUrl ? <a href={invoice.hostedUrl}>View invoice</a> : null}</div>)}</div> : <p className="muted">No invoices yet.</p>}</section>
    <section className="panel safeguard"><h2>Downgrade safeguards</h2><p>Lepidy never silently removes a colleague or deletes files. Before lowering seats, deactivate people or cancel invitations. Before lowering storage, remove files until they fit. A lapse retains data and this page remains available for restoration.</p></section>
  </>;
}
