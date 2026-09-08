//! Starting a harness, and being able to stop all of it.
//!
//! A harness does not stay one process. It spawns compilers, package managers,
//! test runners and shells, and killing the one this daemon knows about leaves
//! that whole tree alive — still holding injected credentials, still writing
//! files, still costing money. So a run is tracked as a tree from the start:
//! on Unix the child leads its own process group and the group is signalled; on
//! Windows the tree is terminated with `taskkill /T`, which is that platform's
//! documented answer to the same problem.
//!
//! Stopping is two-stage everywhere. A terminate signal first, so a harness can
//! finish a write and exit; a kill after a grace period, because "asked
//! politely" is not a guarantee.

use std::io;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use crate::daemon::HarnessSession;
use crate::preset::Preset;

/// How long a tree gets to exit after being asked, before it is killed.
pub const GRACE: Duration = Duration::from_secs(10);

pub struct RunningProcess {
    pub agent_id: String,
    pub request_id: String,
    pub session_id: String,
    pub started_at: Instant,
    pub deadline: Instant,
    child: Child,
}

impl RunningProcess {
    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// Has it finished on its own? Never blocks: the daemon has a socket to
    /// keep reading, and a harness that takes an hour is normal.
    pub fn try_exit(&mut self) -> io::Result<Option<i32>> {
        Ok(self
            .child
            .try_wait()?
            .map(|status| status.code().unwrap_or(-1)))
    }

    pub fn is_overdue(&self, now: Instant) -> bool {
        now >= self.deadline
    }

    /// Ask the whole tree to stop, then make sure it did.
    pub fn terminate_tree(&mut self) -> io::Result<()> {
        signal_tree(self.child.id(), false);
        let waited_until = Instant::now() + GRACE;
        while Instant::now() < waited_until {
            if self.child.try_wait()?.is_some() {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        signal_tree(self.child.id(), true);
        // The direct child is killed too: on Unix the group signal covers it,
        // but a child that changed its own process group would not be reached,
        // and this is the one process whose handle this daemon holds.
        let _ = self.child.kill();
        let _ = self.child.wait();
        Ok(())
    }
}

/// Start one run of a preset.
///
/// The environment is the preset's and this machine's, never the trigger's: a
/// wake carries no environment mapping, so there is nothing here for a
/// workspace to influence. What the child is given is which agent it is
/// answering for, where to speak MCP, and the session token to speak it with.
///
/// The token goes in the environment and never in `argv`, for the same reason
/// no credential ever does: a command line is readable by every other process
/// on the machine and is captured verbatim by harness logs. The environment is
/// visible to the child and its descendants — which is the point, since the
/// harness is the thing that has to use it — and to nobody else.
pub fn spawn_preset(
    preset: &Preset,
    session: &HarnessSession,
    request_id: &str,
    workspace_id: &str,
    now: Instant,
) -> io::Result<RunningProcess> {
    let mut command = Command::new(&preset.program);
    command.args(&preset.args);
    // The preset's own environment, applied before Lepidy's, so nothing a local
    // operator sets can quietly overwrite the session the daemon is handing over.
    for (name, value) in &preset.environment {
        command.env(name, value);
    }
    if let Some(directory) = preset.working_directory.as_deref() {
        command.current_dir(Path::new(directory));
    }
    // Ids, an endpoint and a session token. A harness needs to know which agent
    // it is answering for and how to reach the workspace; it does not need, and
    // is not given, anything the workspace wrote as prose.
    command
        .env("LEPIDY_AGENT_ID", &session.agent_id)
        .env("LEPIDY_REQUEST_ID", request_id)
        .env("LEPIDY_WORKSPACE_ID", workspace_id)
        .env("LEPIDY_PRESET_ID", &preset.id)
        .env("LEPIDY_MCP_URL", &session.mcp_url)
        .env("LEPIDY_SESSION_ID", &session.session_id)
        .env("LEPIDY_SESSION_TOKEN", &session.token)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own process group, so everything it spawns can be signalled as
        // one and nothing it spawns outlives it.
        command.process_group(0);
    }

    let child = command.spawn()?;
    Ok(RunningProcess {
        agent_id: session.agent_id.clone(),
        request_id: request_id.to_string(),
        session_id: session.session_id.clone(),
        started_at: now,
        deadline: now + Duration::from_secs(preset.timeout_seconds),
        child,
    })
}

/// Signal an entire tree. Best effort: a tree that has already exited is the
/// outcome this was asking for, and a signal to a reaped pid must not be fatal.
#[cfg(unix)]
fn signal_tree(pid: u32, force: bool) {
    use nix::sys::signal::{killpg, Signal};
    use nix::unistd::Pid;

    let group = Pid::from_raw(pid as i32);
    let signal = if force {
        Signal::SIGKILL
    } else {
        Signal::SIGTERM
    };
    let _ = killpg(group, signal);
}

#[cfg(windows)]
fn signal_tree(pid: u32, force: bool) {
    // `/T` is the tree; `/F` is the forceful half of the two-stage stop. There
    // is no graceful tree-wide signal on Windows, so the first pass asks
    // `taskkill` to close the process politely and the second forces it.
    let mut command = Command::new("taskkill");
    command.arg("/PID").arg(pid.to_string()).arg("/T");
    if force {
        command.arg("/F");
    }
    let _ = command.stdout(Stdio::null()).stderr(Stdio::null()).status();
}

#[cfg(not(any(unix, windows)))]
fn signal_tree(_pid: u32, _force: bool) {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    /// A session, as the daemon hands one to a child.
    fn session() -> HarnessSession {
        HarnessSession {
            agent_id: "agent-1".to_string(),
            session_id: "session-1".to_string(),
            token: "lpd_st_test_token".to_string(),
            mcp_url: "http://127.0.0.1:1/w/test/mcp".to_string(),
            token_expires_at: u64::MAX,
        }
    }

    fn sleeping_preset(seconds: u64, timeout_seconds: u64) -> Preset {
        // A shell is used rather than a compiled helper because the point of
        // the test is the *tree*: the shell is one process and the sleep it
        // starts is another, and killing only the first would leave the second.
        #[cfg(unix)]
        let (program, args) = (
            "/bin/sh".to_string(),
            vec!["-c".to_string(), format!("sleep {seconds}")],
        );
        #[cfg(windows)]
        let (program, args) = (
            "cmd".to_string(),
            vec![
                "/C".to_string(),
                format!("timeout /T {seconds} /NOBREAK > NUL"),
            ],
        );
        Preset {
            id: "preset-test".to_string(),
            program,
            args,
            working_directory: None,
            credentials: BTreeMap::new(),
            environment: BTreeMap::new(),
            max_concurrent: 1,
            cooldown_seconds: 0,
            timeout_seconds,
        }
    }

    #[test]
    fn runs_a_preset_and_reports_its_exit() {
        #[cfg(unix)]
        let preset = Preset {
            program: "/bin/sh".to_string(),
            args: vec!["-c".to_string(), "exit 3".to_string()],
            ..sleeping_preset(0, 30)
        };
        #[cfg(windows)]
        let preset = Preset {
            program: "cmd".to_string(),
            args: vec!["/C".to_string(), "exit 3".to_string()],
            ..sleeping_preset(0, 30)
        };
        let mut running = spawn_preset(
            &preset,
            &session(),
            "request-1",
            "workspace-1",
            Instant::now(),
        )
        .expect("the preset starts");
        let mut code = None;
        for _ in 0..200 {
            code = running.try_exit().expect("the child can be polled");
            if code.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        assert_eq!(
            code,
            Some(3),
            "the harness's own exit status is what the daemon sees"
        );
    }

    #[test]
    fn stops_a_run_that_is_still_going() {
        let preset = sleeping_preset(120, 300);
        let mut running = spawn_preset(
            &preset,
            &session(),
            "request-1",
            "workspace-1",
            Instant::now(),
        )
        .expect("the preset starts");
        assert!(
            running.try_exit().expect("poll").is_none(),
            "it should still be running"
        );
        running.terminate_tree().expect("the tree stops");
        assert!(
            running.try_exit().expect("poll").is_some(),
            "a terminated run must not still be running",
        );
    }

    #[test]
    fn a_run_past_its_deadline_is_overdue() {
        let preset = sleeping_preset(120, 0);
        let started = Instant::now();
        let mut running = spawn_preset(&preset, &session(), "request-1", "workspace-1", started)
            .expect("the preset starts");
        // A harness that hangs is the ordinary case this exists for: no error,
        // no exit, just a process that never finishes.
        assert!(running.is_overdue(started + Duration::from_secs(1)));
        running.terminate_tree().expect("the tree stops");
    }

    #[cfg(unix)]
    #[test]
    fn stops_the_whole_tree_and_not_only_the_process_it_started() {
        use std::path::PathBuf;

        // The grandchild outlives its parent shell on purpose: it writes to a
        // file after a delay, so if the tree survived the stop, the file
        // appears. This is the failure the process group exists to prevent.
        let marker: PathBuf =
            std::env::temp_dir().join(format!("lepidy-tree-{}-{}", std::process::id(), "marker"));
        let _ = std::fs::remove_file(&marker);
        let script = format!("(sleep 2; echo escaped > {}) & sleep 30", marker.display());
        let preset = Preset {
            program: "/bin/sh".to_string(),
            args: vec!["-c".to_string(), script],
            ..sleeping_preset(30, 60)
        };

        let mut running = spawn_preset(
            &preset,
            &session(),
            "request-1",
            "workspace-1",
            Instant::now(),
        )
        .expect("the preset starts");
        std::thread::sleep(Duration::from_millis(300));
        running.terminate_tree().expect("the tree stops");

        std::thread::sleep(Duration::from_secs(3));
        assert!(
            !marker.exists(),
            "a grandchild outlived the stop and wrote {}",
            marker.display(),
        );
        let _ = std::fs::remove_file(&marker);
    }
}
