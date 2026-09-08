# Vault key and recovery contract

**Status:** Accepted  
**Decision:** D05a  
**Date:** 2026-09-06

**Implemented:** V07, 2026-09-08. The signed CLI recovery flow, opaque D1
recovery/device packages, client-side cryptography and epoch/rekey tests are the
executable realization of this contract.

Lepidy never stores the user's vault unlock secret or recovery code. Cloud storage may contain encrypted vault data and wrapped data keys, but no service-held secret is sufficient to decrypt them.

## Key creation

Vault setup runs in a signed native client or local CLI. It generates a random account vault key and a high-entropy recovery code locally. The recovery code wraps the account vault key through a memory-hard derivation and authenticated encryption. Platform secure storage protects additional device wraps. Remotely served browser/PWA code never receives root key material.

Only these values may reach Lepidy storage:

- encrypted credential records and encrypted metadata;
- the account vault key wrapped independently for enrolled devices/passkeys and by the recovery-code-derived key;
- version, salt, KDF parameters, nonce and integrity metadata;
- a one-way verification value that cannot recover the unlock secret.

The raw account vault key, passkey PRF output, recovery code, recovery-derived key, decrypted credential values and any equivalent server-decryptable root must never enter D1, a Durable Object, KV, R2, Queues, logs, traces, analytics, crash reports, notifications or MCP responses.

## Setup and recovery UX

Setup displays the recovery code once and requires the user to save it and confirm selected words/segments before the vault becomes active. Copy, print and encrypted-file export are local client actions. The UI states that Lepidy cannot retrieve the code and cannot recover vault data after all enrolled devices/passkeys and the code are lost.

Recovery downloads the encrypted wraps, derives the recovery key locally, unwraps the account vault key locally, and enrolls a new device wrap after user verification. The recovery code is never submitted for server comparison. Successful recovery rotates the account vault key wraps and offers a newly generated recovery code; old recovery material is invalidated by deleting its encrypted wrap.

Account recovery and vault recovery are separate. Regaining an email account may restore sign-in and channel access, but it does not bypass vault cryptography.

## Agent use

Local injection is performed by an unlocked local host and plaintext stays in the target process environment for the required lifetime. A cloud or remote agent can use a protected credential only while an enrolled online client performs the credential-bearing operation itself or injects into its own local child process. Cloud relays handle authenticated ciphertext and policy metadata only; they never receive an operation key capable of unwrapping a credential.

This decision removes the former server-root-key design. The proxy is device-mediated; multi-owner wrapping, native-client trust and release behavior are fixed by the [vault sharing and release contract](./vault-sharing-release-contract.md). Approval scope is fixed by the [vault authorization contract](./vault-authorization-contract.md).

## Required tests

1. Setup and recovery protocol captures contain no recovery code, raw vault key or derived recovery key.
2. Seeded secret canaries never occur in cloud databases, object storage, queues, logs, traces, notifications or MCP results.
3. Encrypted records cannot be decrypted with every server-held value and configuration available to the test.
4. A correct recovery code recovers locally; a wrong code fails authentication without an oracle beyond success/failure.
5. Losing devices without the recovery code leaves vault ciphertext unrecoverable while account recovery still succeeds.
6. Recovery rotation invalidates old wraps and interrupted rotation preserves at least one valid user-held recovery path.
