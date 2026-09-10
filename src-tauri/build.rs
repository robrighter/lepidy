/// The whole native command surface, declared to the access-control layer.
///
/// Tauri refuses a custom command to a **remote** origin unless a capability
/// names it — and this workspace is served from a remote origin, so without
/// this list the shell's own commands are unreachable from the only page that
/// is ever supposed to call them. P01b's GUI harness is what found that: every
/// other test in this repository exercises the commands as Rust, where the
/// access-control layer is not in the way.
///
/// So the list lives here as well as in `generate_handler!` and in the
/// capability files, and `native_boundary.rs` asserts all three agree. Three
/// places is more than one, but each of them is a place somebody would have to
/// deliberately add a command to, which is exactly the property this surface is
/// supposed to have.
const COMMANDS: &[&str] = &[
    "runner_status",
    "runner_stop",
    "runner_start",
    "local_verify",
    "platform_name",
    "notify",
    "set_badge",
];

fn main() {
    // The triple this binary is being built for, so the bundle gate can name
    // the sidecars Tauri will look for without being told what platform it is
    // on. `TARGET` is only available to a build script, which is why it is
    // captured here rather than read at runtime.
    println!(
        "cargo:rustc-env=LEPIDY_TARGET_TRIPLE={}",
        std::env::var("TARGET").expect("cargo sets TARGET for a build script"),
    );
    // The updater's public key is compiled in, so a change to it is a rebuild
    // rather than something a file next to the application can alter.
    println!("cargo:rerun-if-env-changed=LEPIDY_UPDATER_PUBKEY");

    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to build the Lepidy desktop shell");
}
