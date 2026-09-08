//! The local advice cache — what `scan`, `hint` and `hook` read.
//!
//! # Why a cache exists at all
//!
//! Every authenticated command in this CLI opens the sealed keystore first,
//! which means reading the local vault passphrase from a terminal. Three of the
//! surfaces in V08 cannot do that: a `pre-commit` hook has no terminal, and a
//! `PreToolUse` hook runs on every Bash tool call and has milliseconds. So the
//! advice they give comes from a file written by a command that *was*
//! authenticated, and never from a fresh request.
//!
//! The consequence is stated rather than hidden: **advice can be stale.** A
//! credential added on another machine is invisible here until the next
//! refresh, and a scan of a file containing it will say "clean". That is
//! acceptable precisely because none of these surfaces is a boundary — they
//! teach and they warn, and the thing that actually decides whether a value may
//! be released is the workspace's policy engine, which is asked afresh, over a
//! signed request, every single time.
//!
//! # What is in it
//!
//! Names, environment variables, the commands each credential is associated
//! with, each canary's public marker, and — for credentials whose client
//! published one — a digest of the value and its length. No ciphertext, no
//! wrap, no value.
//!
//! A digest is a verifier: anybody holding it can confirm a guess offline. It
//! sits next to the sealed keystore on the same machine, under the same
//! owner-only permissions, which is the same exposure the profile already has
//! and no more. A credential whose value was too short for a digest, or whose
//! creator passed `--no-scan`, simply has none here.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::client::Provenance;
use crate::error::{CliError, CliResult};
use crate::profile::profile_home;
use crate::session::Session;

/// Values shorter than this never get a digest, on either side. Below it a
/// window match is more likely to be ordinary text than a secret, and a
/// verifier is cheapest to brute force.
pub const MIN_SCAN_LENGTH: usize = 8;

/// What a scan will walk. A `pre-commit` hook pointed at a large binary should
/// come back quickly rather than reading it all.
pub const MAX_SCAN_BYTES: usize = 4 * 1024 * 1024;

pub const SCAN_DIGEST_CONTEXT: &str = "lepidy-scan-v1";
pub const CANARY_PREFIX: &str = "lpdy-canary-";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdviceEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub env_var: String,
    /// The credential version the digest below describes. A rotation replaces
    /// both together, so a cache that is one rotation behind stops matching
    /// rather than matching the wrong thing.
    #[serde(default)]
    pub version: u64,
    #[serde(default)]
    pub commands: Vec<String>,
    /// Base64url SHA-256 of the value, bound to workspace, credential and
    /// version. Absent when the credential has no published target.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length: Option<usize>,
    /// The public half of a canary value. Not a secret.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canary_marker: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Advice {
    pub version: u32,
    pub workspace_id: String,
    pub workspace_slug: String,
    pub refreshed_at: u64,
    pub credentials: Vec<AdviceEntry>,
}

pub const ADVICE_VERSION: u32 = 1;

pub fn advice_path() -> PathBuf {
    profile_home().join("advice.json")
}

/// Read the cache, or nothing at all.
///
/// Every failure — missing, unreadable, a version this build does not know —
/// is `None`, and `None` makes every rule that depends on it silent. A hook
/// that failed closed on a bad cache file would block every command the agent
/// runs, which is far worse than missing a coaching moment.
pub fn load() -> Option<Advice> {
    load_at(&advice_path())
}

pub fn load_at(path: &Path) -> Option<Advice> {
    let text = std::fs::read_to_string(path).ok()?;
    let advice: Advice = serde_json::from_str(&text).ok()?;
    if advice.version != ADVICE_VERSION {
        return None;
    }
    Some(advice)
}

/// Ask the workspace for both halves and write them down.
///
/// Two requests, because they are two different disclosures: metadata anybody
/// who can list may see, and scan targets, which are verifiers and are served
/// only to a member who already holds a verb on the credential.
pub fn refresh(session: &Session, project: &str) -> CliResult<Advice> {
    let listing = session.client.post_signed(
        &session.profile,
        &session.signing,
        session.device_credential(),
        "/api/device/vault/list",
        &json!({}),
        Provenance::project(project),
    )?;
    if listing.status != 200 {
        return Err(CliError::failure(format!(
            "could not read the credential list: {}",
            listing.error_message()
        )));
    }
    let targets = session.client.post_signed(
        &session.profile,
        &session.signing,
        session.device_credential(),
        "/api/device/vault/scan-targets",
        &json!({}),
        Provenance::project(project),
    )?;
    if targets.status != 200 {
        return Err(CliError::failure(format!(
            "could not read the scan targets: {}",
            targets.error_message()
        )));
    }

    let mut credentials: Vec<AdviceEntry> = Vec::new();
    for credential in listing
        .body
        .get("credentials")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let text = |field: &str| {
            credential
                .get(field)
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        let name = text("name");
        if name.is_empty() {
            continue;
        }
        let env_var = match text("envVar").as_str() {
            "" => name.clone(),
            value => value.to_string(),
        };
        credentials.push(AdviceEntry {
            id: text("id"),
            name,
            env_var,
            version: credential
                .get("version")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(1),
            commands: credential
                .get("commands")
                .and_then(serde_json::Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(|value| value.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default(),
            digest: None,
            length: None,
            canary_marker: None,
        });
    }

    for target in targets
        .body
        .get("targets")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let id = target
            .get("credentialId")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string();
        let Some(entry) = credentials.iter_mut().find(|entry| entry.id == id) else {
            continue;
        };
        entry.digest = target
            .get("digest")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        entry.length = target
            .get("length")
            .and_then(serde_json::Value::as_u64)
            .map(|value| value as usize);
        entry.canary_marker = target
            .get("canaryMarker")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
    }

    let advice = Advice {
        version: ADVICE_VERSION,
        workspace_id: session.profile.workspace_id.clone(),
        workspace_slug: session.profile.workspace_slug.clone(),
        refreshed_at: now_millis(),
        credentials,
    };
    write(&advice_path(), &advice)?;
    Ok(advice)
}

/// Write the cache owner-only, the same way the profile is written.
pub fn write(path: &Path, advice: &Advice) -> CliResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let text = serde_json::to_string_pretty(advice).map_err(|error| {
        CliError::failure(format!("could not encode the advice cache: {error}"))
    })?;
    std::fs::write(path, text)?;
    restrict(path)?;
    Ok(())
}

#[cfg(unix)]
fn restrict(path: &Path) -> CliResult<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn restrict(path: &Path) -> CliResult<()> {
    // The profile directory is already per-user on Windows and the file
    // inherits its access-control list; there is no portable mode bit to set.
    let _ = path;
    Ok(())
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

impl Advice {
    /// Every credential this cache can match a value for.
    pub fn scan_targets(&self) -> Vec<(&str, &str, usize)> {
        self.credentials
            .iter()
            .filter_map(|entry| match (&entry.digest, entry.length) {
                (Some(digest), Some(length)) if length >= MIN_SCAN_LENGTH => {
                    Some((entry.name.as_str(), digest.as_str(), length))
                }
                _ => None,
            })
            .collect()
    }

    pub fn canaries(&self) -> Vec<(&str, &str)> {
        self.credentials
            .iter()
            .filter_map(|entry| {
                entry
                    .canary_marker
                    .as_deref()
                    .map(|marker| (entry.name.as_str(), marker))
            })
            .collect()
    }

    pub fn names(&self) -> Vec<&str> {
        self.credentials
            .iter()
            .map(|entry| entry.name.as_str())
            .collect()
    }

    /// Both the credential's name and the variable it injects as, because a
    /// command can print either.
    pub fn variables(&self) -> Vec<&str> {
        let mut variables: Vec<&str> = Vec::new();
        for entry in &self.credentials {
            for candidate in [entry.name.as_str(), entry.env_var.as_str()] {
                if !candidate.is_empty() && !variables.contains(&candidate) {
                    variables.push(candidate);
                }
            }
        }
        variables
    }
}

/// What is hashed to produce a scan digest.
///
/// The context line binds the digest to one credential version in one
/// workspace, so a digest lifted from elsewhere never matches. This is the same
/// preimage `src/domain/vault-canary.ts` builds; the two must agree exactly or
/// nothing a client seals will ever be found by a scan.
pub fn scan_digest_preimage(
    workspace_id: &str,
    credential_id: &str,
    version: u64,
    value: &[u8],
) -> Vec<u8> {
    let mut preimage =
        format!("{SCAN_DIGEST_CONTEXT}\n{workspace_id}\n{credential_id}\n{version}\n").into_bytes();
    preimage.extend_from_slice(value);
    preimage
}

/// The scan target for a value, when it is long enough to have one.
pub fn scan_target_for(
    workspace_id: &str,
    credential_id: &str,
    version: u64,
    value: &str,
) -> Option<serde_json::Value> {
    if value.len() < MIN_SCAN_LENGTH {
        return None;
    }
    let digest = crate::crypto::sha256_base64url(&scan_digest_preimage(
        workspace_id,
        credential_id,
        version,
        value.as_bytes(),
    ));
    Some(json!({ "digest": digest, "length": value.len() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// VAULT-CLI-RULE-041
    #[test]
    fn a_short_value_gets_no_scan_target() {
        assert!(scan_target_for("ws", "cred", 1, "short").is_none());
        let target = scan_target_for("ws", "cred", 1, "long-enough-value").expect("a target");
        assert_eq!(target["length"], 17);
        assert_eq!(target["digest"].as_str().map(str::len), Some(43));
    }

    /// VAULT-CLI-RULE-042
    #[test]
    fn a_digest_is_bound_to_workspace_credential_and_version() {
        let base = scan_target_for("ws", "cred", 1, "long-enough-value").expect("a target");
        for other in [
            scan_target_for("other", "cred", 1, "long-enough-value"),
            scan_target_for("ws", "other", 1, "long-enough-value"),
            scan_target_for("ws", "cred", 2, "long-enough-value"),
        ] {
            assert_ne!(base["digest"], other.expect("a target")["digest"]);
        }
    }

    /// VAULT-CLI-RULE-043
    #[test]
    fn a_cache_that_cannot_be_read_is_no_cache_at_all() {
        let dir = std::env::temp_dir().join(format!("lepidy-advice-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("a directory");
        let missing = dir.join("absent.json");
        assert!(load_at(&missing).is_none());

        let broken = dir.join("broken.json");
        std::fs::write(&broken, b"{ not json").expect("a file");
        assert!(load_at(&broken).is_none());

        // A cache written by a different build of this CLI is ignored rather
        // than half-read: an entry whose shape changed would give advice the
        // rules were not written for.
        let stale = dir.join("stale.json");
        std::fs::write(&stale, br#"{"version":99,"workspaceId":"ws","workspaceSlug":"w","refreshedAt":0,"credentials":[]}"#).expect("a file");
        assert!(load_at(&stale).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// VAULT-CLI-RULE-044
    #[test]
    fn a_written_cache_reads_back_with_only_the_facts_advice_needs() {
        let dir = std::env::temp_dir().join(format!("lepidy-advice-w-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("a directory");
        let path = dir.join("advice.json");
        let advice = Advice {
            version: ADVICE_VERSION,
            workspace_id: "ws".into(),
            workspace_slug: "slug".into(),
            refreshed_at: 1,
            credentials: vec![
                AdviceEntry {
                    id: "cred-a".into(),
                    name: "API_TOKEN".into(),
                    env_var: "API_TOKEN".into(),
                    commands: vec!["housectl".into()],
                    version: 1,
                    digest: Some("A".repeat(43)),
                    length: Some(20),
                    canary_marker: None,
                },
                AdviceEntry {
                    id: "cred-b".into(),
                    name: "TRAP".into(),
                    env_var: "TRAP".into(),
                    commands: vec![],
                    version: 1,
                    digest: None,
                    length: None,
                    canary_marker: Some(format!("{CANARY_PREFIX}abcdefabcdef")),
                },
            ],
        };
        write(&path, &advice).expect("a written cache");
        let text = std::fs::read_to_string(&path).expect("the cache");
        // Whatever else changes, a value must never be one of the things in it.
        assert!(!text.contains("ciphertext"));
        assert!(!text.contains("wrappedDek"));

        let read = load_at(&path).expect("a cache");
        assert_eq!(read.scan_targets().len(), 1);
        assert_eq!(read.canaries().len(), 1);
        assert_eq!(read.names(), vec!["API_TOKEN", "TRAP"]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
