//! `lepidy rotate` — replacing a value, which only a person may do.
//!
//! Overwrites are deliberately not something an agent can reach: the write path
//! an agent has is `capture`, and `capture` is create-only precisely so a
//! prompt-injected agent cannot swap a token for the attacker's while
//! everything keeps appearing to work. Rotation is the human counterpart, run
//! at a terminal by somebody who already holds the key that opens the
//! credential.

use serde_json::json;
use zeroize::Zeroize;

use crate::args::Args;
use crate::client::Provenance;
use crate::crypto::{
    aes_gcm_encrypt, credential_aad, decode, encode, random_bytes, wrap_aad, wrap_dek, AAD_VERSION,
    CIPHER_SUITE, DEK_BYTES, IV_BYTES, WRAP_SUITE,
};
use crate::error::{CliError, CliResult};
use crate::prompt::read_secret;
use crate::run::catalogue;
use crate::session::Session;

pub fn run(args: &Args) -> CliResult<i32> {
    let name = args
        .positional(0)
        .ok_or_else(|| CliError::usage("name the credential: `lepidy rotate API_TOKEN`"))?
        .to_string();
    let session = Session::open()?;
    let project = session.project(args.option("project"));
    let catalogue = catalogue(&session, &project)?;
    let entry = catalogue.get(name.as_str()).ok_or_else(|| {
        CliError::failure(format!("{name} is not a credential this member can see"))
    })?;

    let password = read_secret("account password")?;
    let mut value = read_secret(&format!("new value for {name}"))?;
    if value.is_empty() {
        return Err(CliError::usage("a credential value may not be empty"));
    }

    // Every rotation is a new version with a new key. Re-using the old DEK would
    // mean anybody who kept a copy of it could still read the new value.
    let version = entry.version + 1;
    let mut dek = random_bytes(DEK_BYTES);
    let iv = random_bytes(IV_BYTES);
    let ciphertext = aes_gcm_encrypt(
        &dek,
        &iv,
        &credential_aad(&session.profile.workspace_id, &entry.id, version),
        value.as_bytes(),
    );
    value.zeroize();
    let ciphertext = ciphertext?;
    let wrap = wrap_dek(
        &decode(&session.profile.vault_public_key, "vault public key")?,
        &dek,
        &wrap_aad(
            &session.profile.workspace_id,
            &entry.id,
            version,
            &session.profile.member_id,
            session.profile.vault_key_epoch,
        ),
    );
    dek.zeroize();
    let wrap = wrap?;

    let response = session.client.post_signed(
        &session.profile,
        &session.signing,
        session.device_credential(),
        "/api/device/vault/rotate",
        &json!({
            "credentialId": entry.id,
            "password": password,
            "envelope": {
                "cipherSuite": CIPHER_SUITE,
                "aadVersion": AAD_VERSION,
                "version": version,
                "keyEpoch": entry.key_epoch + 1,
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
        }),
        Provenance::project(&project),
    )?;
    if response.status != 200 {
        return Err(CliError::failure(format!(
            "{name} was not rotated: {}",
            response.error_message()
        )));
    }

    println!("Rotated {name} to version {version}.");
    println!("Every grant on the old version was revoked; the next use asks again.");
    Ok(0)
}
