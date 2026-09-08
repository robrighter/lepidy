# Vault sharing and release contract

**Status:** Accepted  
**Decision:** D05  
**Date:** 2026-09-06

**Implemented:** V07, 2026-09-08 for recovery, device packages and custodian
add/remove/rekey; V02 and V06 implement the local and device-proxy release
paths described below.

This contract lets a Team share credentials and lets remote agents use them without giving Lepidy a decryption root. It extends the [vault key/recovery](./vault-key-recovery-contract.md) and [authorization/approval](./vault-authorization-contract.md) contracts.

## 1. Account keys and recovery

The first signed native client creates:

- a random 256-bit account vault key (AVK);
- an account P-256 ECDH wrapping keypair whose private key is encrypted by the AVK;
- a high-entropy printable recovery code and Argon2id-derived recovery key that encrypts an AVK recovery package.

The public wrapping key, encrypted private key, encrypted AVK device wraps and encrypted recovery package may be stored in cloud. The private wrapping key, AVK, recovery code and derived recovery key exist only on enrolled clients. Every envelope carries an algorithm version, key epoch, nonce and authenticated context.

Web/PWA pages delivered by the Lepidy server never receive these keys. Vault creation, recovery, value entry, import, rotation and reveal run in a signed Tauri/native mobile client or local CLI. A bundled Tauri view may call narrow native crypto commands only from its packaged trusted origin. A remote page can inspect metadata and approve policy, but an enrolled native release device performs cryptographic release. This is the boundary required to withstand a compromised Worker serving altered JavaScript.

## 2. Credential envelopes and custodians

Each credential version has a random DEK and authenticated ciphertext. There is no server wrap. Instead, the DEK is independently sealed to the public wrapping key of each credential **custodian**. Custodians are active members explicitly holding `manage` for that credential; workspace ownership alone does not make someone a custodian or reveal values.

`use`, `reveal` and `manage` remain policy rights, not cryptographic claims. A use-authorized requester who is not a custodian receives only an approved operation on a specific device. A custodian client may technically decrypt a value and therefore is a high-trust role; the UI says this when granting `manage`.

Adding a custodian requires fresh WebAuthn user verification, an unlocked existing custodian client, proof of the recipient's active membership and current public-key epoch, and explicit confirmation. The existing client unwraps the DEK locally and uploads a new recipient-specific sealed wrap.

Removing the final custodian is refused. Removing another custodian creates a new credential version with a fresh DEK, re-encrypts the value on an unlocked remaining custodian device, creates wraps only for remaining custodians, advances the key/policy epoch, and revokes grants and pending releases. A former custodian may have retained plaintext or old keys; cryptography cannot erase prior access. Rotation protects current and future versions.

## 3. Device enrollment and loss

A new device generates its own non-exportable signing and P-256 ECDH keys. Enrollment requires a fresh user-verification ceremony and approval from an existing unlocked device, which sends an AVK wrap encrypted to the new device's public key through the opaque relay. The server stores the wrap and public keys but cannot open it. Recovery code enrollment follows the same result after local recovery.

Device removal increments the account vault epoch, deletes that device's wraps, revokes its sessions/grants/releases and causes active custodians to refresh device-access packages. Removing a device cannot retract plaintext previously exposed on it. Losing every device is recoverable only with the user-held code; losing both means permanent vault loss.

## 4. Release modes

All modes start with the D04 policy decision and a single-use release authorization bound to credential/version/policy epoch, requester/member, agent/delegation, origin, source release device, target device/project/config revision, delivery, expiry and request id.

### Same-device local injection

The unlocked custodian/release device decrypts locally and injects only into the approved child command or `0600` temporary file. No value enters the harness environment, stdout, arguments or cloud transport.

### Cross-device local injection

An unlocked custodian/release device encrypts a one-operation secret package to the registered target runner's current ECDH public key. The relay sees ciphertext. The runner verifies the release authorization and epochs, decrypts in memory, starts only its locally stored preset, and zeroizes/discards the package after the one attempt. It may not persist the value or expose it to the parent harness.

### Device-mediated HTTP proxy

The release device decrypts locally, validates scheme/host/port and every redirect against credential policy, blocks private destinations, attaches the credential, performs the bounded request, redacts the response and returns authenticated ciphertext. The Worker and cloud agent see only allowed response content. No available release device returns `vault_device_unavailable`.

The V06 implementation deliberately follows **no redirects** rather than
trying to approve a changing destination chain. It accepts HTTPS on port 443,
an exact policy host, and only `GET`, `POST`, `PUT`, `PATCH`, `DELETE` or
`HEAD`; caller headers are limited to `Accept`, `Content-Type` and
`Idempotency-Key`. The device resolves the whole DNS answer, refuses it if any
address is private or special-use, pins that answer for the connection, and
adds the credential only as `Authorization: Bearer …`. Request bodies are
bounded to 64 KiB, responses to 256 KiB, and the fetch to twenty seconds.

`proxy_request` is an idempotent asynchronous MCP operation. The first call
returns `pending`, the same key later returns the encrypted device result, and
the workspace never sends a second external request for that key. A request
expires after sixty seconds as `uncertain`, because absence of a response does
not prove absence of an upstream side effect. An enrolled release device must
both hold the current custodian wrap and have its authenticated outbound runner
socket open; otherwise the call immediately returns
`vault_device_unavailable`. Authorization is re-evaluated when the signed
device result arrives, and grant consumption, usage count, access count, result
state and audit append commit together. A refusal before that commit consumes
nothing.

The normalized URL, body and caller headers are encrypted to the release
device before durable storage or socket delivery. The credential envelope and
recipient wrap remain server-held ciphertext. The device returns only a small
response-header allowlist and an exact-secret-redacted body, encrypted under a
one-operation response key; audit carries identifiers, method, status and byte
count, never request or response bodies or authorization values.

### Reveal

Reveal and reveal-once render only in the signed native client after fresh initiating-human WebAuthn UV and local unlock. An agent cannot initiate reveal-once. Web/PWA pages may request that the native client open the flow but never receive plaintext.

## 5. Team, Solo and availability

Team stores credential ciphertext, public keys and wraps in its tenant DO; it still needs an enrolled release device online and unlocked for credential use. Solo stores credential ciphertext on its designated host. Encrypted account recovery/device packages may live in the account control plane for both plans because they reveal no secret.

Approving on a phone does not imply that the phone supplies the secret. The approval selects an eligible online release device or reports that none is available. Scheduled cloud agents therefore cannot use Lepidy credentials while every release device is offline or locked. Lepidy does not mirror values to a model provider's vault.

## 6. Epochs, restore and deletion

Account vault, credential key, policy, membership, device, delegation, host and target-config epochs are authenticated inputs. A stale value fails before decrypt or use. Restoring database ciphertext never rolls an authorization epoch backward and never revives a deleted wrap, device, grant or delegation. Clients keep the highest accepted epoch and require a fresh recovery/re-enrollment ceremony after an administrative restore mismatch.

Credential deletion removes live ciphertext and wraps, creates an irreversible deletion epoch and schedules backup expiry under D07. A user or former custodian may retain earlier plaintext; product copy does not claim remote erasure.

## 7. Required automated scenarios

1. With all server databases, objects, configuration and traffic captures, the test cannot decrypt a seeded credential or AVK package.
2. Adding a custodian creates only that recipient's wrap after current membership, key epoch, local unlock, UV and confirmation.
3. Removing a custodian rotates credential ciphertext/DEK, omits the removed recipient, revokes pending/granted work and rejects the old epoch; final-custodian removal fails atomically.
4. New-device enrollment and recovery occur locally; captured requests contain no AVK, private key, recovery code or recovery-derived key.
5. Same-device and cross-device injection bind the exact request and target preset revision; replay, target substitution and stale epochs fail without process launch.
6. The device proxy enforces redirects/private-network/size/time limits locally and cloud captures contain no credential or authorization header.
7. Web/PWA code has no API that returns an AVK, private wrapping key, DEK or credential plaintext.
8. Device loss, all-devices-offline, interrupted rotation, restore and concurrent owner removal preserve the documented fail-closed behavior.
