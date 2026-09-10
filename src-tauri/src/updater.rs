//! Replacing this application, safely, on a machine that may be working.
//!
//! An updater is usually a background convenience. Here it is the one mechanism
//! in the product that is *designed* to replace a running binary without asking
//! anybody — and the binary it replaces is supervising a harness that may be
//! holding injected credentials right now. Three rules follow, and they are the
//! whole of this file.
//!
//! **No key, no updater.** The public key that verifies an update is compiled
//! in, from the environment, at build time. A build that was given none does
//! not register the updater at all — it has no update mechanism rather than one
//! that trusts whatever answers. A key read at runtime would be a key that
//! anybody who can write a file next to the application can replace, which is
//! the whole attack the signature exists to stop.
//!
//! **The runner stops before the install.** An update that swapped the
//! supervisor out from under a live harness would leave a process tree running
//! with injected credentials and nothing watching it. Stopping first costs
//! somebody an idle agent; not stopping costs exactly what §8 spends the whole
//! product preventing.
//!
//! **Nothing installs without a person.** Checking is automatic, because a
//! person cannot act on an update they were never offered; downloading and
//! installing is a tray item they choose, because this application is a
//! tray-resident supervisor and restarting it silently would stop a machine
//! answering for somebody's agents at a moment nobody chose.

use crate::supervisor::{RunnerState, RunnerSupervisor};

/// The public key that verifies an update, compiled in at build time.
///
/// `option_env!` rather than `env!`: a build without one is a legitimate build —
/// a development build, or a fork — and it simply has no updater.
pub const PUBKEY: Option<&str> = option_env!("LEPIDY_UPDATER_PUBKEY");

/// Does this build have an update mechanism at all?
pub fn is_configured() -> bool {
    PUBKEY.is_some_and(|key| !key.trim().is_empty())
}

/// How long after startup the first check happens.
///
/// Not at startup. The first minute of this process is when a person is opening
/// their workspace and a runner is reconnecting, and an update check competing
/// with that buys nothing: an update that arrives five minutes later is exactly
/// as useful.
pub const FIRST_CHECK_DELAY_MS: u64 = 300_000;

/// And how often afterwards. Six hours: often enough that a security fix is
/// picked up the same day, rare enough that it is not a heartbeat.
pub const CHECK_INTERVAL_MS: u64 = 21_600_000;

#[derive(Debug, PartialEq, Eq)]
pub enum EndpointError {
    None,
    Insecure(String),
}

impl std::fmt::Display for EndpointError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::None => write!(f, "an updater with no endpoint cannot update anything"),
            Self::Insecure(url) => write!(f, "refusing a plain-http update endpoint: {url}"),
        }
    }
}

/// Are these endpoints ones this product will fetch an update from?
///
/// The signature is what makes an update trustworthy, so plain HTTP would not
/// let somebody *forge* one. It would let them see exactly which version every
/// machine in a company is running and withhold the release that fixes
/// something — which is why this is a refusal and not a warning.
pub fn check_endpoints(endpoints: &[String]) -> Result<(), EndpointError> {
    if endpoints.is_empty() {
        return Err(EndpointError::None);
    }
    for endpoint in endpoints {
        if !endpoint.trim().to_ascii_lowercase().starts_with("https://") {
            return Err(EndpointError::Insecure(endpoint.clone()));
        }
    }
    Ok(())
}

/// What the tray says when an update is downloaded and waiting.
///
/// It names the version and says what choosing it does, because the thing it
/// does — stopping the runner — is the thing a person supervising agents needs
/// to know before they choose it, not after.
pub fn ready_label(version: &str) -> String {
    format!("Restart to update to {version} (stops the runner)")
}

/// Stop the runner, and report what was stopped.
///
/// This is the install's first step and it is the reason the function exists at
/// all: an install that skipped it would leave a harness running with injected
/// credentials and no supervisor. Returning the previous state lets the caller
/// say what it interrupted rather than pretending the machine was idle.
pub fn prepare_to_install(supervisor: &mut RunnerSupervisor) -> RunnerState {
    let before = supervisor.state();
    supervisor.stop();
    before
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn supervisor() -> RunnerSupervisor {
        RunnerSupervisor::new(PathBuf::from("lepidy-agentd-not-installed"), None)
    }

    #[test]
    fn a_build_with_no_key_has_no_updater_rather_than_a_trusting_one() {
        // This test asserts the shape, not the value: a release build compiles
        // a key in and this one does not, and both must be legitimate.
        match PUBKEY {
            None => assert!(!is_configured()),
            Some(key) => assert_eq!(is_configured(), !key.trim().is_empty()),
        }
    }

    #[test]
    fn refuses_an_endpoint_that_would_leak_which_version_a_machine_runs() {
        assert_eq!(check_endpoints(&[]), Err(EndpointError::None));
        assert!(check_endpoints(&["https://updates.example/x".to_string()]).is_ok());
        for endpoint in [
            "http://updates.example/x",
            "HTTP://updates.example/x",
            "ftp://updates.example/x",
            "//updates.example/x",
        ] {
            assert!(
                matches!(
                    check_endpoints(&[endpoint.to_string()]),
                    Err(EndpointError::Insecure(_)),
                ),
                "{endpoint} was accepted",
            );
        }
        // One bad endpoint among good ones is still a refusal: a client that
        // fell back to the insecure one would be exactly as bad.
        assert!(check_endpoints(&[
            "https://updates.example/a".to_string(),
            "http://updates.example/b".to_string(),
        ])
        .is_err());
    }

    #[test]
    fn the_tray_says_what_installing_will_do_before_it_is_chosen() {
        let label = ready_label("0.2.0");
        assert!(label.contains("0.2.0"), "{label}");
        // The consequence, in the label. A person supervising agents needs this
        // before they choose it, not after.
        assert!(label.contains("stops the runner"), "{label}");
    }

    #[test]
    fn installing_stops_the_runner_first_and_says_what_it_interrupted() {
        let mut supervisor = supervisor();
        // Nothing running: still safe, still idempotent, and it reports that
        // there was nothing to interrupt.
        assert_eq!(prepare_to_install(&mut supervisor), RunnerState::Stopped);
        assert_eq!(supervisor.state(), RunnerState::Stopped);
    }

    #[test]
    fn the_first_check_is_not_at_startup_and_the_rest_are_not_a_heartbeat() {
        // The first minute of this process is a person opening their workspace
        // and a runner reconnecting.
        assert!(FIRST_CHECK_DELAY_MS >= 60_000);
        // Same day, not every few minutes.
        assert!(CHECK_INTERVAL_MS >= 3_600_000);
        assert!(CHECK_INTERVAL_MS <= 86_400_000);
    }
}
