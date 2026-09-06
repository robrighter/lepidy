# Free local workspace contract

**Status:** Accepted  
**Decision:** D08a  
**Date:** 2026-09-06  
**Applies to:** Solo plan, Worker, D1, workspace relay Durable Object, Tauri host, web/mobile clients, MCP and cloud agents

Solo remains the complete one-human product and remains reachable over the internet. Its designated desktop or laptop is the authority for channel content. Cloudflare authenticates, routes and relays; it does not persist that content.

## 1. Storage boundary

The cloud control plane keeps account, session, device, workspace, plan and routing records. The workspace relay Durable Object keeps lightweight tenant metadata:

- member, agent and group identities needed for authorization and addressing;
- channel ID, name, slug, type, membership/access rules, ordering and archive state;
- the designated host device ID, monotonic host epoch, connection status and last-seen time;
- schema/feature compatibility, control-operation acknowledgements and idempotency metadata;
- aggregate channel activity such as last activity time and unread counts, without message excerpts or search terms.

The designated host's local SQLite database keeps channel content:

- message bodies, edits, threads, replies, reactions and message-level read state;
- attachments and previews, using local files referenced by SQLite;
- full-text indexes, saved searches, drafts and scheduled content;
- agent queues, briefs, session transcripts and content-bearing audit events;
- vault ciphertext, local grants and other secret-bearing workspace data unless a later custody decision explicitly places a class in cloud storage.

A Solo relay database must not contain message bodies, thread bodies, reaction rows, attachment bytes or names, full-text terms, drafts, agent briefs, credential ciphertext, or content-bearing audit payloads. Metadata values must not contain content excerpts.

## 2. Internet access and data path

The host maintains an outbound hibernatable WebSocket to its workspace relay object. It opens no listening port and needs no inbound firewall rule.

For a remote operation:

1. The Worker validates the browser, device, MCP or agent credential and current D1 membership.
2. The relay validates workspace metadata policy and a current host lease.
3. The remote client and host use an authenticated encrypted session; the relay forwards opaque frames and routing metadata.
4. The host validates the signed actor assertion, authorizes against its local projection, executes one local SQLite transaction and returns a response carrying the request id.
5. The relay forwards the encrypted response/event to authorized connected clients without storing its content.

Mutation request IDs are persisted on the host. If a response is lost, retrying cannot duplicate a message or action. A successful acknowledgement means the host transaction committed, so a following read routed to the same host sees that write or a newer one.

Cloud logs, queues, analytics and push payloads contain identifiers, event class and coarse counts only. Push text is generic for Solo unless an online client supplies locally decrypted presentation.

## 3. Offline behavior

When the designated host is offline:

- authentication, settings and the cloud-backed channel list remain available;
- channel history, search, attachments, vault operations and content-bearing agent tools are unavailable;
- new messages and commands fail immediately with `host_offline`; the cloud does not queue plaintext or ciphertext content for later storage;
- clients may show an explicitly marked local cache read-only, but it is never presented as current;
- scheduled work records a missed-host outcome according to the runner contract rather than silently running later.

This is a core Solo plan property shown during workspace creation and in persistent host status UI.

## 4. One authoritative host

D1 names one designated host device and a monotonic `host_epoch`. The relay grants at most one active writer lease for that epoch. Every content request and acknowledgement carries it.

- Reconnection by the same host resumes the current epoch.
- Replacing the host requires a fresh user-verified step-up and increments the epoch, fencing the former host immediately.
- Transfer uses an encrypted export from the old host to the new host, verifies database integrity and attachment inventory, then changes authority. The epoch changes only after the new host confirms a complete import.
- If the old host is lost, a new empty Solo host may be designated. Content recovery requires a user-held backup; Lepidy cannot reconstruct content it never stored.
- Local export and encrypted backup reminders are included. Automatic Lepidy cloud backup belongs to a paid cloud workspace.

## 5. Upgrade to Team

Upgrade is a resumable migration, not a routing toggle:

1. Provision the cloud workspace Durable Object and freeze local writes briefly.
2. Stream an encrypted, checksummed export from the host, including attachments, into the tenant's cloud stores.
3. Validate row counts, referential integrity, file hashes and the final local sequence.
4. Replay any operations after the export watermark, then atomically change `storage_mode` from `local_host` to `cloud` and increment the routing epoch.
5. Keep the local database as an explicitly labeled backup until the user deletes it.

No invitation for a second human is accepted until this migration has completed and Team entitlement is active.

## 6. Required automated integration scenarios

1. A Solo workspace persists channel metadata in its relay database and content only in the host SQLite fixture.
2. Cloud schema and captured logs contain no seeded content canary after create, read, search, reaction, attachment and agent operations.
3. A remote mutation commits locally before acknowledgement and a retried request id returns the original result.
4. Disconnecting the host makes content operations return `host_offline` while channel metadata remains readable.
5. Two hosts cannot hold the writer lease; an epoch change fences the old host and rejects delayed frames.
6. An unauthorized account, wrong workspace token or stale membership cannot relay to the host.
7. Relay restart and WebSocket hibernation preserve metadata and reconnect behavior without persisting content frames.
8. A resumable Solo-to-Team migration produces an equivalent cloud fixture before routing changes, including an interrupted and resumed upload.

The paid Team path continues to use one SQLite-backed workspace Durable Object as the authority for content, realtime and transactional behavior.
