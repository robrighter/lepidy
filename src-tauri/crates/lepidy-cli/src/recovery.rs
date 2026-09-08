//! Client-only account vault recovery packages.
//!
//! The cloud stores this JSON but cannot derive its key: Argon2id runs here
//! over the printed recovery code and AES-GCM binds the package to one account
//! vault epoch. Only the vault wrapping private key is inside. Device signing
//! keys and device credentials are never copied to a replacement machine.

use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use crate::crypto::{
    aes_gcm_decrypt, aes_gcm_encrypt, decode, derive_local_key, encode, random_bytes, IV_BYTES,
};
use crate::error::{CliError, CliResult};
use crate::profile::{ARGON_ITERATIONS, ARGON_LANES, ARGON_MEMORY_KIB};

pub const RECOVERY_PACKAGE_SUITE: &str = "ARGON2ID-AES256GCM";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryPackage {
    pub suite: String,
    pub vault_epoch: u64,
    pub memory_kib: u32,
    pub iterations: u32,
    pub lanes: u32,
    pub salt: String,
    pub iv: String,
    pub ciphertext: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryPlaintext {
    vault_private_key: String,
}

impl Drop for RecoveryPlaintext {
    fn drop(&mut self) {
        self.vault_private_key.zeroize();
    }
}

pub fn seal_recovery_package(
    account_id: &str,
    vault_epoch: u64,
    recovery_code: &str,
    vault_private_key: &[u8],
) -> CliResult<RecoveryPackage> {
    validate_recovery_code(recovery_code)?;
    if vault_private_key.len() != 32 {
        return Err(CliError::failure("the vault private key must be 256 bits"));
    }
    let salt = random_bytes(16);
    let mut key = derive_local_key(
        recovery_code,
        &salt,
        ARGON_MEMORY_KIB,
        ARGON_ITERATIONS,
        ARGON_LANES,
    )?;
    let iv = random_bytes(IV_BYTES);
    let mut plaintext = serde_json::to_vec(&RecoveryPlaintext {
        vault_private_key: encode(vault_private_key),
    })
    .map_err(|error| CliError::failure(format!("could not serialise recovery package: {error}")))?;
    let sealed = aes_gcm_encrypt(
        &key,
        &iv,
        &recovery_aad(account_id, vault_epoch),
        &plaintext,
    );
    key.zeroize();
    plaintext.zeroize();
    Ok(RecoveryPackage {
        suite: RECOVERY_PACKAGE_SUITE.to_string(),
        vault_epoch,
        memory_kib: ARGON_MEMORY_KIB,
        iterations: ARGON_ITERATIONS,
        lanes: ARGON_LANES,
        salt: encode(&salt),
        iv: encode(&iv),
        ciphertext: encode(&sealed?),
    })
}

pub fn open_recovery_package(
    account_id: &str,
    recovery_code: &str,
    package: &RecoveryPackage,
) -> CliResult<Vec<u8>> {
    validate_recovery_code(recovery_code)?;
    if package.suite != RECOVERY_PACKAGE_SUITE
        || package.memory_kib < ARGON_MEMORY_KIB
        || package.iterations < ARGON_ITERATIONS
        || package.lanes != ARGON_LANES
    {
        return Err(CliError::failure("the recovery package is unsupported"));
    }
    let opened = (|| {
        let salt = decode(&package.salt, "recovery salt")?;
        let mut key = derive_local_key(
            recovery_code,
            &salt,
            package.memory_kib,
            package.iterations,
            package.lanes,
        )?;
        let plaintext = aes_gcm_decrypt(
            &key,
            &decode(&package.iv, "recovery iv")?,
            &recovery_aad(account_id, package.vault_epoch),
            &decode(&package.ciphertext, "recovery ciphertext")?,
        );
        key.zeroize();
        let mut plaintext = plaintext?;
        let parsed = serde_json::from_slice::<RecoveryPlaintext>(&plaintext)
            .map_err(|_| crate::crypto::CryptoError("recovery package is corrupt".into()));
        plaintext.zeroize();
        let parsed = parsed?;
        let key = decode(&parsed.vault_private_key, "vault private key")?;
        if key.len() != 32 {
            return Err(crate::crypto::CryptoError(
                "vault private key is not 256 bits".into(),
            ));
        }
        Ok(key)
    })();
    opened.map_err(|_| CliError::failure("that recovery code did not open the vault"))
}

fn recovery_aad(account_id: &str, vault_epoch: u64) -> Vec<u8> {
    serde_json::json!(["lepidy-account-vault-recovery", 1, account_id, vault_epoch])
        .to_string()
        .into_bytes()
}

fn validate_recovery_code(value: &str) -> CliResult<()> {
    let parts: Vec<_> = value.split('-').collect();
    let valid = parts.len() == 4
        && parts.iter().all(|part| {
            part.len() == 6
                && part
                    .bytes()
                    .all(|byte| b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789".contains(&byte))
        });
    if valid {
        Ok(())
    } else {
        Err(CliError::failure("the recovery code is invalid"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v07_cli_unit_001_recovery_is_local_bound_and_generic_on_failure() {
        let code = "ABCDEF-GHJKLM-NPQRST-UVWXYZ";
        let secret = [17u8; 32];
        let package = seal_recovery_package("account-a", 1, code, &secret).unwrap();
        let rendered = serde_json::to_string(&package).unwrap();
        assert!(!rendered.contains(code));
        assert_eq!(
            open_recovery_package("account-a", code, &package).unwrap(),
            secret
        );
        let wrong = open_recovery_package("account-a", "AAAAAA-AAAAAA-AAAAAA-AAAAAA", &package)
            .unwrap_err()
            .message;
        let moved = open_recovery_package("account-b", code, &package)
            .unwrap_err()
            .message;
        assert_eq!(wrong, "that recovery code did not open the vault");
        assert_eq!(moved, wrong);
    }
}
