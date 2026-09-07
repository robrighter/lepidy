//! `lepidy login` — enrol this machine as a custodian client.
//!
//! Three things are generated here and two of them never leave: a device
//! signing key, a device encryption key and the vault wrapping key. Only their
//! public halves are sent. The passphrase and the recovery code are typed here
//! and are not sent at all, which is the whole basis of the claim that Lepidy
//! cannot open its own ciphertext — there is no request in this flow that could
//! carry the material needed to.

use serde_json::json;

use crate::args::Args;
use crate::client::Client;
use crate::crypto::{encode, public_jwk_from_sec1, DeviceSigningKey, VaultKeyPair};
use crate::error::{CliError, CliResult};
use crate::profile::{
    fresh_secrets, generate_recovery_code, save_profile, seal, Profile, PROFILE_VERSION,
};
use crate::prompt::{read_line_field, read_secret};

pub fn run(args: &Args) -> CliResult<i32> {
    let server = args.require("server")?;
    let workspace_slug = args.require("workspace")?;
    let kind = match args.option("kind").unwrap_or("client") {
        "client" => "client",
        "runner" => "runner",
        other => {
            return Err(CliError::usage(format!(
                "--kind must be client or runner, not {other:?}"
            )))
        }
    };
    let label = args
        .option("label")
        .map(str::to_string)
        .unwrap_or_else(|| format!("lepidy-cli on {}", hostname()));
    let project_id = args.option("project").unwrap_or("default").to_string();
    assert_identifier(&project_id, "project id")?;

    let client = Client::new(server)?;
    // Order matters and is documented, because under a pipe these three lines
    // are all the CLI has to go on.
    let email = read_line_field("account email")?;
    let password = read_secret("account password")?;
    let passphrase = read_secret("new local vault passphrase")?;
    if passphrase.chars().count() < 12 {
        return Err(CliError::usage(
            "the local vault passphrase must be at least 12 characters: it is the only thing protecting this machine's keys",
        ));
    }

    let signing = DeviceSigningKey::generate();
    let encryption = VaultKeyPair::generate();
    let vault = VaultKeyPair::generate();

    let response = client.post_unsigned(
        "/api/device/enroll",
        &json!({
            "email": email,
            "password": password,
            "workspaceSlug": workspace_slug,
            "label": label,
            "kind": kind,
            "signingPublicKey": signing.public_jwk(),
            "encryptionPublicKey": public_jwk_from_sec1(&encryption.public_key_bytes()),
            "vaultPublicKey": encode(&vault.public_key_bytes()),
        }),
    )?;
    if response.status != 200 {
        return Err(CliError::failure(format!(
            "enrolment refused: {}",
            response.error_message()
        )));
    }

    let body = &response.body;
    let text = |name: &str| -> CliResult<String> {
        body.get(name)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| CliError::failure(format!("the enrolment reply had no {name}")))
    };
    let number = |name: &str| -> CliResult<u64> {
        body.get(name)
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| CliError::failure(format!("the enrolment reply had no {name}")))
    };

    let device_id = text("deviceId")?;
    let workspace_id = text("workspaceId")?;
    let vault_key = body.get("vaultKey").cloned().unwrap_or(json!({}));
    let published = vault_key
        .get("published")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    // Zero means "this device holds no usable vault key". When the workspace
    // already has one for this member it belongs to a different client, so the
    // epoch it reports is not one this machine's private half matches.
    let vault_key_epoch = match published {
        true => vault_key
            .get("keyEpoch")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
        false => 0,
    };

    let secrets = fresh_secrets(text("deviceCredential")?, &signing, &vault);
    let recovery_code = generate_recovery_code();
    let profile = Profile {
        version: PROFILE_VERSION,
        server_url: client.base_url().to_string(),
        workspace_id: workspace_id.clone(),
        workspace_slug: text("workspaceSlug")?,
        member_id: text("memberId")?,
        authorization_epoch: number("authorizationEpoch")?,
        device_id: device_id.clone(),
        device_key_epoch: number("deviceKeyEpoch")?,
        project_id,
        vault_key_epoch,
        vault_public_key: encode(&vault.public_key_bytes()),
        passphrase: seal(&secrets, &passphrase, &device_id, &workspace_id)?,
        recovery: seal(&secrets, &recovery_code, &device_id, &workspace_id)?,
    };
    let path = save_profile(&profile)?;

    println!(
        "Enrolled device {device_id} for workspace {}.",
        profile.workspace_slug
    );
    println!("Profile: {}", path.display());
    println!();
    println!("Recovery code: {recovery_code}");
    println!("Write it down now. It opens this machine's keys if the passphrase is lost,");
    println!("it is not stored anywhere else, and Lepidy has never seen it — nobody can");
    println!("reissue it for you.");

    if !published {
        let reason = vault_key
            .get("reason")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("the workspace refused this device's vault key");
        println!();
        println!("This device cannot open credentials yet: {reason}.");
        println!("It can list credential metadata; adding and using values needs the client");
        println!("that holds this member's vault key.");
    }
    Ok(0)
}

fn hostname() -> String {
    for name in ["COMPUTERNAME", "HOSTNAME", "HOST"] {
        if let Ok(value) = std::env::var(name) {
            if !value.is_empty() {
                return value;
            }
        }
    }
    "this machine".to_string()
}

pub fn assert_identifier(value: &str, field: &str) -> CliResult<()> {
    let acceptable = !value.is_empty()
        && value.len() <= 128
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '.' | ':' | '-')
        });
    if acceptable {
        return Ok(());
    }
    Err(CliError::usage(format!(
        "{field} may only contain letters, digits, and _ . : -"
    )))
}
