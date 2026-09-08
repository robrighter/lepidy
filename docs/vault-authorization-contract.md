# Vault authorization and approval contract

**Status:** Accepted  
**Decision:** D04  
**Date:** 2026-09-06

This contract decides whether a credential operation is denied, may proceed from an existing grant, may proceed automatically, or needs a human approval. It authorizes ciphertext handling and a release-device operation; it never authorizes a cloud decrypt because Lepidy has no vault root key.

## 1. Principals and ACL composition

A request has one accountable human `member_id`. An agent request additionally has `agent_id` and exactly one active delegation issued by that agent's owner. A request never combines rights from several owners.

Credential ACLs have independent `use`, `reveal` and `manage` verbs. `manage` does not imply `use` or `reveal`. `reveal` is additive: a reveal needs both `use` and `reveal`; inject, temporary-file and device-proxy delivery need `use`. Workspace administrators may freeze, revoke or delete inaccessible ciphertext for incident response, but their role does not grant use, reveal, approval or decryption.

For one verb, a matching direct-member, active-group, agent or originating-channel entry is a union: any one can establish the ACL portion. That result is then intersected with every mandatory boundary:

1. active workspace membership and current authorization epoch;
2. active credential and workspace agent-access switch;
3. verified origin and current channel access;
4. active registered device, valid request signature and unused nonce;
5. credential availability, delivery, project and rate policy;
6. for an agent, one unexpired delegation containing that agent, owner, channel, credential, delivery and project;
7. an exact live grant or the credential's `auto`/`ask` policy.

No broad ACL match can override a failed mandatory boundary. Missing state fails closed.

## 2. Provenance and signed device/project claims

The content authority proves the originating workspace, channel, message/task id, requesting member and agent mention. A caller-supplied channel or message id is not proof. Team requests bind to rows in the workspace DO; Solo requests bind to the designated host's signed assertion and current host epoch.

Every CLI/runner request is signed by its registered device key over the HTTP method, resource, canonical body hash, workspace id, member id and authorization epoch, device id, timestamp, unique nonce, request id, opaque local project id, local configuration revision, and optional agent/delegation/origin ids. The server accepts a five-minute clock window and atomically records the nonce before policy evaluation. Replay, body changes, a revoked device, stale membership/host/configuration epoch, or a device owned by another member fails before an approval is created.

Paths, commands and environment values are absent. An approval may show the non-secret locally chosen project/preset label already registered for display; the cloud cannot use that label to change local execution.

## 3. Delegation intersection

A delegation is `(workspace, agent, owner member, channels, credential ids, delivery modes, project ids, expires_at, authorization_epoch, spend/rate ceilings)`. It is narrower than the owner's live authority and is re-evaluated on every request. Owner removal/suspension, agent ownership change, credential version/policy change, device revoke or delegation expiry denies use and revokes grants derived from it.

Connected agents use the current authenticated owner session and do not need an unattended delegation. Local, cloud and custom autonomous agents always do. The audit record names requester, agent, operating owner, delegation, device/project, origin and approver separately.

## 4. Step-up matrix

| Operation | Required user presence |
|---|---|
| Automatic inject/file/device-proxy use | Valid signed device request and an unlocked signed-native release device; no new prompt |
| `ask` inject/file/device-proxy approval | Approver WebAuthn assertion with user verification, at most five minutes old and bound to the approval id/digest |
| Reveal or reveal-once | Initiating human's fresh WebAuthn UV plus an unlocked signed native client; an agent cannot initiate reveal-once |
| Add/change credential value, policy, ACL or owners; delete; enroll/remove owner/device wrap; rotate/recover vault | Fresh WebAuthn UV and local vault unlock |
| Turn agent access off, deny, revoke grant/device/delegation | No step-up; protective actions remain easy |
| Turn agent access on | Fresh WebAuthn UV |

Email-link-only sessions may chat but cannot satisfy any vault step-up. An approval assertion is single-use and cannot authorize a different digest or batch.

## 5. Approval and batching

An approval stores credential ids and versions, policy epochs, requester tuple, origin digest, requested delivery, reason, expiry and eligible approver member ids. It contains no ciphertext or key material. First terminal transition wins through one conditional transaction: `pending → allowed | denied | expired`. Timeout is denial and agents receive a stop-and-report hint rather than an invitation to retry elsewhere.

A batch contains at most ten credentials and only requests sharing the exact workspace, requester/member, agent/delegation, device/project, origin, delivery, reason, expiry and eligible-approver set. Each credential remains an independent decision row. The card lists every name and policy; the approver may allow or deny each. One WebAuthn assertion binds the ordered decision digest. Credentials added or changed after the digest require a new approval.

## 6. Grant identity and lifecycle

A grant key is `(credential_id, credential_version, policy_epoch, member_id, device_id, project_id, agent_id?, delegation_id?, delivery)`. It cannot widen across any field. Expiry is exclusive. No TTL means one successful use; a TTL grant permits uses until expiry subject to the live rate ceiling. Grant consumption, usage count and audit append are atomic with authorization of the operation.

All affected grants are revoked on credential value/policy/ACL change, workspace agent-access off, member/device/delegation revoke, owner/agent relationship change, project/configuration revision invalidation, vault rotation or explicit revoke. Turning access back on never restores grants.

## 7. Leak detection and canaries

**Implemented:** V08, 2026-09-08.

Two detectors, with different authority and different honesty about what they
find.

A **scan target** is a digest of one credential value, plus its length, computed
by the trusted client that sealed the value and bound to workspace, credential
and version. It lets a client answer "does this text contain a credential"
without the value leaving the vault. It is served only over the signed device
transport, only to a member who already holds a verb on that credential, and
only when that credential's client published one. Two limits are normative and
must be stated wherever the feature is described: it detects an **exact, whole,
unencoded** value and nothing else, and a digest is a **verifier**, so a
low-entropy value becomes offline-guessable to anybody who obtains one. Values
below eight characters never get a target, and a client may withhold one.

A **canary** is a deliberately fake credential whose value is generated on a
trusted client as a public marker plus a random tag. The marker is stored in
cleartext metadata, is not a secret, and lets the workspace recognise the value
in content it already receives without holding a key. A message, MCP tool
argument or proxied request body carrying a canary marker is **refused before
the write**, recorded as a durable trip, appended to the audit chain as
`vault.canary_tripped` with outcome `denied`, and reported to that credential's
custodians. No body, excerpt or value is stored with the trip. A trip freezes
nothing: refusing the write is the mitigation, and a canary is never a working
credential, so a deliberate trip costs nothing.

Neither detector is authorization. Both are evidence, and the ordered decision
in §1 is unchanged by either.

## 8. Required automated scenarios

1. ACL entries union within a verb, while membership, device, origin, policy and delegation failures each override a match.
2. An agent cannot combine one owner's channel rights with another owner's credential rights.
3. Signed request replay, body mutation, stale epochs and cross-member device use fail without an approval or durable credential-use record.
4. Reveal requires `use + reveal`, a fresh initiating-human assertion and local unlock; `manage` alone never reveals.
5. Approval first-answer-wins, assertion digest binding, expiry and mixed per-item batch decisions are atomic and restart-safe.
6. Exact grant tuple matching, exclusive expiry, single-use consumption and every revocation trigger are exercised.
7. Cloud captures contain no plaintext credential, vault/recovery key, path, command or environment value.
8. Scan targets reach a member holding a verb on the credential and no other valid member; a rotation replaces the target or clears it; a malformed digest, an under-length value and a duplicate canary marker are refused with no partial row.
9. A canary in a person's message, an agent's post and a proxy request body is refused before the write, leaves no message or request row, records one trip and one audit entry with no excerpt, and tells the custodians.
