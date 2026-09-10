//! Starting and stopping the local runner from the desktop shell.
//!
//! The daemon is a separate process on purpose — it runs headless on machines
//! with no desktop at all, and it must not need a window to keep working. What
//! the shell adds is a person's control over it: a tray that says whether it is
//! answering, a way to start it, and a stop that always works.
//!
//! The tree is signalled through `lepidy_runner::process`, the same code the
//! daemon uses to stop a harness: the desktop shell supervises the daemon
//! exactly as the daemon supervises a harness, and two copies of that would be
//! two chances to get a platform wrong.
//!
//! **Stopping is the direction that must never fail.** Starting can be refused
//! for any number of reasons and the machine is simply idle; a stop that does
//! not stop leaves a harness running with injected credentials after somebody
//! decided it should not be. So stop is unconditional, ungated, kills the whole
//! process tree, and is safe to call when nothing is running.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// How long a tree gets to exit after being asked, before it is killed.
const GRACE: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunnerState {
    Stopped,
    Running,
    /// It exited on its own. Kept distinct from `Stopped` because a runner that
    /// died is something a person should see, not something to quietly restart.
    Exited {
        code: i32,
    },
    /// This build cannot host a runner at all.
    ///
    /// Never produced by the supervisor — `ipc` substitutes it on a package
    /// whose sandbox forbids starting a child process (PRD §10.1). It exists as
    /// its own state rather than reusing `Stopped` because "stopped" invites
    /// somebody to start it, and on that build nothing ever will.
    Unavailable,
}

impl RunnerState {
    pub fn label(&self) -> String {
        match self {
            Self::Stopped => "Runner stopped".to_string(),
            Self::Running => "Runner answering".to_string(),
            Self::Exited { code } => format!("Runner stopped unexpectedly (status {code})"),
            Self::Unavailable => crate::distribution::runner_unavailable(),
        }
    }

    pub fn is_running(&self) -> bool {
        matches!(self, Self::Running)
    }
}

pub struct RunnerSupervisor {
    program: PathBuf,
    home: Option<PathBuf>,
    child: Option<Child>,
    state: RunnerState,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SupervisorError {
    AlreadyRunning,
    CouldNotStart(String),
}

impl std::fmt::Display for SupervisorError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AlreadyRunning => write!(f, "the runner is already answering"),
            Self::CouldNotStart(reason) => write!(f, "could not start the runner: {reason}"),
        }
    }
}

impl RunnerSupervisor {
    pub fn new(program: PathBuf, home: Option<PathBuf>) -> Self {
        Self {
            program,
            home,
            child: None,
            state: RunnerState::Stopped,
        }
    }

    /// What the tray should say. Polls the child, so a daemon that died is
    /// noticed rather than reported as answering forever.
    pub fn state(&mut self) -> RunnerState {
        if let Some(child) = self.child.as_mut() {
            match child.try_wait() {
                Ok(Some(status)) => {
                    self.child = None;
                    self.state = RunnerState::Exited {
                        code: status.code().unwrap_or(-1),
                    };
                }
                Ok(None) => self.state = RunnerState::Running,
                // A child that cannot be polled is one this shell has lost
                // track of; claiming it is running would be a lie a person
                // acts on.
                Err(_) => {
                    self.child = None;
                    self.state = RunnerState::Exited { code: -1 };
                }
            }
        }
        self.state
    }

    /// Start the daemon.
    ///
    /// It is given its own process group so the stop below can take the whole
    /// tree — a runner's children are harnesses, and a harness left alive after
    /// a stop is the failure this shell exists to prevent.
    pub fn start(&mut self) -> Result<(), SupervisorError> {
        if self.state().is_running() {
            return Err(SupervisorError::AlreadyRunning);
        }
        let mut command = Command::new(&self.program);
        command.arg("run");
        if let Some(home) = self.home.as_ref() {
            command.env("LEPIDY_HOME", home);
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let child = command
            .spawn()
            .map_err(|error| SupervisorError::CouldNotStart(error.to_string()))?;
        self.child = Some(child);
        self.state = RunnerState::Running;
        Ok(())
    }

    /// Stop the daemon and everything it started.
    ///
    /// Unconditional and idempotent: no gesture, no confirmation, no error when
    /// nothing is running. The protective direction has to be the one that
    /// always works, and asking a person to confirm a stop is how a stop gets
    /// skipped at the moment it is needed.
    pub fn stop(&mut self) -> RunnerState {
        let Some(mut child) = self.child.take() else {
            self.state = RunnerState::Stopped;
            return self.state;
        };
        lepidy_runner::process::signal_tree(child.id(), false);
        let deadline = Instant::now() + GRACE;
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                self.state = RunnerState::Stopped;
                return self.state;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        lepidy_runner::process::signal_tree(child.id(), true);
        let _ = child.kill();
        let _ = child.wait();
        self.state = RunnerState::Stopped;
        self.state
    }
}

impl Drop for RunnerSupervisor {
    fn drop(&mut self) {
        // Closing the window must not leave a daemon behind that nobody can
        // see and nobody remembers starting.
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sleeper() -> (PathBuf, Vec<String>) {
        #[cfg(unix)]
        return (
            PathBuf::from("/bin/sh"),
            vec!["-c".into(), "sleep 120".into()],
        );
        #[cfg(windows)]
        return (
            PathBuf::from("cmd"),
            vec!["/C".into(), "timeout /T 120 /NOBREAK > NUL".into()],
        );
    }

    /// The supervisor drives `<program> run`, so a stand-in has to accept an
    /// argument it ignores. A shell script is the portable way to say that.
    fn stand_in() -> RunnerSupervisor {
        let (program, _) = sleeper();
        let mut supervisor = RunnerSupervisor::new(program, None);
        // `sh run` and `cmd run` both fail immediately, which is exactly the
        // "could not stay up" case one scenario below wants.
        supervisor.state = RunnerState::Stopped;
        supervisor
    }

    #[test]
    fn reports_stopped_before_anything_has_run() {
        let mut supervisor = stand_in();
        assert_eq!(supervisor.state(), RunnerState::Stopped);
        assert_eq!(supervisor.state().label(), "Runner stopped");
    }

    #[test]
    fn stopping_when_nothing_is_running_is_not_an_error() {
        // The protective direction has to be the one that always works, and a
        // person hitting stop twice must not see a failure.
        let mut supervisor = stand_in();
        assert_eq!(supervisor.stop(), RunnerState::Stopped);
        assert_eq!(supervisor.stop(), RunnerState::Stopped);
    }

    #[test]
    fn a_missing_binary_is_reported_rather_than_pretended() {
        let mut supervisor =
            RunnerSupervisor::new(PathBuf::from("lepidy-agentd-not-installed"), None);
        let error = supervisor
            .start()
            .expect_err("a missing daemon cannot start");
        assert!(
            matches!(error, SupervisorError::CouldNotStart(_)),
            "{error:?}"
        );
        assert_eq!(supervisor.state(), RunnerState::Stopped);
    }

    #[test]
    fn notices_a_daemon_that_exited_on_its_own() {
        // `sh run` exits immediately: a daemon that will not stay up. It must
        // read as "stopped unexpectedly" rather than "answering", because a
        // person deciding whether their agents are covered acts on that.
        let (program, _) = sleeper();
        let mut supervisor = RunnerSupervisor::new(program, None);
        supervisor.start().expect("the stand-in starts");
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if !supervisor.state().is_running() {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        match supervisor.state() {
            RunnerState::Exited { .. } => {}
            other => panic!("expected an exit, saw {other:?}"),
        }
        assert!(supervisor.state().label().contains("unexpectedly"));
    }
}
