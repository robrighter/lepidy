//! Everything about a preset that can be answered without a model (R04).
//!
//! Certifying a harness end to end needs a model provider, an API key and a
//! network, and none of those belong in a verification gate. But most of what
//! goes wrong with a preset is not the model: it is a program that is not
//! there, a working directory that has been deleted, a harness that has been
//! upgraded since somebody validated it, or a Windows executable named from a
//! Linux daemon that cannot stop it afterwards. All of those are answerable
//! offline, on the machine, in a second — and each of them is a preset that
//! would otherwise fail silently the first time an agent is actually mentioned.
//!
//! So this is the part of the matrix that can be *proved* rather than asserted,
//! and `lepidy-agentd preset check` is how an operator proves the rest of it on
//! a machine this project cannot reach.

use std::path::Path;
use std::process::{Command, Stdio};

use crate::preset::Preset;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Verdict {
    Ok(String),
    /// Worth a person's attention, but the preset will still run.
    Warn(String),
    /// The preset will not work. Reported before anything is started.
    Fail(String),
}

impl Verdict {
    pub fn is_fail(&self) -> bool {
        matches!(self, Self::Fail(_))
    }

    pub fn marker(&self) -> &'static str {
        match self {
            Self::Ok(_) => "ok  ",
            Self::Warn(_) => "warn",
            Self::Fail(_) => "FAIL",
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Self::Ok(message) | Self::Warn(message) | Self::Fail(message) => message,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct Checkup {
    pub preset_id: String,
    pub findings: Vec<(&'static str, Verdict)>,
    /// The harness version observed now, if it would say.
    pub observed_version: Option<String>,
}

impl Checkup {
    pub fn passed(&self) -> bool {
        !self.findings.iter().any(|(_, verdict)| verdict.is_fail())
    }
}

/// Which side of the WSL boundary a path is on.
///
/// This matters more than it looks. A Linux daemon that starts a Windows
/// executable gets a process it cannot put in a process group and cannot
/// signal: `kill` reaches the interop stub, not the program, so a stop leaves
/// the harness running with its injected credentials. The reverse — a Windows
/// daemon starting `wsl.exe something` — has the same hole from the other side.
/// The rule is therefore simple and absolute: **a preset must name a program on
/// the same side of the boundary as the daemon that will run it.**
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Native,
    /// A Windows program, seen from Linux, through `/mnt/<drive>/`.
    WindowsFromLinux,
    /// A Linux program, launched from Windows through the interop shim.
    LinuxFromWindows,
}

/// Where the daemon itself is running.
///
/// Passed in rather than read from `cfg!`, so the rule below can be proved on
/// every platform rather than only on whichever one a given test run happens to
/// be on. That is the central difficulty with an operating-system matrix, and
/// this is the one place it is cheap to fix.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Host {
    Linux { wsl: bool },
    Windows,
    Other,
}

pub fn current_host() -> Host {
    if cfg!(windows) {
        Host::Windows
    } else if cfg!(target_os = "linux") {
        Host::Linux {
            wsl: running_under_wsl(),
        }
    } else {
        Host::Other
    }
}

/// Read the side a program is on from its path and the host running it.
pub fn side_of(program: &str, host: Host) -> Side {
    let lowered = program.to_ascii_lowercase();
    match host {
        Host::Linux { wsl: true } => {
            // `/mnt/c/...` and a bare `something.exe` both reach the Windows
            // side through the interop layer.
            let mounted = lowered.starts_with("/mnt/") && lowered.get(6..7) == Some("/");
            if mounted || lowered.ends_with(".exe") {
                Side::WindowsFromLinux
            } else {
                Side::Native
            }
        }
        Host::Windows => {
            // Split on both separators rather than through `Path`, which parses
            // by the platform this code is *running* on: a Windows path checked
            // from a Linux test run would otherwise come back as one long file
            // name, and the rule would silently stop applying.
            let file = lowered.rsplit(['\\', '/']).next().unwrap_or_default();
            if file == "wsl.exe" || file == "wsl" || file == "bash.exe" {
                Side::LinuxFromWindows
            } else {
                Side::Native
            }
        }
        Host::Linux { wsl: false } | Host::Other => Side::Native,
    }
}

/// Is this Linux actually WSL?
pub fn running_under_wsl() -> bool {
    if !cfg!(unix) {
        return false;
    }
    std::fs::read_to_string("/proc/sys/kernel/osrelease")
        .map(|release| {
            let lowered = release.to_ascii_lowercase();
            lowered.contains("microsoft") || lowered.contains("wsl")
        })
        .unwrap_or(false)
}

/// Everything answerable offline about one preset.
pub fn check_preset(preset: &Preset, host: Host) -> Checkup {
    let mut findings: Vec<(&'static str, Verdict)> = Vec::new();

    findings.push(("program", check_program(&preset.program)));
    findings.push((
        "boundary",
        match side_of(&preset.program, host) {
            Side::Native => Verdict::Ok("the program runs on the same side as this daemon".into()),
            Side::WindowsFromLinux => Verdict::Fail(
                "this is a Windows program named from a Linux daemon: a stop cannot signal it, \
                 so a harness would keep running with its injected credentials. Run the daemon \
                 on Windows, or name a Linux program"
                    .into(),
            ),
            Side::LinuxFromWindows => Verdict::Fail(
                "this launches into WSL from a Windows daemon: the process tree does not nest \
                 across that boundary, so a stop cannot reach the harness. Run the daemon inside \
                 WSL instead"
                    .into(),
            ),
        },
    ));
    findings.push((
        "directory",
        check_directory(preset.working_directory.as_deref()),
    ));
    findings.push(("limits", check_limits(preset)));

    let observed = observe_version(&preset.program);
    findings.push(("version", check_version(preset, observed.as_deref())));

    Checkup {
        preset_id: preset.id.clone(),
        findings,
        observed_version: observed,
    }
}

fn check_program(program: &str) -> Verdict {
    let path = Path::new(program);
    // A bare name is resolved through PATH at spawn time, which is a decision
    // the operator has made and this cannot second-guess without duplicating
    // the platform's own lookup.
    if path.components().count() <= 1 {
        return Verdict::Warn(format!(
            "{program} is resolved through PATH at run time; name an absolute path to be sure which one runs"
        ));
    }
    if !path.exists() {
        return Verdict::Fail(format!("{program} does not exist"));
    }
    if !path.is_file() {
        return Verdict::Fail(format!("{program} is not a file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let executable = std::fs::metadata(path)
            .map(|data| data.permissions().mode() & 0o111 != 0)
            .unwrap_or(false);
        if !executable {
            return Verdict::Fail(format!("{program} is not executable"));
        }
    }
    Verdict::Ok(format!("{program} exists and can be run"))
}

fn check_directory(directory: Option<&str>) -> Verdict {
    match directory {
        None => Verdict::Ok("no working directory set; the daemon's own is used".into()),
        Some(path) if Path::new(path).is_dir() => Verdict::Ok(format!("{path} exists")),
        Some(path) => Verdict::Fail(format!(
            "{path} is not a directory; every run would fail to start"
        )),
    }
}

/// The brakes, checked for values that would defeat them.
fn check_limits(preset: &Preset) -> Verdict {
    if preset.max_concurrent == 0 {
        return Verdict::Fail("max_concurrent is zero; nothing would ever run".into());
    }
    if preset.timeout_seconds == 0 {
        return Verdict::Fail(
            "timeout_seconds is zero; every run would be killed immediately".into(),
        );
    }
    if preset.cooldown_seconds == 0 && preset.max_concurrent > 1 {
        // Not a failure — somebody may mean it — but it is the combination that
        // turns a mention loop into a fork bomb, and it should be said out loud.
        return Verdict::Warn(
            "no cooldown and more than one concurrent run: a wake storm would start many processes at once"
                .into(),
        );
    }
    Verdict::Ok(format!(
        "{} at once, {}s cooldown, {}s timeout",
        preset.max_concurrent, preset.cooldown_seconds, preset.timeout_seconds
    ))
}

/// Compare the harness this machine has against the one somebody validated.
fn check_version(preset: &Preset, observed: Option<&str>) -> Verdict {
    match (preset.harness_version.as_deref(), observed) {
        (None, Some(observed)) => Verdict::Warn(format!(
            "this preset has never been checked; the harness reports {observed}. \
             Re-run `preset check` to pin it"
        )),
        (None, None) => Verdict::Warn(
            "this preset has never been checked, and the harness would not report a version".into(),
        ),
        (Some(pinned), None) => Verdict::Warn(format!(
            "pinned to {pinned}, but the harness would not report a version now"
        )),
        (Some(pinned), Some(observed)) if pinned == observed => {
            Verdict::Ok(format!("harness {observed}, as pinned"))
        }
        (Some(pinned), Some(observed)) => Verdict::Fail(format!(
            "this preset was validated against {pinned} and the harness is now {observed}. \
             A non-interactive flag, a default permission posture and an exit code can all change \
             between versions, so it is unvalidated until somebody checks it again"
        )),
    }
}

/// Ask the harness what it is, without letting it do anything.
///
/// `--version` is the one question nearly every command-line tool answers the
/// same way, and it costs nothing. Bounded output, no standard input, and a
/// failure is simply "it would not say" rather than an error — plenty of
/// perfectly good programs have no version flag.
pub fn observe_version(program: &str) -> Option<String> {
    let output = Command::new(program)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let rendered = String::from_utf8_lossy(&output.stdout);
    let line = rendered.lines().find(|line| !line.trim().is_empty())?;
    Some(line.trim().chars().take(120).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn preset(program: &str) -> Preset {
        Preset {
            id: "p1".to_string(),
            program: program.to_string(),
            args: Vec::new(),
            working_directory: None,
            credentials: BTreeMap::new(),
            environment: BTreeMap::new(),
            harness_version: None,
            max_concurrent: 1,
            cooldown_seconds: 15,
            timeout_seconds: 60,
        }
    }

    fn finding<'a>(checkup: &'a Checkup, name: &str) -> &'a Verdict {
        &checkup
            .findings
            .iter()
            .find(|(key, _)| *key == name)
            .unwrap_or_else(|| panic!("no {name} finding"))
            .1
    }

    #[test]
    fn refuses_a_program_on_the_other_side_of_the_wsl_boundary() {
        // Proved from both sides, on whatever platform this happens to run on.
        // An OS matrix whose rules can only be checked on one OS is not much of
        // a matrix, and passing the host in is the one place that is cheap to
        // fix.
        let wsl = Host::Linux { wsl: true };
        assert_eq!(
            side_of("/mnt/c/Windows/System32/cmd.exe", wsl),
            Side::WindowsFromLinux
        );
        assert_eq!(side_of("claude.exe", wsl), Side::WindowsFromLinux);
        assert_eq!(side_of("/usr/bin/claude", wsl), Side::Native);

        // Plain Linux: a path that merely looks like a mount is nothing special.
        let linux = Host::Linux { wsl: false };
        assert_eq!(
            side_of("/mnt/c/Windows/System32/cmd.exe", linux),
            Side::Native
        );

        // And from the Windows side, where the same hole opens in reverse.
        assert_eq!(
            side_of(r"C:\Windows\System32\wsl.exe", Host::Windows),
            Side::LinuxFromWindows
        );
        assert_eq!(side_of("bash.exe", Host::Windows), Side::LinuxFromWindows);
        assert_eq!(
            side_of(r"C:\Program Files\claude\claude.exe", Host::Windows),
            Side::Native
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_boundary_finding_says_why_rather_than_just_no() {
        let checkup = check_preset(
            &preset("/mnt/c/Windows/System32/cmd.exe"),
            Host::Linux { wsl: true },
        );
        let Verdict::Fail(message) = finding(&checkup, "boundary") else {
            panic!(
                "a cross-boundary program must fail: {:?}",
                finding(&checkup, "boundary")
            );
        };
        // A person has to be able to act on this, so it names the consequence
        // and the fix rather than only the rule.
        assert!(message.contains("stop cannot signal it"), "{message}");
        assert!(message.contains("Run the daemon on Windows"), "{message}");
        assert!(!checkup.passed());
    }

    #[cfg(unix)]
    #[test]
    fn finds_a_program_that_is_not_there_or_not_executable() {
        let missing = check_preset(&preset("/nonexistent/harness"), Host::Linux { wsl: false });
        assert!(matches!(finding(&missing, "program"), Verdict::Fail(_)));
        assert!(!missing.passed());

        // A real file with no executable bit: the case that produces a runner
        // which refuses every wake with a confusing spawn error.
        let path = std::env::temp_dir().join(format!("lepidy-checkup-{}", std::process::id()));
        std::fs::write(&path, b"#!/bin/sh\n").expect("the temporary directory is writable");
        let checkup = check_preset(&preset(&path.display().to_string()), current_host());
        let Verdict::Fail(message) = finding(&checkup, "program") else {
            panic!("a non-executable file must fail");
        };
        assert!(message.contains("not executable"), "{message}");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_bare_name_is_a_warning_rather_than_a_refusal() {
        // Resolved through PATH at run time. That is a decision an operator has
        // made, and second-guessing it would mean re-implementing the
        // platform's own lookup.
        let checkup = check_preset(&preset("claude"), current_host());
        assert!(matches!(finding(&checkup, "program"), Verdict::Warn(_)));
    }

    #[test]
    fn refuses_a_working_directory_that_has_been_deleted() {
        let mut deleted = preset("/bin/sh");
        deleted.working_directory = Some("/nonexistent/place".to_string());
        let checkup = check_preset(&deleted, current_host());
        assert!(matches!(finding(&checkup, "directory"), Verdict::Fail(_)));
    }

    #[test]
    fn refuses_limits_that_would_defeat_the_brakes() {
        let mut none = preset("/bin/sh");
        none.max_concurrent = 0;
        assert!(matches!(
            finding(&check_preset(&none, current_host()), "limits"),
            Verdict::Fail(_)
        ));

        let mut instant = preset("/bin/sh");
        instant.timeout_seconds = 0;
        assert!(matches!(
            finding(&check_preset(&instant, current_host()), "limits"),
            Verdict::Fail(_)
        ));

        // The combination that turns a mention loop into a fork bomb. Allowed,
        // because somebody may mean it, but never silent.
        let mut wide = preset("/bin/sh");
        wide.cooldown_seconds = 0;
        wide.max_concurrent = 8;
        assert!(matches!(
            finding(&check_preset(&wide, current_host()), "limits"),
            Verdict::Warn(_)
        ));
    }

    #[test]
    fn a_harness_that_has_been_upgraded_since_validation_is_unvalidated() {
        let mut pinned = preset("/bin/sh");
        pinned.harness_version = Some("Claude Code 2.1.241".to_string());
        // Compared as text: a non-interactive flag, a default permission
        // posture and an exit code can all change between versions, so any
        // difference is a reason to look rather than a judgement about which
        // way the version moved.
        let verdict = check_version(&pinned, Some("Claude Code 3.0.0"));
        let Verdict::Fail(message) = verdict else {
            panic!("an upgraded harness must fail the check");
        };
        assert!(
            message.contains("2.1.241") && message.contains("3.0.0"),
            "{message}"
        );
        assert_eq!(
            check_version(&pinned, Some("Claude Code 2.1.241")),
            Verdict::Ok("harness Claude Code 2.1.241, as pinned".to_string()),
        );
        // Never checked is a warning, not a failure: a preset somebody has just
        // written should still be runnable.
        assert!(matches!(
            check_version(&preset("/bin/sh"), Some("x 1.0")),
            Verdict::Warn(_)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn reads_a_version_from_a_real_program() {
        // A real process, not a stub: reading a version is the one thing this
        // does that touches another program, and a mock would prove nothing
        // about how output actually arrives.
        let observed = observe_version("/bin/sh");
        // `sh --version` prints on some systems and fails on others; both are
        // valid answers and neither may panic.
        if let Some(observed) = observed {
            assert!(!observed.is_empty());
            assert!(observed.len() <= 120);
        }
    }
}
