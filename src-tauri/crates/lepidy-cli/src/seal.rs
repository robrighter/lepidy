//! Sealing a value and creating the credential that holds it.
//!
//! One path, used by `add`, `capture` and `import`, because the three differ
//! only in where the value came from. What they have in common is the part that
//! matters: a fresh DEK, an envelope bound to this workspace, credential and
//! version, a wrap sealed to this member's own key, and the value wiped before
//! a single byte goes to the network.

use serde_json::json;
use zeroize::Zeroize;

use crate::client::Provenance;
use crate::crypto::{
    aes_gcm_encrypt, credential_aad, decode, encode, random_bytes, wrap_aad, wrap_dek, AAD_VERSION,
    CIPHER_SUITE, DEK_BYTES, IV_BYTES, WRAP_SUITE,
};
use crate::error::{CliError, CliResult};
use crate::session::Session;

pub struct CreateRequest<'a> {
    pub name: &'a str,
    /// Wiped here, whatever happens next.
    pub value: &'a mut String,
    pub description: &'a str,
    pub env_var: Option<&'a str>,
    pub tags: Vec<String>,
    pub commands: Vec<String>,
    pub mode: &'a str,
    pub deliveries: Vec<String>,
    pub kind: &'a str,
    pub fields: Vec<String>,
    pub rotate_at: Option<i64>,
    /// The program whose output became this value, when one did.
    pub captured_from: Option<&'a str>,
    pub high_risk: bool,
    pub policy_projects: Vec<String>,
    pub project: &'a str,
    /// Creating a credential is a step-up, and this is the evidence for it.
    pub password: &'a str,
    /// Publish a digest of the value so `lepidy scan` and the hook can
    /// recognise it in text. A digest is a verifier for that exact value, so
    /// this is a deliberate choice per credential rather than an assumption.
    pub scannable: bool,
    /// The public half of a canary value, when this credential is one.
    pub canary_marker: Option<String>,
}

/// Seal the value and create the credential. Returns its id.
pub fn seal_and_create(session: &Session, request: CreateRequest<'_>) -> CliResult<String> {
    if session.profile.vault_key_epoch == 0 {
        return Err(CliError::failure(
            "this device has no registered vault key, so it cannot seal a value. Use the client that holds this member's vault key.",
        ));
    }
    if request.value.is_empty() {
        return Err(CliError::usage("a credential value may not be empty"));
    }

    let credential_id = format!("cred-{}", encode(&random_bytes(16)));
    let workspace_id = session.profile.workspace_id.clone();
    // Computed before the value is wiped, and only from what is already here:
    // the workspace never sees a value, so it can never compute one of these.
    let scan = if request.scannable {
        crate::advice::scan_target_for(&workspace_id, &credential_id, 1, request.value)
    } else {
        None
    };
    let mut dek = random_bytes(DEK_BYTES);
    let iv = random_bytes(IV_BYTES);
    let ciphertext = aes_gcm_encrypt(
        &dek,
        &iv,
        &credential_aad(&workspace_id, &credential_id, 1),
        request.value.as_bytes(),
    );
    request.value.zeroize();
    let ciphertext = ciphertext?;

    let wrap = wrap_dek(
        &decode(&session.profile.vault_public_key, "vault public key")?,
        &dek,
        &wrap_aad(
            &workspace_id,
            &credential_id,
            1,
            &session.profile.member_id,
            session.profile.vault_key_epoch,
        ),
    );
    // Sealed and wrapped; nothing below needs the key again, so it stops
    // existing before anything goes to the network.
    dek.zeroize();
    let wrap = wrap?;

    let mut metadata = json!({
        "name": request.name,
        "description": request.description,
        "envVar": request.env_var.unwrap_or(request.name),
        "tags": request.tags,
        "commands": request.commands,
        "proxyHosts": [],
        "kind": request.kind,
        "fields": request.fields,
    });
    if let Some(rotate_at) = request.rotate_at {
        metadata["rotateAt"] = json!(rotate_at);
    }

    let mut body = json!({
        "credentialId": credential_id,
        "idempotencyKey": format!("cli:create:{credential_id}"),
        "password": request.password,
        "metadata": metadata,
        "policy": {
            "mode": request.mode,
            "allowedDeliveries": request.deliveries,
            "projectIds": request.policy_projects,
            "highRisk": request.high_risk,
        },
        "envelope": {
            "cipherSuite": CIPHER_SUITE,
            "aadVersion": AAD_VERSION,
            "version": 1,
            "keyEpoch": 1,
            "iv": encode(&iv),
            "ciphertext": encode(&ciphertext),
        },
        "wraps": [{
            "custodianMemberId": session.profile.member_id,
            "recipientKeyEpoch": session.profile.vault_key_epoch,
            "wrapSuite": WRAP_SUITE,
            "ephemeralPublicKey": encode(&wrap.ephemeral_public_key),
            "iv": encode(&wrap.iv),
            "wrappedDek": encode(&wrap.wrapped_dek),
        }],
        "acl": [
            { "subjectType": "member", "subjectId": session.profile.member_id, "verb": "manage" },
            { "subjectType": "member", "subjectId": session.profile.member_id, "verb": "use" },
        ],
    });
    if let Some(captured_from) = request.captured_from {
        body["capturedFrom"] = json!(captured_from);
    }
    if let Some(scan) = scan {
        body["scan"] = scan;
    }
    if let Some(marker) = &request.canary_marker {
        body["canaryMarker"] = json!(marker);
    }

    let response = session.client.post_signed(
        &session.profile,
        &session.signing,
        session.device_credential(),
        "/api/device/vault/credentials",
        &body,
        Provenance::project(request.project),
    )?;
    if response.status != 200 {
        return Err(CliError::failure(format!(
            "{} was refused: {}",
            request.name,
            response.error_message()
        )));
    }
    Ok(credential_id)
}
