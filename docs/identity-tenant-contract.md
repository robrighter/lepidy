# Identity and tenant contract

**Status:** Accepted  
**Decision:** D01  
**Date:** 2026-09-05  
**Applies to:** browser, PWA, Tauri, Worker, D1 control plane, workspace Durable Objects, MCP and runners

This contract fixes the identity and tenant boundaries that the schema and authorization code must preserve. The reference applications supplied useful account, invitation, handle and agent-author patterns, but both were single-tenant. Lepidy adapts those behaviors around tenant-local identities and a separate global account plane.

## 1. Origins, URLs and cookies

- The application origin is `https://app.lepidy.com`. Marketing may use `https://lepidy.com`.
- A workspace route is path-scoped: `https://app.lepidy.com/w/{workspace_slug}/…`. Custom tenant subdomains and custom domains are outside v1.
- The path form keeps one WebAuthn relying-party ID and one host-only session boundary while making the workspace explicit in every application link.
- The WebAuthn relying-party ID is `app.lepidy.com`; accepted web origins are the deployed `https://app.lepidy.com` origin and explicit localhost development origins. Origin lists are configuration, never inferred from a request host.
- OAuth callbacks terminate at `https://app.lepidy.com/auth/callback/{provider}`. Tauri opens authentication in the system browser and receives only an expiring, single-use authorization code through `lepidy://auth/callback`; it never receives a browser cookie through the deep link.
- The browser cookie is `__Host-lepidy_session`: `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, and no `Domain`. It contains an opaque random session token. D1 stores only a keyed hash of that token.
- Mutating browser requests require an allowed `Origin` plus a session-bound CSRF token. Next.js and KV must not cache authorization results.

This resolves the PRD's remaining URL question in favor of paths. Subdomains would either fragment passkey behavior or require a parent-domain credential and cookie design. Tenant routing is still explicit because every workspace resource begins with `/w/{workspace_slug}`.

## 2. Global and tenant-local identities

The D1 control plane owns global `account_id` values, login methods, passkeys, browser sessions, devices, workspace routing, invitations and the account-to-workspace membership index. An account may belong to many workspaces.

Every membership creates an immutable, random `member_id` inside that workspace. Workspace content refers to `member_id`, never `account_id`. The workspace Durable Object stores the local member projection and is authoritative for content authorization. The D1 membership row is authoritative for whether a request may reach the object.

Human, agent and group IDs are immutable and workspace-local. IDs are never reused. Deactivated or removed authors remain as tombstones so historical attribution survives. Messages store `author_kind`, `author_id` and a display snapshot; the live directory supplies current display details when the author remains active.

Handles share a workspace namespace:

- human handles may not begin with `a.` or `g.`;
- agent handles must begin with `a.`;
- group handles must begin with `g.`;
- comparisons use the normalized, case-insensitive handle;
- an agent is non-authenticating and acts only through an accountable human owner or a delegation derived from that owner.

The `account_id` to `member_id` mapping is private control data. It must not appear in message payloads, URLs, realtime tags visible to clients, audit actor fields or MCP tool results.

## 3. Login identity and safe linking

A login identity is uniquely keyed by `(provider, provider_subject)`. Email is an address and recovery channel, not an identity key.

- New accounts require control of a verified email through Lepidy or a provider assertion whose email is verified.
- A matching verified email never silently merges accounts.
- Linking a new provider requires an authenticated, fresh session, step-up with an existing strong method, successful proof from the new provider, and an explicit confirmation showing the destination account.
- If a sign-in returns an email already present on another account, the user must authenticate that existing account and complete the linking flow. Support cannot merge accounts in v1.
- The last usable verified login method cannot be removed. Changing the primary email means adding and verifying the new address before removing the old one.
- Invitations contain a hashed, expiring, single-use token and a normalized target email. Acceptance requires proof of that email; an already signed-in account with a different email must verify the invitation address before acceptance.

Password reset and account recovery revoke all browser sessions, outstanding auth challenges and recovery links. Account-compromise recovery additionally revokes passkeys selected by the user, runner registrations, MCP grants, delegations and active agent sessions across every workspace before the recovery operation reports success.

## 4. Sessions and revocation

Browser sessions, runner device credentials, MCP grants and agent-session credentials have separate identifiers, scopes and lifecycles. Signing out a browser does not silently stop a runner. The product provides explicit operations for one session, all other sessions, all browser sessions, one runner and all account authority.

Each account has a monotonic `security_epoch`; each membership has a monotonic `authorization_epoch`. Credentials carry the epochs current when issued. Every HTTP request and new WebSocket or MCP connection checks the authoritative D1 account, session and membership rows. Every workspace operation checks the tenant-local membership and epoch.

Cross-plane membership changes use a durable, idempotent operation:

1. D1 records the desired membership state, increments its version and writes a pending control operation in one transaction.
2. Privilege-increasing changes remain unusable at the edge until the workspace object acknowledges the same version.
3. Privilege-reducing changes are denied by D1 immediately. The Worker calls the workspace object, which applies the version atomically, increments the local epoch, closes affected sockets and invalidates local delegations and grants.
4. D1 records the acknowledgement. Failed delivery remains pending and is retried; version checks make repeats harmless.

For account-wide compromise recovery, D1 first increments `security_epoch` and denies all old credentials. It then fans a revocation operation to every workspace membership. Recovery reports completion only after every workspace acknowledges; until then the account remains globally locked. This fail-closed interval prevents an existing workspace connection from retaining authority after recovery.

Removing the last active workspace owner is rejected. Removing a member preserves authored content and audit attribution while denying every new request and terminating live workspace authority.

The tenant-local directory stores only workspace profile fields: display name,
title, IANA time zone, optional working-hours minutes and a short custom status.
Regular members receive active directory entries only; owners and administrators
also receive inactive tombstones for administration and attribution.

Presence has two independent halves. A member may declare `focus` or `away`,
and that declaration outranks live connection state for as long as it stands;
`auto` is the absence of a declaration, and only then is presence derived from
open workspace connections. Derived online state is never accepted as a profile
write.

A mention hovercard is a rendering of that same directory read and never a
second visibility rule: it is built from the entries the reader was already
authorized to receive, a handle absent from them renders as a plain name with
no card, and a former member's card says so rather than presenting them as
merely offline. An agent's card names its owners, because mentioning an agent
hands the message to every owner whether or not they could open that room; an
owner the reader cannot name is counted rather than omitted, so the list is
never shorter than the truth.

Group identities are immutable and use normalized `g.` handles. `g.here`,
`g.channel` and `g.everyone` remain reserved broadcast names. A group's creator,
an active administrator or an active owner may replace its membership or archive
it. Group mentions expand only to active members at send time, refuse an empty
group, and refuse combined fan-out above 50 rather than silently truncating it.

Invitations remain single-use and email-bound. An active duplicate membership or
pending invitation is refused. When the active-seat count has reached the paid
seat quantity, a new invitation is stored as held and cannot be accepted until
an owner or administrator explicitly confirms the seat change. This confirmation
is an entitlement acknowledgement; provider checkout and webhook reconciliation
remain the billing implementation's responsibility.

## 5. Required integration invariants

Implementation must prove these cases with local integration tests:

1. Two workspaces for one account receive different `member_id` values, and neither workspace can address the other's local author.
2. A verified-email collision does not link accounts without fresh authentication, step-up and explicit confirmation.
3. A revoked session fails on its next HTTP request and cannot reconnect a WebSocket.
4. Membership removal denies at the control-plane gate, closes active workspace sockets, invalidates local grants and is idempotent when replayed.
5. A privilege increase is unavailable until the workspace projection acknowledges the matching version.
6. Account recovery invalidates all old browser, runner, MCP and agent-session credentials across every joined workspace.
7. The session cookie has the exact host-only attributes above, and Tauri deep links exchange only single-use codes.
8. Historical content remains attributable after member deactivation or deletion without exposing a global account ID.

The control-plane schema test must also assert that D1 contains no message body, file bytes, credential material, agent brief, tenant audit event or other tenant content.
