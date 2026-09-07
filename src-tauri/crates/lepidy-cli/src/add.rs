//! `lepidy add` — create a credential from this machine.
//!
//! The value is read from the terminal, encrypted here, and only then sent. A
//! fresh DEK seals the value under the credential's own authenticated context;
//! the DEK is then sealed to this member's published wrapping key and wiped.
//! What crosses the network is two ciphertexts and no key, which is why a
//! compromised Worker learns nothing from watching this command.
//!
//! Custodianship is deliberately narrow at creation: this member, and nobody
//! else. Adding a second custodian means an existing unlocked client sealing the
//! DEK for them, which is V07's device and sharing work.

use serde_json::json;
use zeroize::Zeroize;

use crate::args::Args;
use crate::client::Provenance;
use crate::crypto::{
    credential_aad, decode, encode, random_bytes, wrap_aad, wrap_dek, AAD_VERSION, CIPHER_SUITE,
    DEK_BYTES, IV_BYTES, WRAP_SUITE,
};
use crate::error::{CliError, CliResult};
use crate::login::assert_identifier;
use crate::prompt::read_secret;
use crate::session::Session;

pub fn run(args: &Args) -> CliResult<i32> {
    let name = args
        .positional(0)
        .ok_or_else(|| CliError::usage("name the credential: `lepidy add API_TOKEN`"))?
        .to_string();
    if !is_credential_name(&name) {
        return Err(CliError::usage(
            "a credential name is upper case letters, digits and underscores, starting with a letter",
        ));
    }
    let mode = match args.option("mode").unwrap_or("ask") {
        mode @ ("ask" | "auto" | "never") => mode.to_string(),
        other => {
            return Err(CliError::usage(format!(
                "--mode must be ask, auto or never, not {other:?}"
            )))
        }
    };
    let deliveries = match args.list("delivery").as_slice() {
        [] => vec!["inject".to_string()],
        listed => {
            for delivery in listed {
                if !matches!(
                    delivery.as_str(),
                    "inject" | "file" | "device_proxy" | "reveal"
                ) {
                    return Err(CliError::usage(format!(
                        "{delivery:?} is not a delivery this vault knows"
                    )));
                }
            }
            listed.to_vec()
        }
    };
    let project_ids = args.list("policy-project");
    for project in &project_ids {
        assert_identifier(project, "project id")?;
    }

    let session = Session::open()?;
    if session.profile.vault_key_epoch == 0 {
        return Err(CliError::failure(
            "this device has no registered vault key, so it cannot seal a value. Use the client that holds this member's vault key.",
        ));
    }
    let project = session.project(args.option("project"));

    let password = read_secret("account password")?;
    let mut value = read_secret(&format!("value for {name}"))?;
    if value.is_empty() {
        return Err(CliError::usage("a credential value may not be empty"));
    }

    let credential_id = format!("cred-{}", encode(&random_bytes(16)));
    let workspace_id = session.profile.workspace_id.clone();
    let mut dek = random_bytes(DEK_BYTES);
    let iv = random_bytes(IV_BYTES);
    let aad = credential_aad(&workspace_id, &credential_id, 1);
    let ciphertext = crate::crypto::aes_gcm_encrypt(&dek, &iv, &aad, value.as_bytes());
    value.zeroize();
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
    // The value is sealed and the wrap is made; nothing below needs the key
    // again, so it stops existing before a single byte goes to the network.
    dek.zeroize();
    let wrap = wrap?;

    let body = json!({
        "credentialId": credential_id,
        "idempotencyKey": format!("cli:add:{credential_id}"),
        "password": password,
        "metadata": {
            "name": name,
            "description": args.option("description").unwrap_or(""),
            "envVar": args.option("env-var").unwrap_or(&name),
            "tags": args.list("tag"),
            "commands": args.list("command"),
            "proxyHosts": args.list("proxy-host"),
        },
        "policy": {
            "mode": mode,
            "allowedDeliveries": deliveries,
            "projectIds": project_ids,
            "highRisk": args.flag("high-risk"),
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

    let response = session.client.post_signed(
        &session.profile,
        &session.signing,
        session.device_credential(),
        "/api/device/vault/credentials",
        &body,
        Provenance::project(&project),
    )?;
    if response.status != 200 {
        return Err(CliError::failure(format!(
            "that credential was refused: {}",
            response.error_message()
        )));
    }

    println!("Added {name} as {credential_id}.");
    println!("Policy: {mode}; deliveries: {}.", deliveries.join(", "));
    println!("You are its only custodian: no other member's client can open it yet.");
    Ok(0)
}

fn is_credential_name(name: &str) -> bool {
    let mut characters = name.chars();
    let first_is_upper = characters
        .next()
        .is_some_and(|first| first.is_ascii_uppercase());
    first_is_upper
        && name.len() <= 64
        && characters.all(|character| {
            character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
        })
}

#[cfg(test)]
mod tests {
    use super::is_credential_name;

    /// VAULT-CLI-RULE-023
    #[test]
    fn accepts_the_names_the_workspace_accepts() {
        assert!(is_credential_name("API_TOKEN"));
        assert!(is_credential_name("T"));
        assert!(!is_credential_name("api_token"));
        assert!(!is_credential_name("1TOKEN"));
        assert!(!is_credential_name("API-TOKEN"));
        assert!(!is_credential_name(""));
    }
}
