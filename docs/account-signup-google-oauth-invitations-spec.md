# Account signup, Google OAuth, and workspace invitations

**Status:** Proposed
**Date:** 2026-09-12
**Scope:** Web signup/sign-in, Google as a login method, transactional email, and joining an existing workspace by invitation

## 1. Outcome

Ship a production-safe account entry flow in which a person can:

1. create a Lepidy account with a verified email and password;
2. create or sign in to a Lepidy account with Google;
3. create their first workspace after self-service signup;
4. accept an invitation into an existing workspace without accidentally creating another workspace; and
5. send, resend, inspect, and cancel workspace invitations as an owner or administrator.

Google remains a login method attached to a Lepidy account. Its subject identifier does not become the account ID, and a matching Google email never silently merges accounts. This preserves the accepted identity contract in [identity-tenant-contract.md](./identity-tenant-contract.md) and PRD section 13.1.

## 2. Current state

The repository already contains more than a placeholder:

- D1 owns `accounts`, `login_identities`, `sessions`, `workspaces`, `memberships`, `invitations`, and hashed auth challenges.
- `OnboardingService.authenticateGoogle` and `linkGoogle` implement the core no-silent-linking rule, but no Google protocol endpoints validate a real provider response.
- Password signup works only in development. It issues and consumes its email challenge inline, which is intentionally refused in production.
- The People screen already lets an owner or administrator create and cancel invitations and enforces seat capacity.
- Invitation tokens are random, stored only as hashes, expire after seven days, and can be accepted only once by an account whose verified primary email matches.
- There is no invitation email delivery, resend action, invitation landing page, or acceptance UI.
- `EVENTS` is configured as a Cloudflare Queue, but the production Worker currently has no queue consumer.

This work should extend those boundaries rather than introduce Supabase, Auth.js, or a separate identity provider.

## 3. Product decisions

### 3.1 Entry choices

Both `/signup` and `/signin` show a first-class **Continue with Google** button separated from the password form by an “or” divider.

- `/signup`: Google may create a new Lepidy account after a verified Google assertion, then sends the person to Lepidy onboarding to choose their handle and workspace name.
- `/signin`: Google signs in only when the `(provider, provider_subject)` identity is already linked. A genuinely new Google identity may continue into signup after an explicit “Create a Lepidy account” confirmation.
- An email collision never creates or links another account. The person is told to sign in to the existing account, perform a fresh password/passkey step-up, review the Google address being attached, and explicitly confirm the link.
- Request only `openid email profile`. Do not request Google API access or offline access, and do not store Google access or refresh tokens.

This makes sign-in and signup intent visible to the user while keeping one callback implementation.

### 3.2 Account and workspace creation are separate steps

Authentication establishes an account and browser session. Onboarding establishes a first workspace only when the account has no membership and is not following an invitation.

- Ordinary self-service signup redirects to `/onboarding/workspace`.
- Invitation signup redirects to `/invite/{invitationId}` and joins the target workspace.
- An account with one workspace goes to that workspace.
- An account with several workspaces goes to the last-used workspace when safe, otherwise to a workspace chooser.

This removes the current coupling in `signUpWithWorkspace` and prevents an invited person from receiving an unwanted personal workspace.

### 3.3 Email delivery

Use **Cloudflare Email Service Email Sending** through a Worker `send_email` binding, behind a repository-owned `TransactionalEmailSender` interface.

As of this spec date, outbound Email Sending is in public beta. Arbitrary recipients require Workers Paid, and the sending domain must use Cloudflare DNS and be onboarded with SPF, DKIM, and DMARC. The current published price includes 3,000 outbound messages per account per month and then charges per thousand. See the official [Email Service overview](https://developers.cloudflare.com/email-service/), [setup guide](https://developers.cloudflare.com/email-service/get-started/send-emails/), and [pricing](https://developers.cloudflare.com/email-service/platform/pricing/).

Recommended production identity:

- From: `Lepidy <accounts@notify.lepidy.com>`
- Reply-To: a monitored support address
- Sending subdomain: `notify.lepidy.com`, isolated from future marketing mail reputation
- Both HTML and plain-text bodies
- No tracking pixels or marketing content in authentication mail

The provider interface is deliberate: Cloudflare beta availability or deliverability must not force a rewrite of account and invitation logic.

## 4. User flows

### 4.1 Password signup

1. Person submits name, handle, email, password, and workspace name on `/signup`.
2. The server validates fields, normalizes the email, performs rate limits, and rejects an existing address with a generic sign-in-oriented response.
3. The Accounts Durable Object hashes the password immediately. Plaintext is never written to D1, logs, queue messages, or cookies.
4. A 15-minute `verify_email` challenge and pending-signup payload are written atomically with an email-outbox item.
5. The UI shows `/signup/check-email` regardless of whether the address can be registered, preventing address enumeration.
6. The recipient opens `/auth/email/verify?id=...&token=...`.
7. The server consumes the challenge once, creates the account and password login identity, creates a browser session, and redirects to `/onboarding/workspace` with the pending profile/workspace defaults.
8. Workspace provisioning creates the owner membership and starter channel through the existing service path. A retry-safe provisioning state handles a Durable Object failure without creating a second account or workspace.

Resend invalidates the previous challenge, issues a new token, and is limited by both address and source IP. The response remains generic.

### 4.2 Google signup and sign-in

1. The browser requests `GET /auth/google/start?intent=signup|signin&next=<safe-path>`.
2. The server creates a ten-minute OAuth attempt containing a hashed `state`, nonce, PKCE verifier, intent, safe next path, and optional invitation continuation. It sets only a short-lived, HttpOnly, Secure, SameSite=Lax correlation cookie.
3. The browser is redirected to Google using the authorization-code flow with PKCE and `openid email profile`.
4. Google returns to the exact registered URI `/auth/callback/google`.
5. The callback verifies the state and correlation cookie, exchanges the code, and validates the ID token signature and claims: issuer, audience, expiry, nonce, `sub`, `email`, and `email_verified`.
6. The OAuth attempt is consumed before issuing a Lepidy session. Replays fail.
7. Lepidy branches on identity state:
   - linked Google subject: issue a session and continue;
   - new subject and unused verified email: ask for explicit account creation if the request began as sign-in, then create the Lepidy account and continue to workspace onboarding or invitation acceptance;
   - new subject and email already owned by a Lepidy account: enter the explicit linking flow; do not issue a session for that account from the Google assertion alone.
8. Store only Google's stable `sub`, normalized asserted email, verification flag, and timestamps in `login_identities`. Use the Google name only as an editable display-name default. Do not use email as Google's identity key.

Google's OIDC reference requires treating `sub` as the stable identifier and validating signed ID-token claims; it also documents `state` and `nonce` protections. See [Google OpenID Connect](https://developers.google.com/identity/openid-connect/reference) and the [web-server OAuth flow](https://developers.google.com/identity/protocols/oauth2/web-server).

### 4.3 Explicit Google linking after an email collision

1. Show a neutral message: “A Lepidy account already uses this email. Sign in to that account to connect Google.” Do not reveal more account data.
2. Preserve the validated Google assertion in a short-lived, encrypted server-side continuation; never place an ID token in a browser URL.
3. Require a fresh Lepidy session and step-up with an existing password or passkey.
4. Show the destination Lepidy account and Google email, then require explicit confirmation.
5. Call the existing `linkGoogle` rule and consume the continuation once.
6. Record a security event and notify the account by email.

### 4.4 Send an invitation

1. An owner or administrator enters an email and selects `admin`, `member`, or `guest` on the People page.
2. Server-side authorization and CSRF checks run on every request; hiding the form is not an authorization boundary.
3. The existing seat check determines whether the invitation is `ready` or `held_for_plan`.
4. A ready invitation and encrypted email-outbox item are committed together. The raw invitation token is never stored in the invitation row.
5. A held invitation sends nothing until capacity exists and an administrator confirms the seat change.
6. The sender sees `Queued`, then `Sent`, `Delivered`, or a useful failure state instead of the current ambiguous “Ready for delivery.”

The invitation email contains workspace name, inviter display name, role, expiration date, and one **Join workspace** link. It does not expose workspace content or membership lists.

### 4.5 Accept an invitation

1. The link opens `/invite/{invitationId}` with the bearer token.
2. The first response sets `Referrer-Policy: no-referrer`, validates but does not consume the invitation, moves the continuation into a short-lived HttpOnly cookie or server-side continuation, and redirects to a clean URL without the token.
3. The page shows the workspace name, inviter, offered role, masked target email, and expiration.
4. If signed out, the person may continue with Google or email/password. Google receives the invited address as a `login_hint`, but the callback still verifies the actual assertion.
5. A new password account may use possession of the still-valid invitation token as proof of the invited email; it must still choose a password and display name. It does not receive a second verification email.
6. A signed-in account whose verified email matches chooses a workspace-local handle and confirms **Join workspace**.
7. A signed-in account with a different verified email is not allowed to consume the invitation. It may switch accounts or explicitly add and verify the invited address through the existing identity-verification rules.
8. Acceptance consumes the invitation once, creates the pending D1 membership, applies it to the workspace Durable Object, activates it, and redirects to the invited workspace.

Concurrent acceptance requests must produce one membership and one successful response. An already accepted, expired, revoked, or replaced token gets a non-sensitive recovery screen with a path back to sign-in.

### 4.6 Resend and cancel

- **Resend** is available to owners/admins, rotates the token, extends expiry to seven days, invalidates every prior link, creates a new outbox item, and is rate-limited. It does not reserve another seat.
- **Cancel** revokes the invitation and invalidates outstanding outbox work before it can send. A message already accepted by the mail provider cannot be recalled, but its link will fail.
- A failed or bounced delivery does not automatically release the reserved seat; the administrator chooses resend, change address by cancel-and-reinvite, or cancel.

## 5. Technical design

### 5.1 Routes and server actions

Add these public routes:

| Route | Method | Responsibility |
|---|---:|---|
| `/auth/google/start` | GET | Create OAuth attempt and redirect to Google |
| `/auth/callback/google` | GET | Validate provider response and branch to sign-in, signup, or link |
| `/auth/google/confirm-account` | GET/POST | Explicitly confirm account creation when Google began from sign-in |
| `/auth/link/google` | GET/POST | Fresh-session step-up and explicit identity linking |
| `/auth/email/verify` | GET/POST | Preview and then consume password-signup verification |
| `/signup/check-email` | GET | Generic resend/status UI |
| `/onboarding/workspace` | GET/POST | Create a first workspace for a membership-less account |
| `/invite/{invitationId}` | GET/POST | Preview and accept an invitation |

Extend existing server actions for begin-password-signup, resend verification, resend invitation, and cancel invitation. Every mutation repeats authentication, authorization, origin/CSRF, expiry, and current-state checks on the server.

Use Route Handlers for OAuth redirects/callbacks and cookie-setting transitions. Use Server Actions for forms. This matches Next.js 16.3's requirement that cookies be set only from a Server Function or Route Handler and that both actions and handlers be treated as public security boundaries.

### 5.2 Data changes

Create a numbered D1 migration with the following conceptual changes. Exact names may follow repository conventions.

#### `oauth_attempts`

- `id` primary key
- `provider` constrained to `google`
- `state_hash` unique
- `nonce`
- `pkce_verifier` encrypted at rest or protected by a dedicated short-lived secret envelope
- `intent`: `signin`, `signup`, `link`, or `invite`
- `next_path`
- optional encrypted continuation payload
- `expires_at`, `consumed_at`, `created_at`

Index unconsumed expiration for cleanup. Do not overload MCP OAuth tables; browser login is a separate protocol boundary.

#### Pending signup state

Prefer extending the existing `auth_challenges.payload_json` for the short-lived pending signup rather than adding a permanent account state. Store the already-computed password hash and validated onboarding defaults, never plaintext. Bind the payload cryptographically and logically to the challenge ID and normalized email. If the team prefers stronger queryability, use a dedicated `pending_signups` table with the same expiry and one-time-consumption rules.

#### `email_outbox`

- `id` primary key and idempotency key
- `kind`: `verify_email`, `workspace_invitation`, `identity_linked`, and future auth mail
- normalized recipient and template version
- encrypted payload containing only data needed to render the message, including the one-time token where applicable
- related entity type/id
- status: `pending`, `queued`, `accepted`, `delivered`, `deferred`, `bounced`, `failed`, `rejected`, `complained`, or `canceled`
- provider message ID, attempt count, next-attempt time, last error code, and timestamps

Delete or cryptographically erase secret payload material as soon as the provider accepts the message. Retain non-secret delivery metadata according to the product's operational retention policy.

#### `invitations`

Keep `delivery_state` as seat eligibility (`ready` or `held_for_plan`) for migration compatibility, but stop treating it as actual mail status. Add or derive a separate latest email-delivery status and provider message ID. Correct `last_sent_at` semantics so it means provider acceptance, not invitation creation or seat confirmation.

Add an audit event for create, release from plan hold, send accepted, resend, bounce/rejection, revoke, and accept. Never put raw tokens, authorization codes, ID tokens, PKCE verifiers, or full OAuth assertions in audit payloads.

### 5.3 Reliable mail dispatch

D1 and Cloudflare Queues cannot participate in one atomic transaction, so use a transactional outbox:

1. Write the auth/invitation record and outbox row in one D1 batch.
2. Attempt to enqueue the outbox ID after commit.
3. A queue consumer claims the row idempotently, renders a versioned template, and calls `env.EMAIL.send()`.
4. Store the returned Cloudflare message ID and mark the secret payload erased.
5. Retry only transient API failures with exponential backoff and jitter. Permanent validation, authentication, or suppression failures become terminal and visible to the administrator/user.
6. A one-minute scheduled sweep re-enqueues stranded due rows, closing the post-commit/pre-enqueue failure window.
7. Configure a dead-letter queue; Cloudflare deletes messages after exhausted retries when no DLQ exists.

Use a dedicated outbound queue and a separate Email Service lifecycle-event queue, or distinguish their schemas explicitly if one queue is retained. Cloudflare Email Service can publish delivered, deferred, bounced, failed, rejected, and complained events to Queues. Correlate by provider message ID and make event handling idempotent. See [Email event subscriptions](https://developers.cloudflare.com/email-service/platform/event-subscriptions/) and [Cloudflare Queue dead-letter queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/).

Cloudflare automatically manages provider suppressions for hard bounces and complaints. Mirror terminal state locally so the UI does not repeatedly offer blind resends to a suppressed address. See [suppression lists](https://developers.cloudflare.com/email-service/concepts/suppressions/).

### 5.4 Configuration and secrets

Add environment-specific configuration:

- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET` as a Wrangler secret
- `OAUTH_CONTINUATION_KEY` as a rotatable Wrangler secret
- `EMAIL_OUTBOX_KEY` as a rotatable Wrangler secret
- `APP_ORIGIN`, allowlisted and never inferred from the request host
- `EMAIL_FROM_ADDRESS`, `EMAIL_FROM_NAME`, and `EMAIL_REPLY_TO`
- `EMAIL` send binding
- outbound email queue, email lifecycle-event queue, and dead-letter queue bindings

Use separate Google Cloud OAuth clients/projects for local development, staging, and production. Register exact callback URIs; do not use wildcard redirects. The production consent screen needs Lepidy branding, homepage, privacy policy, terms, support address, and verified authorized domains. Basic `openid email profile` sign-in avoids sensitive Google API scopes.

### 5.5 Rate limits and abuse controls

Use the existing `RATE_LIMITS` binding with hashed keys and bounded TTLs:

- begin signup: per IP and normalized email;
- resend verification: per challenge, email, and IP;
- Google start/callback failures: per browser correlation and IP;
- invite creation/resend: per actor, workspace, and recipient;
- invitation acceptance failures: per invitation and IP.

Suggested initial policies are configuration, not hard-coded product promises: five signup or resend attempts per address per hour, 20 per IP per hour, and three invitation resends per invitation per day. Return generic responses where account existence would otherwise be revealed. Add Turnstile only after observed abuse; it is not required for the first release.

## 6. UI requirements

### Signup/sign-in

- Google button uses Google's required branding and accessible name.
- Password and Google remain equally understandable choices; neither is hidden behind a secondary page.
- Preserve a validated same-origin `next` path through every step.
- Errors distinguish recoverable user action (“link expired”) from service failure without exposing account existence or provider internals.
- Pending buttons prevent accidental double submission, but server idempotency remains authoritative.

### People administration

- Replace “Ready for delivery” with actual states: Held for seat, Queued, Sent, Delivered, Deferred, or Delivery failed.
- Show invitation expiry and last-send time.
- Add Resend and Cancel; disable Resend while held for a seat.
- Explain that resend invalidates the old link.

### Invitation landing

- Work well signed in or signed out and on narrow mobile screens.
- Show enough context to establish trust without revealing workspace data.
- Keep the invited email masked until the person proves control or signs in.
- Provide clear recovery for expired/revoked links and wrong-account sessions.

## 7. Security invariants

The implementation is not complete unless all of these remain true:

1. A Google email match alone never links or signs into an existing Lepidy account.
2. Google identity lookup keys on `(google, sub)`, never email.
3. Only an ID token with valid signature, issuer, audience, expiry, nonce, and verified email is accepted.
4. OAuth state and attempts are random, short-lived, single-use, and bound to the initiating browser.
5. Redirect destinations are allowlisted same-origin paths; protocol-relative and backslash variants fail closed.
6. Invitation and email-verification tokens are high-entropy, stored hashed at rest, expire, and are consumed once.
7. Any temporarily retained raw token or PKCE verifier is encrypted with a dedicated key and erased after use.
8. Invitation acceptance proves the target email and cannot add the same account to the same workspace twice.
9. Every invite/admin mutation independently authenticates the session, validates CSRF/origin, and checks current owner/admin authority.
10. A held invitation cannot be sent or accepted, and a ready invitation continues to reserve exactly one seat.
11. Queue redelivery, callback replay, and double-clicks do not create duplicate accounts, identities, workspaces, memberships, or emails.
12. Secrets and bearer values do not appear in application logs, analytics, error messages, audit events, or referrers.

## 8. Testing plan

### Unit tests

- safe next-path validation and OAuth intent parsing;
- Google claim validation, nonce/state/PKCE binding, and clock skew;
- email template escaping and plain-text parity;
- delivery-state transition reducer and retry classification;
- resend token rotation and rate-limit decisions.

### D1/Durable Object integration tests

- password signup stays pending until challenge consumption and completes once;
- Google new-account, existing-subject, email-collision, explicit-link, and replay cases;
- onboarding retries do not duplicate workspaces or starter channels;
- ready versus held invitations, capacity reservation, resend, cancel, expiry, wrong email, and concurrent acceptance;
- outbox recovery after enqueue failure, queue redelivery, transient provider failure, DLQ path, and lifecycle-event deduplication;
- membership projection failure remains fail-closed and retryable.

### Browser tests

- signup/password verification using a deterministic local mail capture;
- Google flows with a local fake OIDC provider or protocol adapter, never live Google in the default suite;
- invited new user with Google and with password;
- invited existing user, wrong signed-in account, expired invitation, and old link after resend;
- owner/admin permissions and non-admin direct-action attempts;
- mobile layout, keyboard navigation, focus placement, and accessible error/status announcements.

### Production smoke tests

- Google test account on the exact production callback;
- one real message to Gmail and one to Outlook;
- SPF, DKIM, and DMARC pass;
- delivered event correlates to the outbox record;
- cancellation invalidates a previously delivered invitation link.

## 9. Delivery slices

### Slice A — Transactional email foundation

- Email Service domain/binding, sender abstraction, encrypted D1 outbox, queue consumer, scheduled recovery, DLQ, templates, and local capture.
- Delivery events and administration statuses.

### Slice B — Production password signup

- Begin/verify/resend flow, pending signup, account session, separate workspace onboarding, and enumeration-safe UX.

### Slice C — Google login method

- OAuth attempt store, start/callback routes, ID-token verifier, account creation confirmation, session issuance, and explicit collision/linking flow.

### Slice D — Invitation completion

- Reliable send, landing/continuation, signup/sign-in handoff, acceptance UI, resend rotation, cancellation, and wrong-account recovery.

### Slice E — Hardening and launch

- Rate limits, delivery-event handling, monitoring/alerts, security review, browser/accessibility suite, and production smoke tests.

Slices A and B should land before enabling public signup. Slice C can be developed alongside B after the onboarding split. Slice D depends on A and the shared onboarding/session transitions.

## 10. Likely repository touchpoints

| Area | Existing location | Expected change |
|---|---|---|
| Auth forms/actions | `app/(auth)`, `components/shell/auth-form.tsx` | Add Google entry, split begin/complete password signup, preserve continuations |
| OAuth routes | new `app/auth/google/start` and `app/auth/callback/google` handlers | Authorization-code/PKCE flow and session issuance |
| Account boundary | `src/cloudflare/accounts.ts` | Expose retry-safe begin/complete signup, Google authentication, and onboarding operations through the existing Durable Object stub |
| Identity rules | `src/control/onboarding.ts`, `src/control/identity.ts` | Refactor automatic Google account creation, validate collision branches, consume pending signup/link state |
| Sessions | `src/shell/session-cookies.ts`, `src/control/authorization.ts` | OAuth correlation/continuation cookies and normal Lepidy session issuance |
| Invitations | `src/control/administration.ts`, `app/(app)/people` | Queue delivery, resend/rotation, actual delivery states, acceptance UI |
| Mail worker | new `src/cloudflare/transactional-email.ts` and templates | Provider adapter, renderer, retry classification, lifecycle-event reducer |
| Worker entry/config | `custom-worker.ts`, `wrangler*.jsonc`, generated environment types | Email/queue bindings, queue and scheduled handlers, DLQ configuration |
| Control schema | new numbered file under `migrations/control` | OAuth attempts, outbox, delivery metadata, indexes, cleanup fields |
| Tests | `tests/onboarding.test.ts`, `tests/people.test.ts`, browser fixtures/tests | Extend existing identity/invitation invariants through protocol and UI boundaries |

The exact route-folder names may be adjusted to Next.js conventions during implementation, but the callback URL must remain the accepted `/auth/callback/google` contract.

## 11. Acceptance criteria

- Public production signup is no longer blocked by the “email delivery is not connected” message.
- A person can create an account and first workspace by verified password signup or Google.
- An existing person can sign in with a linked Google identity.
- A Google assertion colliding by email cannot access or silently modify the existing account.
- An owner/admin can send a real invitation, observe delivery state, resend with token rotation, and cancel it.
- A recipient can join the intended workspace with Google or password without receiving an unintended workspace.
- Wrong-email, expired, revoked, replayed, and held-for-plan invitations fail safely.
- Automated tests cover the security invariants and production configuration is documented.
- Cloudflare dashboards show acceptable delivery health; launch targets should remain above the provider's recommended 95% delivery rate and below its bounce/complaint thresholds.

## 12. Launch gates and risks

1. **Cloudflare Email Sending beta:** validate account access, daily quota, Gmail/Outlook deliverability, and lifecycle events before making it the sole production sender. Keep the sender interface provider-neutral.
2. **Queue consumer gap:** adding a queue consumer to `custom-worker.ts` is part of this work; configuring a producer alone does not deliver mail.
3. **Cross-storage provisioning:** D1 and Durable Objects are not one transaction. Workspace and membership creation must keep the existing pending/projection protocol and gain explicit retry/idempotency coverage.
4. **OAuth console lead time:** production domain verification, branding, privacy links, and client setup are operational dependencies, even with only basic identity scopes.
5. **Token leakage:** clean invitation URLs immediately, suppress query strings in logs/analytics, set no-referrer policy, and never render tokens into third-party resources.
6. **Account recovery:** Google-only accounts are valid for this release, but the onboarding/security UI should strongly encourage adding a passkey or password. Removing the last usable verified login method remains forbidden.

## 13. Explicit non-goals

- Replacing Lepidy identity with Google, Auth.js, Supabase Auth, or Cloudflare Access.
- Google Workspace domain allowlists or automatic workspace membership by email domain.
- Google API access beyond basic OIDC profile claims.
- Social providers other than Google.
- Bulk invitations, SCIM, SSO/SAML, or directory sync.
- Marketing campaigns or newsletters through the transactional sender.
- Full account-recovery redesign; only the hooks and notifications required by these flows are included.
