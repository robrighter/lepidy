//! The native surface, as configuration.
//!
//! Everything the desktop shell can do is decided in three files: the command
//! list in `lib.rs`, the capability grants in `capabilities/default.json`, and
//! the window security settings in `tauri.conf.json`. None of those fails a
//! compile when it grows, and all three are exactly where a capability creeps
//! in — somebody adds a plugin permission to make one feature work and nobody
//! notices it also handed the page a filesystem.
//!
//! So they are asserted here, by content rather than by shape, and a change to
//! any of them has to be made deliberately with this test in front of it.

use serde_json::Value;

fn read(relative: &str) -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
    std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// The whole native surface a page can reach. Adding to this list is the point
/// at which somebody should have to think.
const COMMANDS: [&str; 5] = [
    "runner_status",
    "runner_stop",
    "runner_start",
    "local_verify",
    "platform_name",
];

#[test]
fn native_int_001_exposes_exactly_five_commands() {
    let source = read("src/lib.rs");
    let handler = source
        .split_once("generate_handler![")
        .expect("the shell registers an invoke handler")
        .1
        .split_once(']')
        .expect("the handler list is closed")
        .0;
    let listed: Vec<String> = handler
        .split(',')
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .collect();
    assert_eq!(listed, COMMANDS, "the native command surface changed");

    // And each one is actually defined as a command, so the list is not
    // aspirational.
    for command in COMMANDS {
        assert!(
            source.contains(&format!("fn {command}(")),
            "{command} is registered but not defined",
        );
    }
}

#[test]
fn native_int_002_every_command_checks_where_it_came_from() {
    let ipc = read("src/ipc.rs");
    // The check is one function, and every entry point calls it. A command that
    // forgot to would be a command any page could reach.
    for entry in [
        "runner_status",
        "runner_stop",
        "runner_start",
        "local_verify",
    ] {
        let body = ipc
            .split_once(&format!("pub fn {entry}("))
            .unwrap_or_else(|| panic!("{entry} is not defined in ipc.rs"))
            .1;
        let body = body.split_once("\n}").expect("a function body").0;
        assert!(
            body.contains("require_trusted_caller"),
            "{entry} does not check the caller's origin",
        );
    }
    // `platform_name` lives in lib.rs because it answers with a constant, and
    // it checks too.
    let shell = read("src/lib.rs");
    let platform = shell
        .split_once("fn platform_name(")
        .expect("platform_name is defined")
        .1
        .split_once("\n}")
        .expect("a function body")
        .0;
    assert!(platform.contains("require_trusted_caller"));
}

#[test]
fn native_int_003_grants_no_capability_that_reaches_past_the_window() {
    let capability: Value = serde_json::from_str(&read("capabilities/default.json"))
        .expect("the capability file is json");
    let permissions: Vec<String> = capability["permissions"]
        .as_array()
        .expect("permissions is a list")
        .iter()
        .map(|value| {
            value
                .as_str()
                .expect("a permission is a string")
                .to_string()
        })
        .collect();

    // Window chrome and nothing else. These are the plugins whose permissions
    // would hand the page the machine, and none of them is granted.
    for forbidden in [
        "shell",
        "fs:",
        "process",
        "http",
        "updater",
        "notification",
        "clipboard",
        "dialog",
    ] {
        assert!(
            !permissions
                .iter()
                .any(|permission| permission.contains(forbidden)),
            "the capability file grants {forbidden}: {permissions:?}",
        );
    }
    assert!(
        permissions
            .iter()
            .all(|permission| permission.starts_with("core:")),
        "a non-core permission appeared: {permissions:?}",
    );
    // Scoped to the one window, so a future window does not inherit this.
    assert_eq!(capability["windows"], serde_json::json!(["main"]));
}

#[test]
fn native_int_004_keeps_the_window_from_being_a_general_purpose_browser() {
    let config: Value = serde_json::from_str(&read("tauri.conf.json")).expect("the config is json");
    // No global Tauri object: a page reaches the native side through the
    // generated bindings or not at all.
    assert_eq!(config["app"]["withGlobalTauri"], Value::Bool(false));

    let csp = config["app"]["security"]["csp"]
        .as_str()
        .expect("a content security policy is set");
    assert!(csp.starts_with("default-src 'self'"), "{csp}");
    // `unsafe-eval` in this window would make every string a page can build
    // into code, and the content in this product is written by strangers.
    assert!(!csp.contains("unsafe-eval"), "{csp}");
    assert!(
        !csp.contains("script-src") || !csp.contains("unsafe-inline"),
        "{csp}"
    );

    // The one remote origin the capability file admits is loopback, for
    // development. A production origin is given at runtime and checked by
    // `TrustedOrigin`, not baked in here.
    let capability: Value = serde_json::from_str(&read("capabilities/default.json"))
        .expect("the capability file is json");
    let remotes: Vec<String> = capability["remote"]["urls"]
        .as_array()
        .expect("remote urls")
        .iter()
        .map(|value| value.as_str().expect("a url").to_string())
        .collect();
    for remote in &remotes {
        assert!(
            remote.starts_with("http://localhost") || remote.starts_with("https://"),
            "a plain-http remote origin was admitted: {remote}",
        );
    }
}

#[test]
fn native_int_005_stop_is_the_one_thing_that_never_asks() {
    let ipc = read("src/ipc.rs");
    let stop = ipc
        .split_once("pub fn runner_stop(")
        .expect("runner_stop is defined")
        .1
        .split_once("\n}")
        .expect("a function body")
        .0;
    // No confirmation in the way. A stop that can be refused is a stop that
    // gets skipped at the moment it is needed, and the worst case of an
    // unnecessary stop is that somebody's agents go idle.
    assert!(
        !stop.contains("consume") && !stop.contains("verify"),
        "runner_stop asks for something first: {stop}",
    );

    // The tray's stop goes straight to the supervisor for the same reason.
    let shell = read("src/lib.rs");
    let tray = shell
        .split_once("\"stop\" => {")
        .expect("the tray has a stop item")
        .1
        .split_once("\n            }")
        .expect("a match arm")
        .0;
    assert!(tray.contains("supervisor"), "{tray}");
    assert!(
        !tray.contains("verify") && !tray.contains("consume"),
        "{tray}"
    );
}
