//! The client half of the vault's cryptography.
//!
//! Every algorithm and every byte of authenticated context here has a twin in
//! `src/domain/vault-envelope.ts` and `src/domain/vault-client-crypto.ts`. They
//! have to agree exactly: a value sealed by a browser custodian is opened by
//! this code and vice versa, and the authenticated data is what stops a wrap or
//! an envelope being replayed onto a different workspace, credential, version
//! or custodian. Change one side and you must change the other.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::Argon2;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hkdf::Hkdf;
use p256::ecdh::EphemeralSecret;
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{PublicKey, SecretKey};
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

pub const DEK_BYTES: usize = 32;
pub const IV_BYTES: usize = 12;
pub const PUBLIC_KEY_BYTES: usize = 65;
pub const WRAP_SUITE: &str = "P256-HKDF-SHA256-AES256GCM";
pub const CIPHER_SUITE: &str = "AES-256-GCM";
pub const AAD_VERSION: u32 = 1;

#[derive(Debug)]
pub struct CryptoError(pub String);

impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CryptoError {}

impl From<&str> for CryptoError {
    fn from(value: &str) -> Self {
        CryptoError(value.to_string())
    }
}

impl From<String> for CryptoError {
    fn from(value: String) -> Self {
        CryptoError(value)
    }
}

type Result<T> = std::result::Result<T, CryptoError>;

pub fn encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn decode(value: &str, field: &str) -> Result<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(value.as_bytes())
        .map_err(|_| CryptoError(format!("{field} is not base64url")))
}

pub fn random_bytes(len: usize) -> Vec<u8> {
    let mut bytes = vec![0u8; len];
    OsRng.fill_bytes(&mut bytes);
    bytes
}

pub fn sha256_base64url(bytes: &[u8]) -> String {
    encode(&Sha256::digest(bytes))
}

/// `JSON.stringify` of the canonical array, byte for byte.
///
/// `serde_json` and `JSON.stringify` agree on separators and on the escaping of
/// the characters these identifiers are allowed to contain, and both sides
/// validate the identifier shape before they get here.
fn canonical_json(values: &[serde_json::Value]) -> Vec<u8> {
    serde_json::Value::Array(values.to_vec())
        .to_string()
        .into_bytes()
}

pub fn credential_aad(workspace_id: &str, credential_id: &str, version: u64) -> Vec<u8> {
    canonical_json(&[
        "lepidy-credential".into(),
        AAD_VERSION.into(),
        workspace_id.into(),
        credential_id.into(),
        version.into(),
    ])
}

pub fn wrap_aad(
    workspace_id: &str,
    credential_id: &str,
    version: u64,
    custodian_member_id: &str,
    recipient_key_epoch: u64,
) -> Vec<u8> {
    canonical_json(&[
        "lepidy-credential-wrap".into(),
        AAD_VERSION.into(),
        workspace_id.into(),
        credential_id.into(),
        version.into(),
        custodian_member_id.into(),
        recipient_key_epoch.into(),
    ])
}

fn aes_key(bytes: &[u8]) -> Result<Aes256Gcm> {
    if bytes.len() != DEK_BYTES {
        return Err("an AES key must be 256 bits".into());
    }
    Aes256Gcm::new_from_slice(bytes).map_err(|_| CryptoError("an AES key must be 256 bits".into()))
}

pub fn aes_gcm_encrypt(key: &[u8], iv: &[u8], aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>> {
    if iv.len() != IV_BYTES {
        return Err("an AES-GCM IV must be 96 bits".into());
    }
    aes_key(key)?
        .encrypt(
            Nonce::from_slice(iv),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| CryptoError("encryption failed".into()))
}

pub fn aes_gcm_decrypt(key: &[u8], iv: &[u8], aad: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>> {
    if iv.len() != IV_BYTES {
        return Err("an AES-GCM IV must be 96 bits".into());
    }
    aes_key(key)?
        .decrypt(
            Nonce::from_slice(iv),
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        // Deliberately one message for a wrong key, a tampered ciphertext and
        // wrong authenticated data. Which of the three it was is exactly what an
        // attacker probing an envelope would like to be told.
        .map_err(|_| {
            CryptoError(
                "could not open this ciphertext: the key, envelope or context does not match"
                    .into(),
            )
        })
}

/// HKDF-SHA256 over a raw ECDH secret, with the wrap context as `info` and an
/// empty salt — the same derivation WebCrypto performs for the browser client.
fn wrap_key(shared: &[u8], aad: &[u8]) -> Result<[u8; DEK_BYTES]> {
    let mut key = [0u8; DEK_BYTES];
    Hkdf::<Sha256>::new(Some(&[]), shared)
        .expand(aad, &mut key)
        .map_err(|_| CryptoError("could not derive a wrapping key".into()))?;
    Ok(key)
}

pub struct VaultKeyPair {
    secret: SecretKey,
}

impl VaultKeyPair {
    pub fn generate() -> Self {
        Self {
            secret: SecretKey::random(&mut OsRng),
        }
    }

    pub fn from_scalar(bytes: &[u8]) -> Result<Self> {
        SecretKey::from_slice(bytes)
            .map(|secret| Self { secret })
            .map_err(|_| CryptoError("the stored vault key is not a P-256 scalar".into()))
    }

    pub fn scalar_bytes(&self) -> Vec<u8> {
        self.secret.to_bytes().to_vec()
    }

    /// Uncompressed SEC1, the encoding both the workspace and WebCrypto's `raw`
    /// import expect.
    pub fn public_key_bytes(&self) -> Vec<u8> {
        sec1_uncompressed(&self.secret.public_key())
    }

    /// Open a wrap sealed to this key. The returned DEK is the caller's to wipe.
    pub fn unwrap_dek(
        &self,
        ephemeral_public_key: &[u8],
        iv: &[u8],
        wrapped_dek: &[u8],
        aad: &[u8],
    ) -> Result<Vec<u8>> {
        let ephemeral = public_key_from_bytes(ephemeral_public_key)?;
        let shared =
            p256::ecdh::diffie_hellman(self.secret.to_nonzero_scalar(), ephemeral.as_affine());
        let mut key = wrap_key(shared.raw_secret_bytes().as_slice(), aad)?;
        let dek = aes_gcm_decrypt(&key, iv, aad, wrapped_dek);
        key.zeroize();
        let dek = dek?;
        if dek.len() != DEK_BYTES {
            return Err("an unwrapped DEK must be 256 bits".into());
        }
        Ok(dek)
    }
}

pub struct SealedDek {
    pub ephemeral_public_key: Vec<u8>,
    pub iv: Vec<u8>,
    pub wrapped_dek: Vec<u8>,
}

/// Seal a DEK for one custodian's published public key.
///
/// The ephemeral private half is dropped with this function's stack frame and
/// never written anywhere, so only the custodian can reverse it.
pub fn wrap_dek(recipient_public_key: &[u8], dek: &[u8], aad: &[u8]) -> Result<SealedDek> {
    if dek.len() != DEK_BYTES {
        return Err("a DEK must be 256 bits".into());
    }
    let recipient = public_key_from_bytes(recipient_public_key)?;
    let ephemeral = EphemeralSecret::random(&mut OsRng);
    let ephemeral_public_key = sec1_uncompressed(&ephemeral.public_key());
    let shared = ephemeral.diffie_hellman(&recipient);
    let mut key = wrap_key(shared.raw_secret_bytes().as_slice(), aad)?;
    let iv = random_bytes(IV_BYTES);
    let wrapped_dek = aes_gcm_encrypt(&key, &iv, aad, dek);
    key.zeroize();
    Ok(SealedDek {
        ephemeral_public_key,
        iv,
        wrapped_dek: wrapped_dek?,
    })
}

pub fn public_key_from_bytes(bytes: &[u8]) -> Result<PublicKey> {
    if bytes.len() != PUBLIC_KEY_BYTES || bytes[0] != 0x04 {
        return Err("a vault public key must be an uncompressed P-256 point".into());
    }
    PublicKey::from_sec1_bytes(bytes)
        .map_err(|_| CryptoError("a vault public key is not on the P-256 curve".into()))
}

pub struct DeviceSigningKey {
    key: SigningKey,
}

impl DeviceSigningKey {
    pub fn generate() -> Self {
        Self {
            key: SigningKey::random(&mut OsRng),
        }
    }

    pub fn from_scalar(bytes: &[u8]) -> Result<Self> {
        SigningKey::from_slice(bytes)
            .map(|key| Self { key })
            .map_err(|_| CryptoError("the stored device key is not a P-256 scalar".into()))
    }

    pub fn scalar_bytes(&self) -> Vec<u8> {
        self.key.to_bytes().to_vec()
    }

    /// Raw `r ‖ s`, which is what WebCrypto's ECDSA verify accepts. A DER
    /// signature would be rejected by the control plane without explanation.
    pub fn sign(&self, message: &[u8]) -> Vec<u8> {
        let signature: Signature = self.key.sign(message);
        signature.to_bytes().to_vec()
    }

    pub fn public_jwk(&self) -> serde_json::Value {
        public_jwk_from_sec1(self.key.verifying_key().to_encoded_point(false).as_bytes())
    }
}

pub fn sec1_uncompressed(key: &PublicKey) -> Vec<u8> {
    key.to_encoded_point(false).as_bytes().to_vec()
}

/// The public JWK shape the control plane validates: EC, P-256, x and y, and no
/// private component.
pub fn public_jwk_from_sec1(sec1: &[u8]) -> serde_json::Value {
    serde_json::json!({
        "kty": "EC",
        "crv": "P-256",
        "x": encode(&sec1[1..33]),
        "y": encode(&sec1[33..65]),
    })
}

/// Argon2id over the passphrase, to the key that seals the local keystore.
///
/// The parameters are deliberately expensive and deliberately recorded in the
/// profile rather than compiled in: a keystore written by an older build has to
/// stay openable when they are raised.
pub fn derive_local_key(
    passphrase: &str,
    salt: &[u8],
    memory_kib: u32,
    iterations: u32,
    lanes: u32,
) -> Result<Vec<u8>> {
    let params = argon2::Params::new(memory_kib, iterations, lanes, Some(DEK_BYTES))
        .map_err(|_| CryptoError("the local key derivation parameters are invalid".into()))?;
    let argon = Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut key = vec![0u8; DEK_BYTES];
    argon
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|_| CryptoError("could not derive the local vault key".into()))?;
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// VAULT-CLI-RULE-001
    #[test]
    fn canonical_context_matches_the_typescript_form() {
        assert_eq!(
            String::from_utf8(credential_aad("ws-1", "cred-1", 2)).unwrap(),
            r#"["lepidy-credential",1,"ws-1","cred-1",2]"#
        );
        assert_eq!(
            String::from_utf8(wrap_aad("ws-1", "cred-1", 2, "member-1", 3)).unwrap(),
            r#"["lepidy-credential-wrap",1,"ws-1","cred-1",2,"member-1",3]"#
        );
    }

    /// VAULT-CLI-RULE-002
    #[test]
    fn a_wrap_only_opens_under_its_own_context() {
        let custodian = VaultKeyPair::generate();
        let dek = random_bytes(DEK_BYTES);
        let aad = wrap_aad("ws-1", "cred-1", 1, "member-1", 1);
        let sealed = wrap_dek(&custodian.public_key_bytes(), &dek, &aad).unwrap();

        let opened = custodian
            .unwrap_dek(
                &sealed.ephemeral_public_key,
                &sealed.iv,
                &sealed.wrapped_dek,
                &aad,
            )
            .unwrap();
        assert_eq!(opened, dek);

        let other = wrap_aad("ws-1", "cred-1", 2, "member-1", 1);
        assert!(custodian
            .unwrap_dek(
                &sealed.ephemeral_public_key,
                &sealed.iv,
                &sealed.wrapped_dek,
                &other
            )
            .is_err());
        assert!(VaultKeyPair::generate()
            .unwrap_dek(
                &sealed.ephemeral_public_key,
                &sealed.iv,
                &sealed.wrapped_dek,
                &aad
            )
            .is_err());
    }

    /// VAULT-CLI-RULE-003
    #[test]
    fn an_envelope_is_bound_to_its_credential_version() {
        let dek = random_bytes(DEK_BYTES);
        let iv = random_bytes(IV_BYTES);
        let sealed =
            aes_gcm_encrypt(&dek, &iv, &credential_aad("ws-1", "cred-1", 1), b"canary").unwrap();

        assert_eq!(
            aes_gcm_decrypt(&dek, &iv, &credential_aad("ws-1", "cred-1", 1), &sealed).unwrap(),
            b"canary"
        );
        assert!(aes_gcm_decrypt(&dek, &iv, &credential_aad("ws-1", "cred-1", 2), &sealed).is_err());
        assert!(aes_gcm_decrypt(&dek, &iv, &credential_aad("ws-2", "cred-1", 1), &sealed).is_err());
    }

    /// VAULT-CLI-RULE-004
    #[test]
    fn a_device_public_jwk_carries_no_private_component() {
        let jwk = DeviceSigningKey::generate().public_jwk();
        assert_eq!(jwk["kty"], "EC");
        assert_eq!(jwk["crv"], "P-256");
        assert!(jwk.get("d").is_none());
        assert_eq!(decode(jwk["x"].as_str().unwrap(), "x").unwrap().len(), 32);
    }
}
