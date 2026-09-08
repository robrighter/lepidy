//! Launch configuration, which lives here and only here.
//!
//! A preset says what actually runs: the program, its arguments, its working
//! directory, which credentials map to which environment variables, and the
//! harness's own safe default permission posture. None of that is ever sent to
//! the workspace, and there is no remote schema that could set it — the cloud
//! knows a preset only by the opaque name this file gave it.
//!
//! Two gates guard the file. It must be owned by the user running the daemon
//! and readable by nobody else, checked on every load rather than only on
//! write; and changing it requires unsealing the local keystore, which means
//! the passphrase, which means a person. A daemon that could edit its own
//! launch configuration on a message from the network would make every other
//! guarantee here decorative.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use lepidy_cli::error::{CliError, CliResult};
use lepidy_cli::profile::{profile_home, write_owner_only};
use serde::{Deserialize, Serialize};

pub const PRESET_FILE: &str = "presets.json";
pub const PRESET_VERSION: u32 = 1;

/// The harness's own non-interactive flags, and its own safe default posture.
///
/// Deliberately free text: Claude Code, Codex and a custom binary each spell
/// this differently, and asserting from here that a particular flag is safe on
/// a particular version would be a claim nobody has tested. R02 validates the
/// first real preset end to end and R04 owns the harness and OS matrix.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub id: String,
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub working_directory: Option<String>,
    /// Credential name to environment variable. The values are fetched at
    /// release time by the CLI; nothing here is a secret.
    #[serde(default)]
    pub credentials: BTreeMap<String, String>,
    /// Plain environment for the harness — flags it reads, a mode, a home
    /// directory. Set locally by the person who owns the machine and never by
    /// the workspace, which is the whole point: this is launch configuration,
    /// and launch configuration has exactly one author.
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
    /// The harness version this preset was last validated against (R04).
    ///
    /// Recorded by `preset check` and compared on every later check. A
    /// non-interactive flag, a default permission posture and an exit code can
    /// all change between versions, so a preset validated against one version
    /// and running under another is unvalidated — and saying so is the whole
    /// point of writing it down.
    #[serde(default)]
    pub harness_version: Option<String>,
    /// How many of this preset may run at once on this machine.
    #[serde(default = "default_concurrency")]
    pub max_concurrent: u32,
    /// The shortest gap between two starts, in seconds. A wake storm, a
    /// mention loop or an agent that answers itself all look the same from
    /// here, and all of them are stopped by the same rule.
    #[serde(default = "default_cooldown")]
    pub cooldown_seconds: u64,
    /// How long one run may take before it is killed, tree and all.
    #[serde(default = "default_timeout")]
    pub timeout_seconds: u64,
}

fn default_concurrency() -> u32 {
    1
}

fn default_cooldown() -> u64 {
    15
}

fn default_timeout() -> u64 {
    30 * 60
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetStore {
    pub version: u32,
    /// Bumped on every change and signed into every request afterwards, so a
    /// preset edited on this machine can be told apart from the one a session
    /// was started under.
    pub revision: u64,
    /// The last runner assignment this machine registered. Agent and preset
    /// ids are not launch configuration or secrets; retaining them lets a new
    /// daemon epoch re-register before opening its socket, fencing an older
    /// process instead of relying on two commands landing in the same second.
    #[serde(default)]
    pub runner_agents: BTreeMap<String, String>,
    #[serde(default)]
    pub runner_epoch: u64,
    pub presets: Vec<Preset>,
}

impl Default for PresetStore {
    fn default() -> Self {
        Self {
            version: PRESET_VERSION,
            revision: 1,
            runner_agents: BTreeMap::new(),
            runner_epoch: 0,
            presets: Vec::new(),
        }
    }
}

impl PresetStore {
    pub fn get(&self, preset_id: &str) -> Option<&Preset> {
        self.presets.iter().find(|preset| preset.id == preset_id)
    }

    /// Add or replace a preset, moving the revision on.
    pub fn upsert(&mut self, preset: Preset) {
        self.presets.retain(|existing| existing.id != preset.id);
        self.presets.push(preset);
        self.presets.sort_by(|a, b| a.id.cmp(&b.id));
        self.revision = self.revision.saturating_add(1);
    }

    /// Record what the harness reported, without moving the revision.
    ///
    /// Deliberately not an edit: pinning a version is this machine writing down
    /// what it observed, not somebody changing what runs, and bumping the
    /// revision would invalidate every live session for no reason.
    pub fn pin_harness_version(&mut self, preset_id: &str, version: Option<String>) -> bool {
        match self
            .presets
            .iter_mut()
            .find(|preset| preset.id == preset_id)
        {
            Some(preset) => {
                preset.harness_version = version;
                true
            }
            None => false,
        }
    }

    pub fn remove(&mut self, preset_id: &str) -> bool {
        let before = self.presets.len();
        self.presets.retain(|existing| existing.id != preset_id);
        let removed = self.presets.len() != before;
        if removed {
            self.revision = self.revision.saturating_add(1);
        }
        removed
    }
}

pub fn preset_path() -> PathBuf {
    profile_home().join(PRESET_FILE)
}

/// Read the preset store, refusing a file anybody else can reach.
///
/// The check is on every load, not only on write. A file that was created
/// correctly and later opened up — by a careless `chmod`, by a restore from a
/// backup, by being copied into a shared directory — is exactly the case worth
/// catching, and it is the case a write-time-only check misses.
pub fn load_presets_at(path: &Path) -> CliResult<PresetStore> {
    if !path.exists() {
        return Ok(PresetStore::default());
    }
    assert_owner_only(path)?;
    let bytes = std::fs::read(path).map_err(|error| {
        CliError::failure(format!("could not read {}: {error}", path.display()))
    })?;
    let store: PresetStore = serde_json::from_slice(&bytes).map_err(|error| {
        CliError::failure(format!("{} is not a preset file: {error}", path.display()))
    })?;
    if store.version != PRESET_VERSION {
        return Err(CliError::failure(format!(
            "{} was written by a different version of this runner",
            path.display()
        )));
    }
    Ok(store)
}

pub fn load_presets() -> CliResult<PresetStore> {
    load_presets_at(&preset_path())
}

pub fn save_presets_at(path: &Path, store: &PresetStore) -> CliResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            CliError::failure(format!("could not create {}: {error}", parent.display()))
        })?;
    }
    let bytes =
        serde_json::to_vec_pretty(store).map_err(|error| CliError::failure(error.to_string()))?;
    write_owner_only(path, &bytes)
}

/// Refuse a preset file that anybody but its owner can read or write.
///
/// On Unix this is the permission bits and the owning uid. On Windows it is the
/// file's discretionary ACL: a file whose access is granted to anybody beyond
/// its owner, `SYSTEM` and the administrators group is somebody else's launch
/// configuration waiting to run as this user.
pub fn assert_owner_only(path: &Path) -> CliResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        use std::os::unix::fs::PermissionsExt;

        let metadata = std::fs::metadata(path).map_err(|error| {
            CliError::failure(format!("could not inspect {}: {error}", path.display()))
        })?;
        let mode = metadata.permissions().mode() & 0o777;
        if mode & 0o077 != 0 {
            return Err(CliError::failure(format!(
                "{} is readable or writable by other users (mode {mode:o}); \
                 launch configuration must be owner-only",
                path.display()
            )));
        }
        // Owned by whoever is running this. A preset file belonging to another
        // account is somebody else's launch configuration, and running it would
        // be running their command as this user.
        let owner = metadata.uid();
        let running_as = current_uid()?;
        if owner != running_as {
            return Err(CliError::failure(format!(
                "{} is owned by uid {owner}, not by uid {running_as} running this daemon",
                path.display()
            )));
        }
    }
    #[cfg(windows)]
    {
        assert_windows_acl_is_owner_only(path)?;
    }
    #[cfg(not(any(unix, windows)))]
    let _ = path;
    Ok(())
}

/// The Windows half of the same question, asked through `icacls`.
///
/// Deliberately the documented command-line tool rather than the ACL API: this
/// crate forbids `unsafe`, the check is a startup-time question rather than a
/// hot path, and `icacls` output is what an administrator would look at to
/// answer the same question by hand — so a refusal here can be reproduced by
/// the person who has to fix it.
///
/// Only three principals may hold access: the file's owner, `SYSTEM`, and the
/// local administrators group. Anybody else — `Users`, `Everyone`, another
/// account — means this machine's launch configuration is not this user's
/// alone.
#[cfg(windows)]
fn assert_windows_acl_is_owner_only(path: &Path) -> CliResult<()> {
    use std::process::Command;

    let output = Command::new("icacls").arg(path).output().map_err(|error| {
        CliError::failure(format!("could not inspect {}: {error}", path.display()))
    })?;
    if !output.status.success() {
        return Err(CliError::failure(format!(
            "could not inspect the permissions of {}",
            path.display()
        )));
    }
    let rendered = String::from_utf8_lossy(&output.stdout);
    let user = std::env::var("USERNAME")
        .unwrap_or_default()
        .to_ascii_lowercase();
    for principal in lepidy_cli::profile::acl_principals(&rendered, &path.display().to_string())? {
        let lowered = principal.to_ascii_lowercase();
        let allowed = lowered.ends_with("\\system")
            || lowered == "nt authority\\system"
            || lowered.ends_with("\\administrators")
            || lowered == "builtin\\administrators"
            || (!user.is_empty() && lowered.ends_with(&format!("\\{user}")))
            || lowered == user;
        if !allowed {
            return Err(CliError::failure(format!(
                "{} grants access to {principal}; launch configuration must be owner-only",
                path.display()
            )));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn current_uid() -> CliResult<u32> {
    // Read rather than called: `getuid` is an unsafe extern, and this crate
    // forbids unsafe. `/proc/self/status` is the same answer on Linux, and the
    // metadata of a file this process just created is the answer everywhere
    // else Unix.
    if let Ok(status) = std::fs::read_to_string("/proc/self/status") {
        for line in status.lines() {
            if let Some(rest) = line.strip_prefix("Uid:") {
                if let Some(real) = rest.split_whitespace().next() {
                    if let Ok(uid) = real.parse::<u32>() {
                        return Ok(uid);
                    }
                }
            }
        }
    }
    uid_by_probe()
}

/// The owning uid of a file this process creates, which is this process's uid.
#[cfg(unix)]
fn uid_by_probe() -> CliResult<u32> {
    use std::os::unix::fs::MetadataExt;

    let probe = std::env::temp_dir().join(format!("lepidy-uid-probe-{}", std::process::id()));
    std::fs::write(&probe, b"").map_err(|error| {
        CliError::failure(format!("could not determine the current user: {error}"))
    })?;
    let uid = std::fs::metadata(&probe)
        .map(|metadata| metadata.uid())
        .map_err(|error| {
            CliError::failure(format!("could not determine the current user: {error}"))
        });
    let _ = std::fs::remove_file(&probe);
    uid
}

#[cfg(test)]
mod tests {
    use super::*;

    fn preset(id: &str) -> Preset {
        Preset {
            id: id.to_string(),
            program: "harness".to_string(),
            args: vec!["--non-interactive".to_string()],
            working_directory: None,
            credentials: BTreeMap::new(),
            environment: BTreeMap::new(),
            harness_version: None,
            max_concurrent: 1,
            cooldown_seconds: 15,
            timeout_seconds: 60,
        }
    }

    #[test]
    fn an_edit_moves_the_revision() {
        let mut store = PresetStore::default();
        assert_eq!(store.revision, 1);
        store.upsert(preset("a"));
        assert_eq!(store.revision, 2);
        // Replacing a preset is an edit too: a session started under the old
        // one must be distinguishable from one started now.
        store.upsert(preset("a"));
        assert_eq!(store.revision, 3);
        assert_eq!(store.presets.len(), 1);
        assert!(store.remove("a"));
        assert_eq!(store.revision, 4);
        // Removing something that was not there is not an edit.
        assert!(!store.remove("a"));
        assert_eq!(store.revision, 4);
    }

    #[test]
    fn pinning_a_version_is_not_an_edit() {
        let mut store = PresetStore::default();
        store.upsert(preset("a"));
        let revision = store.revision;
        assert!(store.pin_harness_version("a", Some("harness 1.2.3".to_string())));
        // The revision does not move: this machine wrote down what it observed,
        // it did not change what runs, and bumping the revision would strand
        // every live session for nothing.
        assert_eq!(store.revision, revision);
        assert_eq!(
            store
                .get("a")
                .and_then(|preset| preset.harness_version.clone()),
            Some("harness 1.2.3".to_string()),
        );
        assert!(!store.pin_harness_version("missing", None));
    }

    #[test]
    fn round_trips_through_an_owner_only_file() {
        let dir = std::env::temp_dir().join(format!("lepidy-preset-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("the temporary directory is writable");
        let path = dir.join("presets.json");
        let mut store = PresetStore::default();
        store.upsert(preset("default"));
        save_presets_at(&path, &store).expect("a fresh store saves");

        let loaded = load_presets_at(&path).expect("an owner-only file loads");
        assert_eq!(loaded.revision, 2);
        assert_eq!(
            loaded.get("default").map(|p| p.program.as_str()),
            Some("harness")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_file_other_users_can_read() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("lepidy-preset-open-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("the temporary directory is writable");
        let path = dir.join("presets.json");
        save_presets_at(&path, &PresetStore::default()).expect("a fresh store saves");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))
            .expect("the test can loosen the file it just wrote");

        let error =
            load_presets_at(&path).expect_err("a world-readable preset file must be refused");
        assert!(
            error.message.contains("owner-only"),
            "unexpected refusal: {}",
            error.message,
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_file_is_an_empty_store_rather_than_a_failure() {
        let path = std::env::temp_dir().join(format!("lepidy-absent-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let store = load_presets_at(&path).expect("an absent store is empty");
        assert!(store.presets.is_empty());
    }
}
