//! Failures, and the exit codes they leave behind.
//!
//! The codes matter more than usual here. This CLI is normally run by an agent
//! harness reading nothing but the exit status, and "the vault said no" has to
//! be distinguishable from "the command you asked for failed" — otherwise a
//! refusal reads as a flaky tool and gets retried in a loop.

use crate::crypto::CryptoError;

/// Lepidy itself refused: policy, ACL, epoch, delegation or rate.
pub const EXIT_DENIED: i32 = 77;
/// Allowed in principle, but a human has to say yes first.
pub const EXIT_NEEDS_APPROVAL: i32 = 78;
pub const EXIT_USAGE: i32 = 2;
pub const EXIT_FAILURE: i32 = 1;

#[derive(Debug)]
pub struct CliError {
    pub code: i32,
    pub message: String,
    /// Printed verbatim under the message. Denials carry the workspace's own
    /// wording, which is the product's voice to the agent reading this.
    pub hint: Option<String>,
}

pub type CliResult<T> = Result<T, CliError>;

impl CliError {
    pub fn usage(message: impl Into<String>) -> Self {
        Self {
            code: EXIT_USAGE,
            message: message.into(),
            hint: None,
        }
    }

    pub fn failure(message: impl Into<String>) -> Self {
        Self {
            code: EXIT_FAILURE,
            message: message.into(),
            hint: None,
        }
    }

    pub fn denied(message: impl Into<String>, hint: Option<String>) -> Self {
        Self {
            code: EXIT_DENIED,
            message: message.into(),
            hint,
        }
    }

    pub fn needs_approval(message: impl Into<String>, hint: Option<String>) -> Self {
        Self {
            code: EXIT_NEEDS_APPROVAL,
            message: message.into(),
            hint,
        }
    }

    pub fn report(&self) {
        eprintln!("lepidy: {}", self.message);
        if let Some(hint) = &self.hint {
            eprintln!("{hint}");
        }
    }
}

impl From<CryptoError> for CliError {
    fn from(error: CryptoError) -> Self {
        CliError::failure(error.0)
    }
}

impl From<std::io::Error> for CliError {
    fn from(error: std::io::Error) -> Self {
        CliError::failure(error.to_string())
    }
}
