//! The local profile: what this machine knows, and what it keeps sealed.
//!
//! Two kinds of thing live here. The plain part is addressing — which
//! deployment, workspace, member and device this client is, and which epochs it
//! last saw. The sealed part is the material that makes this a *custodian*
//! client: the device signing key, the device credential and the vault wrapping
//! private key.
//!
//! The sealing key is derived from a passphrase this machine never sends
//! anywhere, so Lepidy cannot open the keystore even with the whole file. That
//! is also what makes a valid signed request meaningful evidence of a local
//! unlock: the signing key is inside the sealed blob, so a request can only be
//! signed by a process that had the passphrase.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use crate::crypto::{
    decode, derive_local_key, encode, random_bytes, DeviceSigningKey, VaultKeyPair, DEK_BYTES,
    IV_BYTES,
};
use crate::error::{CliError, CliResult};

pub const PROFILE_VERSION: u32 = 1;
/// 64 MiB, three passes. Expensive enough to matter against an offline attack
/// on a stolen profile, cheap enough that unlocking a CLI is not a coffee break.
pub const ARGON_MEMORY_KIB: u32 = 65_536;
pub const ARGON_ITERATIONS: u32 = 3;
pub const ARGON_LANES: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SealedKeystore {
    pub kdf: String,
    pub memory_kib: u32,
    pub iterations: u32,
    pub lanes: u32,
    pub salt: String,
    pub iv: String,
    pub sealed: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub version: u32,
    pub server_url: String,
    pub workspace_id: String,
    pub workspace_slug: String,
    pub member_id: String,
    pub authorization_epoch: u64,
    pub device_id: String,
    pub device_key_epoch: u64,
    pub project_id: String,
    pub vault_key_epoch: u64,
    /// The public half only. The private half is inside `passphrase`/`recovery`.
    pub vault_public_key: String,
    pub passphrase: SealedKeystore,
    /// A second copy of the same material under the recovery code, so losing
    /// the passphrase is survivable without Lepidy holding anything.
    pub recovery: SealedKeystore,
}

/// What the sealed blob contains once opened. Wiped on drop, and never written
/// anywhere unsealed.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Secrets {
    pub device_credential: String,
    pub device_signing_key: String,
    pub vault_private_key: String,
}

impl Drop for Secrets {
    fn drop(&mut self) {
        self.device_credential.zeroize();
        self.device_signing_key.zeroize();
        self.vault_private_key.zeroize();
    }
}

impl Secrets {
    pub fn signing_key(&self) -> CliResult<DeviceSigningKey> {
        Ok(DeviceSigningKey::from_scalar(&decode(
            &self.device_signing_key,
            "device signing key",
        )?)?)
    }

    pub fn vault_key(&self) -> CliResult<VaultKeyPair> {
        Ok(VaultKeyPair::from_scalar(&decode(
            &self.vault_private_key,
            "vault private key",
        )?)?)
    }
}

/// Where the profile lives.
///
/// `LEPIDY_HOME` wins when set — a runner, a second workspace and the test
/// suite all need their own, and none of them should be editing the developer's
/// real profile to get it.
pub fn profile_home() -> PathBuf {
    if let Some(home) = std::env::var_os("LEPIDY_HOME") {
        return PathBuf::from(home);
    }
    if cfg!(windows) {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            return PathBuf::from(appdata).join("Lepidy");
        }
    }
    if let Some(config) = std::env::var_os("XDG_CONFIG_HOME") {
        return PathBuf::from(config).join("lepidy");
    }
    match std::env::var_os("HOME") {
        Some(home) => PathBuf::from(home).join(".config").join("lepidy"),
        None => PathBuf::from(".lepidy"),
    }
}

pub fn profile_path() -> PathBuf {
    profile_home().join("profile.json")
}

pub fn load_profile() -> CliResult<Profile> {
    load_profile_at(&profile_path())
}

/// Read a specific profile.
///
/// The integration suite gives every scenario its own directory, and reaching
/// them through a process-wide environment variable would make concurrent
/// scenarios read each other's keystores.
pub fn load_profile_at(path: &Path) -> CliResult<Profile> {
    let text = fs::read_to_string(&path).map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => CliError::usage(format!(
            "no Lepidy profile at {}. Run `lepidy login` first.",
            path.display()
        )),
        _ => CliError::failure(format!("could not read {}: {error}", path.display())),
    })?;
    let profile: Profile = serde_json::from_str(&text).map_err(|error| {
        CliError::failure(format!(
            "{} is not a Lepidy profile: {error}",
            path.display()
        ))
    })?;
    if profile.version != PROFILE_VERSION {
        return Err(CliError::failure(format!(
            "{} was written by a different version of this CLI",
            path.display()
        )));
    }
    Ok(profile)
}

pub fn save_profile(profile: &Profile) -> CliResult<PathBuf> {
    let home = profile_home();
    fs::create_dir_all(&home).map_err(|error| {
        CliError::failure(format!("could not create {}: {error}", home.display()))
    })?;
    restrict_to_owner(&home)?;
    let path = home.join("profile.json");
    let text = serde_json::to_string_pretty(profile)
        .map_err(|error| CliError::failure(format!("could not serialise the profile: {error}")))?;
    write_owner_only(&path, text.as_bytes())?;
    Ok(path)
}

/// Seal the secrets under one passphrase.
///
/// The device and workspace ids are the authenticated data, so a keystore
/// lifted out of one profile cannot be dropped into another and unlocked with
/// the same passphrase.
pub fn seal(
    secrets: &Secrets,
    passphrase: &str,
    device_id: &str,
    workspace_id: &str,
) -> CliResult<SealedKeystore> {
    let salt = random_bytes(16);
    let mut key = derive_local_key(
        passphrase,
        &salt,
        ARGON_MEMORY_KIB,
        ARGON_ITERATIONS,
        ARGON_LANES,
    )?;
    let iv = random_bytes(IV_BYTES);
    let mut plaintext = serde_json::to_vec(secrets)
        .map_err(|error| CliError::failure(format!("could not serialise the keystore: {error}")))?;
    let sealed = crate::crypto::aes_gcm_encrypt(
        &key,
        &iv,
        keystore_aad(device_id, workspace_id).as_bytes(),
        &plaintext,
    );
    key.zeroize();
    plaintext.zeroize();
    Ok(SealedKeystore {
        kdf: "argon2id".to_string(),
        memory_kib: ARGON_MEMORY_KIB,
        iterations: ARGON_ITERATIONS,
        lanes: ARGON_LANES,
        salt: encode(&salt),
        iv: encode(&iv),
        sealed: encode(&sealed?),
    })
}

/// Open the keystore with the passphrase, or failing that with the recovery
/// code — the two seal identical material, so the caller does not have to know
/// which one the operator typed.
pub fn unseal(profile: &Profile, secret: &str) -> CliResult<Secrets> {
    match open_keystore(
        &profile.passphrase,
        secret,
        &profile.device_id,
        &profile.workspace_id,
    ) {
        Ok(secrets) => Ok(secrets),
        Err(_) => open_keystore(
            &profile.recovery,
            secret,
            &profile.device_id,
            &profile.workspace_id,
        )
        .map_err(|_| {
            CliError::failure(
                "that passphrase or recovery code did not open the local vault".to_string(),
            )
        }),
    }
}

fn open_keystore(
    keystore: &SealedKeystore,
    secret: &str,
    device_id: &str,
    workspace_id: &str,
) -> CliResult<Secrets> {
    if keystore.kdf != "argon2id" {
        return Err(CliError::failure(
            "this profile uses an unsupported key derivation".to_string(),
        ));
    }
    let salt = decode(&keystore.salt, "keystore salt")?;
    let mut key = derive_local_key(
        secret,
        &salt,
        keystore.memory_kib,
        keystore.iterations,
        keystore.lanes,
    )?;
    let opened = crate::crypto::aes_gcm_decrypt(
        &key,
        &decode(&keystore.iv, "keystore iv")?,
        keystore_aad(device_id, workspace_id).as_bytes(),
        &decode(&keystore.sealed, "keystore")?,
    );
    key.zeroize();
    let mut plaintext = opened?;
    let secrets = serde_json::from_slice::<Secrets>(&plaintext)
        .map_err(|_| CliError::failure("the local keystore is corrupt".to_string()));
    plaintext.zeroize();
    secrets
}

fn keystore_aad(device_id: &str, workspace_id: &str) -> String {
    format!("lepidy-cli-keystore-v1\n{device_id}\n{workspace_id}")
}

/// Owner-only where the platform can say so.
///
/// On Unix that is mode `0600`/`0700` at creation. On Windows the file inherits
/// the ACL of a per-user directory and no further tightening is attempted here;
/// proving that boundary on each supported platform is the R04 matrix, and this
/// code does not claim more than it does.
pub fn write_owner_only(path: &Path, bytes: &[u8]) -> CliResult<()> {
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|error| {
        CliError::failure(format!("could not write {}: {error}", path.display()))
    })?;
    file.write_all(bytes).map_err(|error| {
        CliError::failure(format!("could not write {}: {error}", path.display()))
    })?;
    Ok(())
}

pub fn restrict_to_owner(path: &Path) -> CliResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|error| {
            CliError::failure(format!("could not secure {}: {error}", path.display()))
        })?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// The principals named in `icacls` output, one per access-control entry.
///
/// Split out so the parsing has its own scenarios. `icacls` prints the path and
/// the first entry on one line, and both a Windows path and a principal like
/// `NT AUTHORITY\SYSTEM` contain spaces — so the path is stripped by the exact
/// text that was passed in rather than guessed at. A line that cannot be read
/// is an error, never a line that is skipped: a parser that silently drops
/// entries is a check that silently passes.
pub fn acl_principals(rendered: &str, path: &str) -> CliResult<Vec<String>> {
    let unreadable = || CliError::failure(format!("could not read the permissions of {path}"));
    let mut principals = Vec::new();
    for (index, line) in rendered.lines().enumerate() {
        let line = line.trim_end();
        if line.trim().is_empty() || line.contains("Successfully processed") {
            continue;
        }
        let entry = if index == 0 {
            line.strip_prefix(path).ok_or_else(unreadable)?.trim_start()
        } else {
            line.trim()
        };
        let (principal, rights) = entry.split_once(':').ok_or_else(unreadable)?;
        if !rights.trim_start().starts_with('(') {
            return Err(unreadable());
        }
        let principal = principal.trim();
        if principal.is_empty() {
            return Err(unreadable());
        }
        principals.push(principal.to_string());
    }
    Ok(principals)
}

/// A recovery code the operator writes down: 24 characters from an alphabet
/// with no `I`, `O`, `1` or `0`, so a transcription error is a failed unlock
/// rather than a silently different code.
pub fn generate_recovery_code() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let bytes = random_bytes(24);
    let mut code = String::new();
    for (index, byte) in bytes.iter().enumerate() {
        if index > 0 && index % 6 == 0 {
            code.push('-');
        }
        code.push(ALPHABET[usize::from(*byte) % ALPHABET.len()] as char);
    }
    code
}

pub fn fresh_secrets(
    device_credential: String,
    signing: &DeviceSigningKey,
    vault: &VaultKeyPair,
) -> Secrets {
    Secrets {
        device_credential,
        device_signing_key: encode(&signing.scalar_bytes()),
        vault_private_key: encode(&vault.scalar_bytes()),
    }
}

pub fn assert_key_length(bytes: &[u8], field: &str) -> CliResult<()> {
    if bytes.len() != DEK_BYTES {
        return Err(CliError::failure(format!("{field} must be 256 bits")));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_principals_out_of_an_access_control_list() {
        const PATH: &str = r"C:\Users\maya\my files\presets.json";

        // Real `icacls` output. Both the path and the first principal contain
        // spaces, which is why the path is stripped by the exact text passed in
        // rather than guessed at.
        let rendered = format!(
            "{PATH} NT AUTHORITY\\SYSTEM:(F)\r\nBUILTIN\\Administrators:(F)\r\nDESKTOP-1\\maya:(F)\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files"
        );
        assert_eq!(
            acl_principals(&rendered, PATH).expect("well-formed output parses"),
            vec![
                r"NT AUTHORITY\SYSTEM".to_string(),
                r"BUILTIN\Administrators".to_string(),
                r"DESKTOP-1\maya".to_string(),
            ],
        );

        // The entry an owner-only check exists to catch is not skipped.
        let open = format!("{PATH} BUILTIN\\Users:(RX)\r\nDESKTOP-1\\maya:(F)");
        assert!(acl_principals(&open, PATH)
            .expect("parses")
            .contains(&r"BUILTIN\Users".to_string()));

        // Output this cannot read is an error, never an empty list: a parser
        // that silently drops entries is a check that silently passes.
        for broken in [
            "something else entirely\r\nBUILTIN\\Users:(RX)".to_string(),
            format!("{PATH} BUILTIN\\Users(RX)"),
            format!("{PATH} :(RX)"),
        ] {
            assert!(
                acl_principals(&broken, PATH).is_err(),
                "unreadable output was accepted: {broken}",
            );
        }
    }
}
