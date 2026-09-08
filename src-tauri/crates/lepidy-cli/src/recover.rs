//! `lepidy recover` — recover a lost custodian device without sending the code.
//!
//! The replacement device signs every request with its own key. It downloads
//! only an Argon2id/AES-GCM package, opens the old wrapping key locally, unwraps
//! each current credential DEK, and atomically publishes a fresh wrapping key
//! plus every replacement wrap. A new recovery package then invalidates the old
//! code. No plaintext credential is needed for this rekey.

use serde::Deserialize;
use serde_json::json;
use zeroize::Zeroize;

use crate::args::Args;
use crate::client::{Client, Provenance};
use crate::crypto::{decode, encode, wrap_aad, wrap_dek, VaultKeyPair, WRAP_SUITE};
use crate::error::{CliError, CliResult};
use crate::profile::{generate_recovery_code, load_profile, save_profile, seal, unseal};
use crate::prompt::read_secret;
use crate::recovery::{open_recovery_package, seal_recovery_package, RecoveryPackage};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MemberKey {
    key_epoch: u64,
}

#[derive(Deserialize)]
struct Envelope {
    version: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredWrap {
    custodian_member_id: String,
    recipient_key_epoch: u64,
    ephemeral_public_key: String,
    iv: String,
    wrapped_dek: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RekeyCredential {
    credential_id: String,
    envelope: Envelope,
    wrap: StoredWrap,
}

#[derive(Deserialize)]
struct RekeyMaterial {
    key: MemberKey,
    credentials: Vec<RekeyCredential>,
}

pub fn run(_args: &Args) -> CliResult<i32> {
    let mut profile = load_profile()?;
    if profile.vault_key_epoch != 0 {
        return Err(CliError::usage(
            "this device already holds the registered vault key; recovery is only for a replacement device",
        ));
    }
    let passphrase = read_secret("local vault passphrase")?;
    let mut secrets = unseal(&profile, &passphrase)?;
    let signing = secrets.signing_key()?;
    let client = Client::new(&profile.server_url)?;
    let recovery_code = read_secret("recovery code")?;

    let downloaded = client.post_signed(
        &profile,
        &signing,
        &secrets.device_credential,
        "/api/device/vault/recovery",
        &json!({ "action": "read" }),
        Provenance::project(&profile.project_id),
    )?;
    if downloaded.status != 200 {
        return Err(CliError::failure(format!(
            "recovery package was unavailable: {}",
            downloaded.error_message()
        )));
    }
    let package: RecoveryPackage = serde_json::from_value(downloaded.body["package"].clone())
        .map_err(|_| CliError::failure("the recovery reply was malformed"))?;
    let mut old_scalar = open_recovery_package(&profile.account_id, &recovery_code, &package)?;
    let old_key = VaultKeyPair::from_scalar(&old_scalar)?;
    old_scalar.zeroize();
    let password = read_secret("account password")?;

    let material_response = client.post_signed(
        &profile,
        &signing,
        &secrets.device_credential,
        "/api/device/vault/member-key/material",
        &json!({ "password": password }),
        Provenance::project(&profile.project_id),
    )?;
    if material_response.status != 200 {
        return Err(CliError::failure(format!(
            "vault rekey preparation was refused: {}",
            material_response.error_message()
        )));
    }
    let material: RekeyMaterial = serde_json::from_value(material_response.body)
        .map_err(|_| CliError::failure("the vault rekey reply was malformed"))?;
    if material.key.key_epoch != package.vault_epoch {
        return Err(CliError::failure(
            "the recovery package is stale for the current vault key epoch",
        ));
    }

    let next_key = VaultKeyPair::generate();
    let next_epoch = material.key.key_epoch + 1;
    let mut replacements = Vec::with_capacity(material.credentials.len());
    for credential in material.credentials {
        if credential.wrap.custodian_member_id != profile.member_id {
            return Err(CliError::failure(
                "the server returned another custodian's wrap",
            ));
        }
        let old_aad = wrap_aad(
            &profile.workspace_id,
            &credential.credential_id,
            credential.envelope.version,
            &profile.member_id,
            credential.wrap.recipient_key_epoch,
        );
        let mut dek = old_key.unwrap_dek(
            &decode(
                &credential.wrap.ephemeral_public_key,
                "ephemeral public key",
            )?,
            &decode(&credential.wrap.iv, "wrap iv")?,
            &decode(&credential.wrap.wrapped_dek, "wrapped DEK")?,
            &old_aad,
        )?;
        let next_aad = wrap_aad(
            &profile.workspace_id,
            &credential.credential_id,
            credential.envelope.version,
            &profile.member_id,
            next_epoch,
        );
        let wrapped = wrap_dek(&next_key.public_key_bytes(), &dek, &next_aad);
        dek.zeroize();
        let wrapped = wrapped?;
        replacements.push(json!({
            "credentialId": credential.credential_id,
            "credentialVersion": credential.envelope.version,
            "wrap": {
                "custodianMemberId": profile.member_id,
                "recipientKeyEpoch": next_epoch,
                "wrapSuite": WRAP_SUITE,
                "ephemeralPublicKey": encode(&wrapped.ephemeral_public_key),
                "iv": encode(&wrapped.iv),
                "wrappedDek": encode(&wrapped.wrapped_dek),
            }
        }));
    }

    let next_recovery_code = generate_recovery_code();
    secrets.vault_private_key = encode(&next_key.scalar_bytes());
    profile.vault_public_key = encode(&next_key.public_key_bytes());
    profile.vault_key_epoch = next_epoch;
    profile.passphrase = seal(
        &secrets,
        &passphrase,
        &profile.device_id,
        &profile.workspace_id,
    )?;
    profile.recovery = seal(
        &secrets,
        &next_recovery_code,
        &profile.device_id,
        &profile.workspace_id,
    )?;
    // Save the new local path first. If either network mutation fails, the old
    // cloud recovery package/code still opens the old path, or this profile
    // opens the new one; there is never a point with neither.
    save_profile(&profile)?;

    let rotated = client.post_signed(
        &profile,
        &signing,
        &secrets.device_credential,
        "/api/device/vault/member-key/rotate",
        &json!({
            "expectedKeyEpoch": material.key.key_epoch,
            "publicKey": profile.vault_public_key,
            "replacements": replacements,
            "password": password,
            "confirmed": true,
        }),
        Provenance::project(&profile.project_id),
    )?;
    if rotated.status != 200 {
        return Err(CliError::failure(format!(
            "vault key rotation was refused: {}",
            rotated.error_message()
        )));
    }
    let next_package = seal_recovery_package(
        &profile.account_id,
        package.vault_epoch + 1,
        &next_recovery_code,
        &next_key.scalar_bytes(),
    )?;
    let recovery_rotated = client.post_signed(
        &profile,
        &signing,
        &secrets.device_credential,
        "/api/device/vault/recovery",
        &json!({
            "action": "rotate",
            "expectedVaultEpoch": package.vault_epoch,
            "package": next_package,
            "password": password,
            "confirmed": true,
        }),
        Provenance::project(&profile.project_id),
    )?;
    if recovery_rotated.status != 200 {
        return Err(CliError::failure(format!(
            "the vault key was recovered, but recovery-code rotation needs retrying: {}",
            recovery_rotated.error_message()
        )));
    }

    println!("Recovered this device and rotated the vault key to epoch {next_epoch}.");
    println!("New recovery code: {next_recovery_code}");
    println!("The old recovery package and every old credential wrap are now invalid.");
    Ok(0)
}
