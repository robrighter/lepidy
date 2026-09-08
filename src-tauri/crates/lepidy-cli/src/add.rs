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

use crate::advice::CANARY_PREFIX;
use crate::args::Args;
use crate::crypto::random_bytes;
use crate::error::{CliError, CliResult};
use crate::login::assert_identifier;
use crate::prompt::read_secret;
use crate::seal::{seal_and_create, CreateRequest};
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
    let project = session.project(args.option("project"));
    let kind = match args.option("kind").unwrap_or("opaque") {
        kind @ ("opaque" | "structured") => kind,
        other => {
            return Err(CliError::usage(format!(
                "--kind must be opaque or structured, not {other:?}"
            )))
        }
    };
    let fields = args.list("field");
    if kind == "structured" && fields.is_empty() {
        return Err(CliError::usage(
            "a structured credential must name its fields: --field HOST --field PASSWORD",
        ));
    }
    let rotate_at = match args.option("rotate-at") {
        None => None,
        Some(value) => Some(parse_rotate_at(value)?),
    };

    let canary = args.flag("canary");
    if canary && kind == "structured" {
        return Err(CliError::usage(
            "a canary is one opaque value, not a structured record",
        ));
    }

    let password = read_secret("account password")?;
    // A canary is generated here and never asked for, because a canary somebody
    // typed is a canary somebody has a copy of. It is never printed either: its
    // whole purpose is to sit in the vault looking real until something steals
    // it, and a value on a terminal is a value in a scrollback buffer.
    let (mut value, canary_marker) = if canary {
        let tag = canary_tag();
        (canary_value(&tag), Some(format!("{CANARY_PREFIX}{tag}")))
    } else {
        (read_secret(&format!("value for {name}"))?, None)
    };
    if kind == "structured" {
        // A structured value is one JSON object carrying every field, so the
        // five parts of a database credential rotate together instead of four
        // of them being forgotten.
        let parsed: serde_json::Value = serde_json::from_str(&value).map_err(|_| {
            CliError::usage("a structured credential's value must be a JSON object")
        })?;
        let object = parsed.as_object().ok_or_else(|| {
            CliError::usage("a structured credential's value must be a JSON object")
        })?;
        for field in &fields {
            if !object.contains_key(field.as_str()) {
                return Err(CliError::usage(format!("the value has no {field} field")));
            }
        }
    }

    let credential_id = seal_and_create(
        &session,
        CreateRequest {
            name: &name,
            value: &mut value,
            description: args.option("description").unwrap_or(""),
            env_var: args.option("env-var"),
            tags: args.list("tag"),
            commands: args.list("command"),
            mode: &mode,
            deliveries: deliveries.clone(),
            kind,
            fields: fields.clone(),
            rotate_at,
            captured_from: None,
            high_risk: args.flag("high-risk"),
            policy_projects: project_ids,
            project: &project,
            password: &password,
            // A canary is always scannable: recognising it is the entire point,
            // and it is worthless, so a verifier for it discloses nothing.
            scannable: canary || !args.flag("no-scan"),
            canary_marker: canary_marker.clone(),
        },
    )?;

    println!("Added {name} as {credential_id}.");
    if canary {
        println!("This is a canary: a deliberately fake value that exists to be stolen.");
        println!("It was not printed, and nothing legitimate will ever use it. If it turns up");
        println!("in a message, a tool argument or a proxied request, that write is refused");
        println!("and its custodians are told.");
    }
    println!("Policy: {mode}; deliveries: {}.", deliveries.join(", "));
    if kind == "structured" {
        println!(
            "It expands into {}.",
            fields
                .iter()
                .map(|field| format!("{name}_{field}"))
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    println!("You are its only custodian: no other member's client can open it yet.");
    Ok(0)
}

/// The alphabet a canary uses: lowercase alphanumerics, so the value survives a
/// shell, a URL and a JSON document unchanged and is found wherever it lands.
const CANARY_ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";

fn canary_chars(count: usize) -> String {
    // Rejection sampling: 36 does not divide 256, so a plain modulo would make
    // the first sixteen characters of the alphabet slightly likelier. Bytes at
    // or above the largest multiple of 36 are discarded and drawn again, which
    // keeps every character uniform.
    let mut out = String::with_capacity(count);
    let limit = 252u8; // 36 * 7
    while out.len() < count {
        for byte in random_bytes(count) {
            if byte >= limit {
                continue;
            }
            out.push(CANARY_ALPHABET[(byte % 36) as usize] as char);
            if out.len() == count {
                break;
            }
        }
    }
    out
}

fn canary_tag() -> String {
    canary_chars(12)
}

fn canary_value(tag: &str) -> String {
    format!("{CANARY_PREFIX}{tag}-{}", canary_chars(32))
}

/// An ISO date, because a rotation nag people cannot read is one they ignore.
fn parse_rotate_at(value: &str) -> CliResult<i64> {
    let parts: Vec<&str> = value.split('-').collect();
    let numbers: Option<Vec<i64>> = parts.iter().map(|part| part.parse::<i64>().ok()).collect();
    let (Some(numbers), 3) = (numbers, parts.len()) else {
        return Err(CliError::usage("--rotate-at wants a date like 2027-01-31"));
    };
    let (year, month, day) = (numbers[0], numbers[1], numbers[2]);
    if !(1970..=9999).contains(&year) || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return Err(CliError::usage("--rotate-at wants a date like 2027-01-31"));
    }
    // Days since the epoch by the civil-calendar algorithm, then milliseconds.
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_shift = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * month_shift + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    Ok(days * 86_400_000)
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
    use super::*;

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

    /// VAULT-CLI-RULE-070
    #[test]
    fn a_canary_is_the_exact_shape_the_workspace_recognises() {
        let tag = canary_tag();
        assert_eq!(tag.len(), 12);
        assert!(tag
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()));
        let value = canary_value(&tag);
        assert_eq!(
            value,
            format!(
                "{CANARY_PREFIX}{tag}-{}",
                &value[CANARY_PREFIX.len() + 13..]
            )
        );
        assert_eq!(value.len(), CANARY_PREFIX.len() + 12 + 1 + 32);
        // Two canaries are never the same one.
        assert_ne!(canary_tag(), canary_tag());
    }
}
