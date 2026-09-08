//! What the web layer may ask the machine to do.
//!
//! This is a deliberately tiny surface. The page in this window is written by
//! Lepidy, but the *content* it renders is written by agents and by strangers,
//! and one cross-site scripting bug in a message renderer would otherwise hand
//! whoever wrote that message everything the native side can do.
//!
//! So there are five commands, they are the whole list, and each one is either
//! read-only, protective, or gated behind a native gesture that the page cannot
//! perform on a person's behalf:
//!
//! | Command | What it can do |
//! |---|---|
//! | `runner_status` | Read whether the runner is answering |
//! | `runner_stop` | Stop it. Ungated, because protective directions must always work |
//! | `runner_start` | Start it — only with a fresh native confirmation |
//! | `local_verify` | Ask the operating system to confirm the person, for one named action |
//! | `desktop_platform` | Report which platform this is, for layout |
//!
//! There is no command that reads a file, runs a program, or takes a path.
//! Launch configuration is edited by the local CLI, on the machine, behind the
//! vault passphrase and now a native gesture — never through this window.

use std::sync::Mutex;

use crate::origin::TrustedOrigin;
use crate::supervisor::{RunnerState, RunnerSupervisor};
use crate::verification::{LocalAction, VerificationError, VerificationLedger};

/// Everything the native side owns, behind one lock.
pub struct NativeState {
    pub origin: TrustedOrigin,
    pub supervisor: Mutex<RunnerSupervisor>,
    pub ledger: Mutex<VerificationLedger>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum IpcError {
    /// The call did not come from the one origin this shell trusts.
    UntrustedOrigin,
    NotConfirmed(String),
    Refused(String),
}

impl std::fmt::Display for IpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UntrustedOrigin => {
                write!(f, "this page may not talk to the Lepidy desktop shell")
            }
            Self::NotConfirmed(reason) | Self::Refused(reason) => write!(f, "{reason}"),
        }
    }
}

impl From<VerificationError> for IpcError {
    fn from(error: VerificationError) -> Self {
        match error {
            VerificationError::NotConfirmed => Self::NotConfirmed(error.to_string()),
            other => Self::Refused(other.to_string()),
        }
    }
}

/// Every command starts here.
///
/// The URL comes from the webview itself, never from the message: a caller that
/// could name its own origin is not being checked.
pub fn require_trusted_caller(state: &NativeState, caller_url: &str) -> Result<(), IpcError> {
    if state.origin.allows(caller_url) {
        Ok(())
    } else {
        Err(IpcError::UntrustedOrigin)
    }
}

pub fn runner_status(state: &NativeState, caller_url: &str) -> Result<RunnerState, IpcError> {
    require_trusted_caller(state, caller_url)?;
    Ok(state.supervisor.lock().expect("supervisor").state())
}

/// Stop, unconditionally.
///
/// No gesture and no confirmation. A stop that can be refused is a stop that
/// gets skipped at the moment it is needed, and the worst case here is that
/// somebody's agents go idle — against a harness left running with injected
/// credentials, that is not a close call.
pub fn runner_stop(state: &NativeState, caller_url: &str) -> Result<RunnerState, IpcError> {
    require_trusted_caller(state, caller_url)?;
    Ok(state.supervisor.lock().expect("supervisor").stop())
}

/// Start, only with a fresh confirmation for exactly this action.
pub fn runner_start(
    state: &NativeState,
    caller_url: &str,
    now_ms: u64,
) -> Result<RunnerState, IpcError> {
    require_trusted_caller(state, caller_url)?;
    state
        .ledger
        .lock()
        .expect("ledger")
        .consume(&LocalAction::StartRunner, now_ms)?;
    let mut supervisor = state.supervisor.lock().expect("supervisor");
    supervisor
        .start()
        .map_err(|error| IpcError::Refused(error.to_string()))?;
    Ok(supervisor.state())
}

/// Ask the operating system to confirm the person, for one named action.
///
/// The page may ask; it cannot answer. What comes back is not a token the page
/// holds — the confirmation is recorded natively against that action's digest
/// and spent by the next call, so a page that is compromised between the two
/// can spend it on that action and on nothing else.
pub fn local_verify(
    state: &NativeState,
    caller_url: &str,
    action: LocalAction,
    now_ms: u64,
) -> Result<(), IpcError> {
    require_trusted_caller(state, caller_url)?;
    crate::verification::verify_with_platform(&action)?;
    state.ledger.lock().expect("ledger").record(&action, now_ms);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn state() -> NativeState {
        NativeState {
            origin: TrustedOrigin::parse("https://lepidy.example").expect("origin"),
            supervisor: Mutex::new(RunnerSupervisor::new(
                PathBuf::from("lepidy-agentd-not-installed"),
                None,
            )),
            ledger: Mutex::new(VerificationLedger::new()),
        }
    }

    #[test]
    fn every_command_refuses_a_caller_from_anywhere_else() {
        let state = state();
        // The XSS case, and the look-alike case. Neither may reach the machine.
        for url in [
            "https://evil.test/",
            "https://lepidy.example.evil.test/",
            "file:///etc/passwd",
            "data:text/html,<script>1</script>",
        ] {
            assert_eq!(
                runner_status(&state, url),
                Err(IpcError::UntrustedOrigin),
                "{url}"
            );
            assert_eq!(
                runner_stop(&state, url),
                Err(IpcError::UntrustedOrigin),
                "{url}"
            );
            assert_eq!(
                runner_start(&state, url, 1_000),
                Err(IpcError::UntrustedOrigin),
                "{url}"
            );
            assert_eq!(
                local_verify(&state, url, LocalAction::StartRunner, 1_000),
                Err(IpcError::UntrustedOrigin),
                "{url}",
            );
        }
    }

    #[test]
    fn stopping_needs_no_confirmation_at_all() {
        let state = state();
        // Deliberate: the protective direction always works, from a trusted
        // page, with nothing confirmed and nothing running.
        assert_eq!(
            runner_stop(&state, "https://lepidy.example/w/team"),
            Ok(RunnerState::Stopped),
        );
    }

    #[test]
    fn starting_without_a_confirmation_is_refused_before_anything_is_spawned() {
        let state = state();
        let error = runner_start(&state, "https://lepidy.example/w/team", 1_000)
            .expect_err("an unconfirmed start must be refused");
        assert!(matches!(error, IpcError::NotConfirmed(_)), "{error:?}");
        // And the refusal happened before the process was reached: the daemon
        // path here does not exist, so a spawn would have failed differently.
        assert_eq!(
            runner_status(&state, "https://lepidy.example/").expect("status"),
            RunnerState::Stopped,
        );
    }

    #[test]
    fn a_confirmation_for_one_action_cannot_start_the_runner() {
        let state = state();
        // Recorded directly, standing in for a gesture the platform granted.
        state.ledger.lock().expect("ledger").record(
            &LocalAction::EditPreset {
                preset_id: "claude".to_string(),
            },
            1_000,
        );
        let error = runner_start(&state, "https://lepidy.example/", 1_100)
            .expect_err("a confirmation for an edit must not start the runner");
        assert!(matches!(error, IpcError::NotConfirmed(_)), "{error:?}");
    }

    #[test]
    fn a_confirmation_is_spent_by_the_call_it_authorises() {
        let state = state();
        state
            .ledger
            .lock()
            .expect("ledger")
            .record(&LocalAction::StartRunner, 1_000);
        // The daemon binary does not exist, so this fails at the spawn — but
        // the confirmation is gone either way, which is the property: a failed
        // start does not leave a spendable confirmation lying around.
        assert!(runner_start(&state, "https://lepidy.example/", 1_100).is_err());
        assert_eq!(state.ledger.lock().expect("ledger").outstanding(), 0);
    }

    #[cfg(not(windows))]
    #[test]
    fn a_platform_with_no_verifier_records_nothing() {
        let state = state();
        let error = local_verify(
            &state,
            "https://lepidy.example/",
            LocalAction::StartRunner,
            1_000,
        )
        .expect_err("no verifier means no confirmation");
        assert!(matches!(error, IpcError::Refused(_)), "{error:?}");
        // Fails closed: nothing was recorded, so nothing can be spent.
        assert_eq!(state.ledger.lock().expect("ledger").outstanding(), 0);
    }
}
