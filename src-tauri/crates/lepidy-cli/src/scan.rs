//! `lepidy scan` — does this text contain a credential the vault holds?
//!
//! Adapted from Agent Vault's `crates/av-cli/src/scan.rs` at
//! `d794820084151eddbdbb56bf9cd10b5bf3666cdc`. Its shape is preserved — compare
//! digests, never values, and walk one window per known length — and its source
//! of truth is replaced: a local daemon over a unix socket becomes the advice
//! cache written by an authenticated command, because a `pre-commit` hook has
//! no terminal to read a passphrase from.
//!
//! Intended wiring is exactly that hook. It is the cheapest thing in the whole
//! product and it catches the precise accident Lepidy exists to prevent.
//!
//! # What it finds, and what it does not
//!
//! It finds an **exact, whole, unencoded** value. A base64'd secret, one that
//! has been JSON-escaped, one printed a character per line, or one whose
//! credential has no published digest all go straight through. One digest per
//! value cannot detect a substring and this command never claims it can — the
//! clean message says so, because a scanner people over-trust is worse than no
//! scanner at all.
//!
//! Canaries are found differently and more reliably: their marker is public, so
//! a plain substring search finds one wherever it appears.

use std::io::Read;

use crate::advice::{load, Advice, MAX_SCAN_BYTES, MIN_SCAN_LENGTH};
use crate::args::Args;
use crate::crypto::sha256_base64url;
use crate::error::{CliError, CliResult};

/// What a scan found: credential names, never anything from the text itself.
pub fn matches(text: &[u8], advice: &Advice, credentials: &[Credential]) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();

    // Canaries first: a public marker, so one substring search each.
    for (name, marker) in advice.canaries() {
        if find_bytes(text, marker.as_bytes()).is_some() && !found.contains(&name.to_string()) {
            found.push(name.to_string());
        }
    }

    // Then the digests, grouped by length so each window size is walked once.
    let mut lengths: Vec<usize> = credentials.iter().map(|entry| entry.length).collect();
    lengths.sort_unstable();
    lengths.dedup();
    for length in lengths {
        if length < MIN_SCAN_LENGTH || length > text.len() {
            continue;
        }
        let candidates: Vec<&Credential> = credentials
            .iter()
            .filter(|entry| entry.length == length)
            .collect();
        for window in text.windows(length) {
            for candidate in &candidates {
                if candidate.matches(window) && !found.contains(&candidate.name) {
                    found.push(candidate.name.clone());
                }
            }
        }
    }
    found.sort();
    found
}

/// One credential's published verifier, with everything needed to rebuild the
/// exact preimage the client hashed when it sealed the value.
pub struct Credential {
    pub name: String,
    pub digest: String,
    pub length: usize,
    pub workspace_id: String,
    pub credential_id: String,
    pub version: u64,
}

impl Credential {
    fn matches(&self, window: &[u8]) -> bool {
        window.len() == self.length
            && sha256_base64url(&crate::advice::scan_digest_preimage(
                &self.workspace_id,
                &self.credential_id,
                self.version,
                window,
            )) == self.digest
    }
}

pub fn run(args: &Args) -> CliResult<i32> {
    let target = args
        .positional(0)
        .ok_or_else(|| CliError::usage("name a file or `-` for standard input: `lepidy scan -`"))?
        .to_string();

    let advice = if args.flag("refresh") {
        let session = crate::session::Session::open()?;
        let project = session.project(args.option("project"));
        crate::advice::refresh(&session, &project)?
    } else {
        match load() {
            Some(advice) => advice,
            None => {
                // Fail open, loudly. A commit hook that refused every commit
                // because a cache was missing would be removed within a day,
                // and then it protects nothing at all.
                eprintln!(
                    "lepidy: no local credential list yet, so nothing was checked. \
                     Run `lepidy scan --refresh {target}` once to build one."
                );
                return Ok(0);
            }
        }
    };

    let mut text = Vec::new();
    if target == "-" {
        std::io::stdin()
            .take(MAX_SCAN_BYTES as u64)
            .read_to_end(&mut text)?;
    } else {
        let file = std::fs::File::open(&target)
            .map_err(|error| CliError::failure(format!("could not read {target}: {error}")))?;
        std::io::BufReader::new(file)
            .take(MAX_SCAN_BYTES as u64)
            .read_to_end(&mut text)?;
    }

    let credentials: Vec<Credential> = advice
        .credentials
        .iter()
        .filter_map(|entry| {
            Some(Credential {
                name: entry.name.clone(),
                digest: entry.digest.clone()?,
                length: entry.length?,
                workspace_id: advice.workspace_id.clone(),
                credential_id: entry.id.clone(),
                // Every published digest describes the credential's current
                // version, which is the version the listing reported alongside
                // it. A rotation replaces both together.
                version: entry.version,
            })
        })
        .collect();

    let found = matches(&text, &advice, &credentials);
    if found.is_empty() {
        if !args.flag("quiet") {
            println!("clean: no credential value this machine knows about appears in {target}.");
            println!(
                "This finds a whole unencoded value. An encoded, split or unknown secret is not detected."
            );
        }
        return Ok(0);
    }

    if args.flag("quiet") {
        println!("{}", found.join(","));
    } else {
        eprintln!(
            "STOP: {target} contains the value of {}.\n\
             Do not commit it. Use `lepidy run --with {} -- <command>` instead of pasting the value, \n\
             and rotate the credential if it has already been shared.",
            found.join(", "),
            found.join(",")
        );
    }
    Ok(1)
}

/// First occurrence of `needle` in `haystack`.
pub fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::advice::{scan_target_for, AdviceEntry, ADVICE_VERSION, CANARY_PREFIX};

    fn advice(entries: Vec<AdviceEntry>) -> Advice {
        Advice {
            version: ADVICE_VERSION,
            workspace_id: "ws".into(),
            workspace_slug: "slug".into(),
            refreshed_at: 0,
            credentials: entries,
        }
    }

    fn target(name: &str, id: &str, value: &str) -> (AdviceEntry, Credential) {
        let sealed = scan_target_for("ws", id, 1, value).expect("a target");
        let digest = sealed["digest"].as_str().expect("a digest").to_string();
        (
            AdviceEntry {
                id: id.into(),
                name: name.into(),
                env_var: name.into(),
                digest: Some(digest.clone()),
                length: Some(value.len()),
                version: 1,
                ..AdviceEntry::default()
            },
            Credential {
                name: name.into(),
                digest,
                length: value.len(),
                workspace_id: "ws".into(),
                credential_id: id.into(),
                version: 1,
            },
        )
    }

    /// VAULT-CLI-RULE-049
    #[test]
    fn finds_a_whole_value_and_nothing_else() {
        let value = "lepidy-synthetic-canary-4f2a91c7";
        let (entry, credential) = target("PROBE_TOKEN", "cred-a", value);
        let advice = advice(vec![entry]);
        assert_eq!(
            matches(
                format!("Authorization: Bearer {value}").as_bytes(),
                &advice,
                &[credential],
            ),
            vec!["PROBE_TOKEN".to_string()]
        );
    }

    /// VAULT-CLI-RULE-050
    #[test]
    fn a_near_miss_is_not_a_match() {
        let value = "lepidy-synthetic-canary-4f2a91c7";
        let (entry, credential) = target("PROBE_TOKEN", "cred-a", value);
        let advice = advice(vec![entry]);
        for text in [
            "nothing to see here at all".to_string(),
            // One character different.
            "lepidy-synthetic-canary-4f2a91c8".to_string(),
            // The right length, the wrong bytes.
            "x".repeat(value.len()),
            // Encoded: the documented limit, asserted rather than assumed.
            "bGVwaWR5LXN5bnRoZXRpYy1jYW5hcnktNGYyYTkxYzc=".to_string(),
        ] {
            assert!(
                matches(text.as_bytes(), &advice, std::slice::from_ref(&credential)).is_empty(),
                "{text} should not have matched"
            );
        }
    }

    /// VAULT-CLI-RULE-051
    #[test]
    fn a_canary_is_found_by_its_public_marker() {
        let marker = format!("{CANARY_PREFIX}abcdefabcdef");
        let advice = advice(vec![AdviceEntry {
            id: "cred-trap".into(),
            name: "TRAP".into(),
            env_var: "TRAP".into(),
            canary_marker: Some(marker.clone()),
            ..AdviceEntry::default()
        }]);
        let value = format!("{marker}-0123456789abcdef0123456789abcdef");
        assert_eq!(
            matches(format!("token={value}").as_bytes(), &advice, &[]),
            vec!["TRAP".to_string()]
        );
        assert!(matches(b"token=nothing", &advice, &[]).is_empty());
    }

    /// VAULT-CLI-RULE-052
    #[test]
    fn a_digest_from_another_credential_never_matches() {
        // The preimage is bound to the credential id and version, so a digest
        // moved from one entry to another cannot be made to match by supplying
        // the right bytes.
        let value = "long-enough-value-here";
        let (_, credential) = target("PROBE_TOKEN", "cred-a", value);
        let moved = Credential {
            credential_id: "cred-b".into(),
            ..credential
        };
        let advice = advice(vec![]);
        assert!(matches(value.as_bytes(), &advice, &[moved]).is_empty());
    }
}
