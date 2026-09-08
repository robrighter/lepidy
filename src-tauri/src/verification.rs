//! The native gesture, and what it is a gesture *about*.
//!
//! R01 gated launch configuration behind the local vault passphrase and called
//! that what it was: presence, not platform identity. This is the stronger
//! thing — the operating system itself confirming the person at the keyboard,
//! through Windows Hello, Touch ID or PAM.
//!
//! Two properties matter more than which platform API is used.
//!
//! **It is about one specific thing.** A gesture is bound to a digest of the
//! exact action and subject, the same way V03 binds an approval. A confirmation
//! collected for "edit the preset named claude" cannot be spent on "start the
//! runner", so a shell that is tricked into asking for one harmless
//! confirmation cannot bank it against something else.
//!
//! **It fails closed.** A platform with no verifier available, a verifier that
//! errors, a device with no enrolled credential — every one of those is a
//! refusal. The alternative is a gate that quietly stops being a gate on
//! exactly the machines where it is hardest to notice.

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

/// How long a confirmation stays spendable. Short on purpose: it exists to
/// carry one gesture into one call a moment later, not to be a session.
pub const FRESHNESS_MS: u64 = 120_000;

/// What a person is being asked to confirm.
///
/// The subject is part of the digest, so the prompt a person reads and the
/// action that is then taken cannot disagree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LocalAction {
    /// Change what this machine runs.
    EditPreset { preset_id: String },
    /// Start answering for agents.
    StartRunner,
    /// Loosen a harness's permission posture — the one edit that deserves the
    /// most friction, because it is the one that widens what an agent may do
    /// without anybody in the workspace seeing it happen.
    LoosenPosture { preset_id: String },
}

impl LocalAction {
    pub fn verb(&self) -> &'static str {
        match self {
            Self::EditPreset { .. } => "edit local launch configuration",
            Self::StartRunner => "start the local runner",
            Self::LoosenPosture { .. } => "loosen a harness permission posture",
        }
    }

    fn subject(&self) -> &str {
        match self {
            Self::EditPreset { preset_id } | Self::LoosenPosture { preset_id } => preset_id,
            Self::StartRunner => "",
        }
    }

    /// What a person is shown. Plain words, because a prompt nobody reads is a
    /// prompt nobody is protected by.
    pub fn prompt(&self) -> String {
        match self {
            Self::EditPreset { preset_id } => {
                format!(
                    "Lepidy wants to change what the preset \"{preset_id}\" runs on this machine."
                )
            }
            Self::StartRunner => {
                "Lepidy wants to start answering for your agents on this machine.".to_string()
            }
            Self::LoosenPosture { preset_id } => format!(
                "Lepidy wants to loosen the permission posture of \"{preset_id}\". \
                 The harness will be allowed to do more without asking."
            ),
        }
    }

    /// The digest a confirmation is bound to.
    ///
    /// Domain-separated and versioned like every other canonical string in this
    /// product, so a digest from one context can never be replayed into
    /// another.
    pub fn digest(&self) -> String {
        let canonical = ["lepidy-local-verification-v1", self.verb(), self.subject()].join("\n");
        let mut hasher = Sha256::new();
        hasher.update(canonical.as_bytes());
        hex(&hasher.finalize())
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[derive(Debug, PartialEq, Eq)]
pub enum VerificationError {
    /// No verifier on this machine: no Hello, no enrolled credential, no PAM.
    Unavailable(String),
    /// The person said no, or the prompt was dismissed.
    Refused,
    /// A confirmation that was for something else, has been spent, or is stale.
    NotConfirmed,
}

impl std::fmt::Display for VerificationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable(reason) => write!(f, "this machine cannot verify you: {reason}"),
            Self::Refused => write!(f, "that was not confirmed"),
            Self::NotConfirmed => {
                write!(f, "confirm this on the machine first; a confirmation is for one action and expires")
            }
        }
    }
}

impl std::error::Error for VerificationError {}

/// Confirmations collected and not yet spent.
///
/// Single use, short-lived and keyed by digest. Held in memory only: a
/// confirmation that survived a restart would be a confirmation nobody made.
#[derive(Default)]
pub struct VerificationLedger {
    granted: HashMap<String, u64>,
}

impl VerificationLedger {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record(&mut self, action: &LocalAction, now_ms: u64) {
        self.granted.insert(action.digest(), now_ms);
    }

    /// Spend a confirmation, or refuse.
    ///
    /// Spending removes it, so one gesture authorises one action. Anything
    /// else — a stale one, one for a different action, one already used — is
    /// the same refusal, because telling a caller *which* would tell it how to
    /// get closer.
    pub fn consume(&mut self, action: &LocalAction, now_ms: u64) -> Result<(), VerificationError> {
        let digest = action.digest();
        let Some(granted_at) = self.granted.remove(&digest) else {
            return Err(VerificationError::NotConfirmed);
        };
        if now_ms < granted_at || now_ms - granted_at > FRESHNESS_MS {
            return Err(VerificationError::NotConfirmed);
        }
        Ok(())
    }

    /// Forget everything. Used when the shell loses focus of who is there —
    /// a lock, a sleep, a sign-out.
    pub fn clear(&mut self) {
        self.granted.clear();
    }

    pub fn outstanding(&self) -> usize {
        self.granted.len()
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

/// Ask the operating system to confirm the person at the keyboard.
///
/// Every arm of this fails closed. A platform that cannot verify says so and
/// the caller refuses; it never falls back to "assume it is them", which is how
/// a security gate quietly stops being one on the machines where nobody looks.
pub fn verify_with_platform(action: &LocalAction) -> Result<(), VerificationError> {
    platform_verify(&action.prompt())
}

#[cfg(windows)]
fn platform_verify(prompt: &str) -> Result<(), VerificationError> {
    use windows::core::HSTRING;
    use windows::Security::Credentials::UI::{
        UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
    };

    let availability = UserConsentVerifier::CheckAvailabilityAsync()
        .and_then(|operation| operation.join())
        .map_err(|error| VerificationError::Unavailable(error.message()))?;
    if availability != UserConsentVerifierAvailability::Available {
        // Named rather than generic: "set up Windows Hello" is actionable and
        // "verification failed" is not.
        return Err(VerificationError::Unavailable(format!(
            "Windows Hello is not available here ({availability:?}); enrol a PIN, face or fingerprint"
        )));
    }
    let result = UserConsentVerifier::RequestVerificationAsync(&HSTRING::from(prompt))
        .and_then(|operation| operation.join())
        .map_err(|error| VerificationError::Unavailable(error.message()))?;
    match result {
        UserConsentVerificationResult::Verified => Ok(()),
        _ => Err(VerificationError::Refused),
    }
}

#[cfg(not(windows))]
fn platform_verify(_prompt: &str) -> Result<(), VerificationError> {
    // macOS LocalAuthentication and Linux PAM are the equivalents and are not
    // wired up here. This refuses rather than pretending, so a platform without
    // a verifier is a platform where the gate holds shut.
    Err(VerificationError::Unavailable(
        "native user verification is implemented for Windows Hello only; \
         macOS and Linux gestures are not wired up yet"
            .to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_confirmation_is_about_one_specific_thing() {
        let edit = LocalAction::EditPreset {
            preset_id: "claude".to_string(),
        };
        let other = LocalAction::EditPreset {
            preset_id: "codex".to_string(),
        };
        let start = LocalAction::StartRunner;
        let loosen = LocalAction::LoosenPosture {
            preset_id: "claude".to_string(),
        };
        // Four different things, four different digests. A confirmation
        // collected for one cannot be spent on another.
        let digests = [
            edit.digest(),
            other.digest(),
            start.digest(),
            loosen.digest(),
        ];
        let unique: std::collections::BTreeSet<&String> = digests.iter().collect();
        assert_eq!(unique.len(), 4, "two actions share a digest: {digests:?}");
        // Stable across runs, because it is what a prompt and a later call are
        // both compared against.
        assert_eq!(
            edit.digest(),
            LocalAction::EditPreset {
                preset_id: "claude".to_string()
            }
            .digest()
        );
        assert_eq!(edit.digest().len(), 64);
    }

    #[test]
    fn the_prompt_says_what_is_actually_about_to_happen() {
        let loosen = LocalAction::LoosenPosture {
            preset_id: "claude".to_string(),
        };
        let prompt = loosen.prompt();
        assert!(prompt.contains("claude"), "{prompt}");
        // The consequence, not just the verb. Somebody has to be able to decide.
        assert!(prompt.contains("without asking"), "{prompt}");
    }

    #[test]
    fn one_gesture_authorises_one_action() {
        let mut ledger = VerificationLedger::new();
        let action = LocalAction::EditPreset {
            preset_id: "claude".to_string(),
        };
        ledger.record(&action, 1_000);
        assert_eq!(ledger.consume(&action, 1_500), Ok(()));
        // Spent. A second call is refused rather than riding on the first.
        assert_eq!(
            ledger.consume(&action, 1_500),
            Err(VerificationError::NotConfirmed)
        );
    }

    #[test]
    fn a_confirmation_for_something_else_is_not_a_confirmation() {
        let mut ledger = VerificationLedger::new();
        ledger.record(
            &LocalAction::EditPreset {
                preset_id: "claude".to_string(),
            },
            1_000,
        );
        // The case this exists for: a shell tricked into asking for one
        // harmless confirmation must not be able to bank it against something
        // that matters.
        assert_eq!(
            ledger.consume(
                &LocalAction::LoosenPosture {
                    preset_id: "claude".to_string()
                },
                1_100
            ),
            Err(VerificationError::NotConfirmed),
        );
        assert_eq!(
            ledger.consume(
                &LocalAction::EditPreset {
                    preset_id: "codex".to_string()
                },
                1_100
            ),
            Err(VerificationError::NotConfirmed),
        );
        // And the real one still works, because nothing was spent.
        assert_eq!(
            ledger.consume(
                &LocalAction::EditPreset {
                    preset_id: "claude".to_string()
                },
                1_100
            ),
            Ok(()),
        );
    }

    #[test]
    fn a_confirmation_goes_stale() {
        let mut ledger = VerificationLedger::new();
        let action = LocalAction::StartRunner;
        ledger.record(&action, 1_000);
        assert_eq!(
            ledger.consume(&action, 1_000 + FRESHNESS_MS + 1),
            Err(VerificationError::NotConfirmed),
        );

        // A clock that goes backwards must not extend a confirmation either.
        ledger.record(&action, 5_000);
        assert_eq!(
            ledger.consume(&action, 4_000),
            Err(VerificationError::NotConfirmed)
        );
    }

    #[test]
    fn losing_the_person_forgets_everything() {
        let mut ledger = VerificationLedger::new();
        ledger.record(&LocalAction::StartRunner, 1_000);
        assert_eq!(ledger.outstanding(), 1);
        ledger.clear();
        assert_eq!(
            ledger.consume(&LocalAction::StartRunner, 1_100),
            Err(VerificationError::NotConfirmed),
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn a_platform_without_a_verifier_refuses_rather_than_assuming() {
        // The whole point of failing closed: on a machine with no gesture
        // available, the gate holds shut instead of quietly opening.
        let error = verify_with_platform(&LocalAction::StartRunner).expect_err("must refuse");
        assert!(
            matches!(error, VerificationError::Unavailable(_)),
            "{error:?}"
        );
    }
}
