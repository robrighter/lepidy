# Cloud and custom runtime contract

**Status:** Accepted

**Decision:** D06

**Date:** 2026-09-07
**Provider snapshot:** Claude Platform documentation read 2026-09-07; Managed Agents beta `managed-agents-2026-04-01`

This contract fixes the provider-authentication, lifecycle, callback and
reconciliation boundaries that A05 must implement. It preserves the core
product rule: Lepidy coordinates an agent but never runs its loop. Cloud
execution belongs to a customer's Anthropic workspace; custom execution
belongs to a customer's HTTPS service.

## 1. Supported capability envelope

| Capability | `claude_cloud` | `custom` |
|---|---|---|
| Wake from a mention | Create a Managed Agents session with initial `user.message` work | Signed metadata-only POST to the one registered endpoint |
| Scheduled work | Anthropic scheduled deployment | Not in v1 |
| Manual run | Deployment `run` endpoint, including while paused | Not in v1; mention/test callbacks only |
| Spend limit | Required per-session USD list-cost cap; required per-run deployment cap | Delegation spend cap is advisory because the remote runtime reports no trusted provider cost |
| Content and results | Existing delegation-scoped MCP tools | Existing delegation-scoped MCP tools |
| Lifecycle signal | Signed Anthropic webhook plus API fetch | Delivery state plus MCP session/queue state |
| Correctness repair | Provider resource reconciliation | Durable retry plus queue/session expiry and visible dead delivery |
| Lepidy credential use | Device-mediated HTTP proxy only | Device-mediated proxy or the custom service's own credentials; Lepidy never sends vault plaintext |

Unsupported in v1: provider-managed credential mirroring, Anthropic vault
synchronization, provider transcript ingestion, custom-runtime schedules,
arbitrary callback URLs supplied per request, redirects, private endpoints and
any callback that can post content without an authenticated MCP session.

## 2. Claude Cloud authority and custody

Each integration names exactly one customer-owned Anthropic organization and
workspace. Lepidy stores their opaque organization/workspace, agent,
environment, deployment, federation-rule and service-account identifiers. It
never copies an agent transcript or customer API key.

Production authentication is **Workload Identity Federation (WIF)**:

1. The customer's Anthropic administrator creates or chooses a developer-role
   service account in the target workspace.
2. The administrator creates a federation rule that trusts Lepidy's public
   OIDC issuer, an exact audience, and the exact unguessable subject assigned to
   this Lepidy integration. Wildcard subjects are refused by the setup check.
3. Lepidy mints a short-lived assertion for that subject and exchanges it at
   Anthropic's token endpoint. The returned access token remains in memory only
   and is never written to tenant storage, logs, analytics or audit metadata.
4. Revoking the customer's federation rule or service account cuts off future
   token exchanges. Disconnecting in Lepidy stops sessions/deployments where
   possible, deletes the local integration subject and prevents new assertions.

This makes Lepidy an explicitly authorized workload in the customer's account
without making a long-lived `sk-ant-...` key server-decryptable. Static personal,
service-account and legacy workspace API keys are **not accepted by the v1
connect flow**. A customer vault value cannot solve unattended provider auth:
the Worker cannot decrypt it, and requiring a release device would contradict
the cloud runtime's always-on purpose.

The WIF signing key is Lepidy platform key material, not a customer vault key.
It lives only in the platform secret/key service, is rotatable through a JWKS
overlap, and is never tenant data. A platform compromise could impersonate this
workload within the exact customer rules that trust it; the connect screen says
that plainly and tells administrators to keep the subject exact and the target
service account developer-only.

Every Managed Agents call sends `anthropic-version: 2023-06-01` and
`anthropic-beta: managed-agents-2026-04-01` (or uses an SDK that emits the same
beta header). A05 pins an SDK/API contract and fails closed on an unknown beta
shape; it does not silently parse a newer event as the old one.

## 3. Connect and proof gate

An integration remains `pending` until all of these pass:

1. WIF token exchange succeeds for the configured service account and workspace.
2. Lepidy retrieves the configured agent and environment from that workspace.
3. The customer registers `https://app.lepidy.com/hooks/anthropic` in the
   Anthropic Console on HTTPS port 443 with the required session, deployment and
   deployment-run event types.
4. The customer enters the one-time `whsec_` signing secret. It is envelope-
   encrypted under a platform transport-secret key and is available only to the
   webhook verifier. It is not a vault credential and is never exposed to an
   agent or an application response after entry.
5. Lepidy receives a fresh, valid signed delivery whose `organization_id` and
   `workspace_id` match the integration. A Console test event may satisfy this
   when the Console offers one; otherwise the UI drives a deliberately small,
   budgeted test session and explains that it uses the customer's Anthropic
   account.

Parsing an unverified body is allowed only to select the candidate integration
secret. No tenant routing, dedupe acknowledgement, fetch or mutation occurs
until the SDK verifies the signature against the **raw bytes** and enforces its
five-minute freshness bound. The signed organization/workspace pair is then
matched again to the selected integration.

The callback route is one exact `POST /hooks/anthropic` match. Every other
method/path, including the trailing-slash form, returns a non-3xx refusal. The
route never redirects.

## 4. Provider lifecycle, budgets and webhook processing

A mention creates a session for the configured agent/environment and seeds the
work as an initial `user.message`. The response's resolved agent version is
stored with the local run for provenance. Agent replies and queue work still
travel through Lepidy MCP; the provider webhook carries lifecycle metadata only.

A schedule is a provider deployment with a five-field POSIX cron expression and
an IANA timezone. The UI renders `schedule.upcoming_runs_at`, warns that actual
execution can be jittered by up to 15% of the interval (minimum five seconds,
maximum nine minutes), and warns that spring-forward times can be skipped while
fall-back times can fire twice. A manual run creates a deployment-run record and
is allowed while the deployment is paused. Archive is terminal; pause is not.

Every mention session and deployment requires a non-null USD budget. Amounts
are integer cents serialized as strings to Anthropic. The cap is a hard ceiling
between model requests, so final list cost may be slightly above it. A
deployment copies its cap to each new run; changing it affects later runs only.
A budgeted session that reaches its cap becomes idle. An owner may replace its
cap with one above consumed cost or remove it, which automatically resumes the
paused work. Removing a session cap is one-way, and a cap cannot be added later
to a session created without one—one reason Lepidy never creates an unbudgeted
session.

For a verified webhook:

1. dedupe durably on the top-level event id (equal to `webhook-id`);
2. acknowledge with `204` only after the receipt and tenant work item commit;
3. fetch the named resource through the authenticated provider client rather
   than deriving state from delivery order or the thin event body;
4. treat a second delivery of the same id as an acknowledged no-op;
5. post the first actionable budget/failure transition visibly in the room and
   retain the redacted detail in run history.

Anthropic can deliver events out of order or more than once. It tries at most
three times with jittered backoff, drops the event without a loss signal after
the last failure, and never backfills events emitted while a type was
unsubscribed or the endpoint was disabled. A `3xx` disables the endpoint on the
first attempt. Those are provider facts, not behavior Lepidy can tune.

Therefore webhooks accelerate state; they never establish completeness. Each
workspace keeps a recurring reconciliation item in its existing multiplexed
alarm. At least daily, and additionally while local runs are open, it pages the
provider for named open sessions, deployments and deployment runs, then settles
local state from fetched resources. Cursors are opaque. A missing/deleted
resource settles only after the corresponding retrieve confirms absence;
transient auth/rate/network failure remains retryable and visible. Repeated WIF
failure marks the integration disconnected and stops new starts without
deleting the user's queue or delegation.

## 5. Custom runtime callback

A custom runtime is one owner-configured HTTPS endpoint plus one Lepidy-generated
32-byte HMAC secret. The secret is shown once, stored envelope-encrypted as a
transport secret and rotatable with a short old/new overlap. It is not a way to
call Lepidy. The custom service still needs a delegation-scoped agent session
and uses MCP for claims, reads, posts, credential-proxy requests and completion.

The callback is a wake, not content and not a command. Its canonical UTF-8 JSON
body contains exactly:

```json
{
  "type": "agent.work_available",
  "version": 1,
  "delivery_id": "…",
  "created_at": "…",
  "workspace_id": "…",
  "agent_id": "…",
  "queue_depth": 1
}
```

It contains no message body, thread text, attachment URL, credential, command,
arguments, environment, callback URL, user email or reusable access token.
Queue depth is a hint; `agent_next` is authoritative and performs the live
delegation/scope checks.

Headers are `lepidy-webhook-id`, `lepidy-webhook-timestamp` (Unix seconds), and
`lepidy-webhook-signature: v1=<base64url HMAC-SHA-256>`. The signed bytes are:

```text
<delivery-id>.<timestamp>.<raw-body>
```

Consumers compare the MAC in constant time, reject timestamps more than five
minutes from their clock, and retain `delivery_id` for at least 24 hours. A
retry keeps the same id and body but receives a fresh timestamp/signature.
Acknowledgement is any `2xx`; it means only that the wake was accepted. The
provider must dedupe before starting work. Lepidy never follows a redirect.
Network errors, `408`, `425`, `429`, and `5xx` use F06's bounded durable retry;
other `3xx`/`4xx` are permanent. Exhaustion marks the delivery dead, shows a
plain-language failure to owners and leaves queued work intact for recovery.

## 6. SSRF and egress boundary

Registration and every delivery apply the same checks:

- absolute `https:` URL, explicit/default port 443 only;
- no username, password or fragment; no IP literal;
- a public DNS hostname whose current A and AAAA answers are all public;
- no loopback, unspecified, private, carrier-grade NAT, link-local, multicast,
  documentation, benchmark, reserved or other special-use address;
- a body and response-size cap, a short connection/total timeout and no response
  body persisted beyond a bounded diagnostic code;
- `redirect: "manual"`; every `3xx` is a failure and its `Location` is never
  fetched;
- the Worker enables Cloudflare's `global_fetch_strictly_public` compatibility
  behavior for this egress path. A05 must not replace it with a service binding,
  VPC binding or customer-controlled custom origin.

The registration test sends a signed `custom.test` envelope with the same
schema/limits and requires a `2xx`. It does not weaken the network rules for a
hostname that happened to pass once; DNS is re-evaluated at delivery. Customer
private-network callbacks require a separately designed outbound connector and
are outside v1.

## 7. Secret and content scanning

A05 adds an executable negative harness that records the raw provider request,
Anthropic callback, custom callback, logs, audit metadata and persisted rows for
seeded canary strings. It must prove that:

1. no Anthropic API key is accepted or persisted;
2. WIF assertions/access tokens and both webhook secrets never enter logs,
   audit, errors or tenant content;
3. custom callback bodies contain only the exact allowlisted keys above;
4. Anthropic thin events never become trusted content without signature and
   organization/workspace matching;
5. vault plaintext and authorization headers never cross either cloud callback;
6. provider error messages are bounded/redacted before storage or room display.

This is the external secret-scan harness left open by A03. It belongs to A05
because only A05 creates the external requests; D06 fixes what it must observe.

## 8. Required A05 integration scenarios

1. WIF succeeds only for the exact issuer/audience/subject/service-account/
   workspace tuple; revoked or mismatched authority stops new provider calls.
2. Setup cannot complete before authenticated resource retrieval and a matching
   signed webhook proof.
3. The exact Anthropic route rejects bad/stale signatures and every method/path
   shape with only 2xx/4xx responses; a duplicate event commits once.
4. Out-of-order and missing webhook deliveries converge through provider fetch
   and reconciliation, including opaque pagination and WIF/rate/network failure.
5. Mention, scheduled and manual runs preserve provider IDs, resolved agent
   version, budgets, failures and delegation provenance; raise/remove budget
   behavior matches the provider contract.
6. Custom URL tests cover credentials/fragments, ports, IP literals, every
   special-use IPv4/IPv6 class, mixed DNS answers, DNS change, redirects,
   oversized/slow responses and dead delivery.
7. A repeated valid custom callback starts no duplicate work; a stale/tampered
   envelope starts none; its body contains no content or execution directive.
8. The external secret/content scan passes with canaries in every tempting
   field and capture surface.

## 9. Alternatives rejected

- **Store a customer service-account API key in Lepidy:** operationally simple,
  but creates a long-lived server-decryptable provider credential and conflicts
  with both the schema promise and zero-knowledge product posture.
- **Keep the API key in the user vault and call through a release device:**
  preserves key custody but makes a scheduled cloud runtime depend on an online,
  unlocked customer machine before it can even be started or reconciled.
- **Use Anthropic CLI interactive OAuth as an application authorization flow:**
  the official CLI can log a person in, but the reviewed provider documentation
  does not publish a third-party authorization-code integration contract for
  Lepidy. A CLI profile is not a server integration credential.
- **Trust webhook arrival as the lifecycle log:** provider delivery is lossy,
  unordered and not backfilled, so this leaves permanently stale sessions.
- **Put message content or a reusable token in custom callbacks:** that creates a
  second content/authority plane and increases the effect of endpoint leakage.
- **Allow redirects or private custom endpoints after a one-time URL test:** DNS
  and redirects can change after setup; checks belong on every delivery.

## 10. Verification evidence and drift rule

The provider claims above were checked against Anthropic's official
[authentication](https://platform.claude.com/docs/en/manage-claude/authentication),
[Workload Identity Federation](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation),
[Managed Agents session](https://platform.claude.com/docs/en/managed-agents/sessions),
[session operations](https://platform.claude.com/docs/en/managed-agents/session-operations),
[scheduled deployment](https://platform.claude.com/docs/en/managed-agents/scheduled-deployments),
[webhook](https://platform.claude.com/docs/en/managed-agents/webhooks) and
[Managed Agents reference](https://platform.claude.com/docs/en/managed-agents/reference)
documentation. The Cloudflare egress constraints use the official
[Fetch request redirect guidance](https://developers.cloudflare.com/workers/runtime-apis/request/)
and [`global_fetch_strictly_public` compatibility flag](https://developers.cloudflare.com/workers/configuration/compatibility-flags/).

Managed Agents is a beta contract. Before A05 first implementation and before
each release, rerun this source review. A changed beta header, auth method,
event spelling, retry rule, budget rule or schedule semantic blocks release
until this contract and its tests are updated. Documentation review is not a
live provider certification: A05's customer-org setup test is the first live
API/webhook proof and must not be represented as complete by D06.
