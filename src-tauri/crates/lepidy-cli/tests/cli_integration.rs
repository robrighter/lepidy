//! The CLI's integration suite: the compiled binary, a real loopback server, a
//! real child process, real files.
//!
//! Everything asserted here crosses a boundary a unit test cannot reach —
//! whether a value ever left the machine in the clear, whether it reached a
//! child's environment, whether a refusal stopped a spawn, what the exit status
//! was, and whether the temporary file is gone afterwards.

mod support;

use std::path::PathBuf;

use lepidy_cli::profile::{load_profile_at, unseal};
use serde_json::Value;
use support::*;

/// VAULT-CLI-INT-001 — enrolment keeps every secret local.
#[test]
fn vault_cli_int_001_login_enrols_without_sending_any_key_material() {
    let double = Double::start();
    let home = TempHome::create("login");

    let output = login(&home, &double);
    assert!(
        output.status.success(),
        "login failed: {}",
        text(&output.stderr)
    );

    let profile = home.profile_json();
    assert_eq!(profile["deviceId"], DEVICE_ID);
    assert_eq!(profile["workspaceId"], WORKSPACE_ID);
    assert_eq!(profile["memberId"], MEMBER_ID);
    assert_eq!(profile["vaultKeyEpoch"], 1);

    // The enrolment request carries public halves and the account password, and
    // nothing else. The passphrase, the recovery code and both private keys are
    // the material Lepidy must never be able to obtain.
    let recovery = recovery_code(&text(&output.stdout));
    let sent =
        String::from_utf8_lossy(&double.with_state(|state| state.bodies("/api/device/enroll"))[0])
            .to_string();
    assert_absent(&sent, PASSPHRASE, "the enrolment request");
    assert_absent(&sent, &recovery, "the enrolment request");
    assert!(
        sent.contains("vaultPublicKey"),
        "the enrolment request did not publish a public key"
    );
    assert!(
        !sent.contains("\"d\":"),
        "the enrolment request carried a private JWK component"
    );

    // Nor does the profile hold them in the clear: the private keys are inside
    // the sealed keystore and the passphrase is nowhere at all.
    let stored = home.profile_text();
    assert_absent(&stored, PASSPHRASE, "the stored profile");
    assert_absent(&stored, &recovery, "the stored profile");

    // The keystore opens with the passphrase, and equally with the recovery
    // code — the only two things that can open it, and neither ever left here.
    let loaded = load_profile_at(&home.path.join("profile.json")).expect("the written profile");
    let by_passphrase = unseal(&loaded, PASSPHRASE).expect("the passphrase to open the keystore");
    let by_recovery = unseal(&loaded, &recovery).expect("the recovery code to open the keystore");
    assert_eq!(
        by_passphrase.vault_private_key,
        by_recovery.vault_private_key
    );
    assert!(unseal(&loaded, "not the passphrase").is_err());

    // The cloud recovery copy is ciphertext too. It is signed by this device,
    // but neither the printable code nor the private key appears in the body.
    let recovery_bodies = double.with_state(|state| state.bodies("/api/device/vault/recovery"));
    assert_eq!(recovery_bodies.len(), 1);
    let recovery_request = String::from_utf8_lossy(&recovery_bodies[0]).to_string();
    assert_absent(&recovery_request, &recovery, "the recovery package request");
    assert_absent(
        &recovery_request,
        &by_passphrase.vault_private_key,
        "the recovery package request",
    );
    assert!(recovery_request.contains("ARGON2ID-AES256GCM"));
}

/// VAULT-CLI-INT-002 — enrolment is refused, and nothing is written.
#[test]
fn vault_cli_int_002_a_refused_login_leaves_no_profile() {
    let double = Double::start();
    let home = TempHome::create("login-refused");
    double.with_state(|state| state.enrol_status = 401);

    let output = login(&home, &double);
    assert_eq!(output.status.code(), Some(1));
    assert!(text(&output.stderr).contains("enrolment refused"));
    assert!(
        !home.path.join("profile.json").exists(),
        "a refused login wrote a profile"
    );
}

/// V07-CLI-INT-001 — a replacement device recovers and rekeys without sending
/// either the recovery code, a private key, a DEK or the credential value.
#[test]
fn v07_cli_int_001_recovers_a_lost_device_and_invalidates_the_old_code() {
    let double = Double::start();
    let original_home = TempHome::create("v07-recovery-original");
    let original_login = login(&original_home, &double);
    assert!(original_login.status.success());
    let original_code = recovery_code(&text(&original_login.stdout));
    let original_profile = load_profile_at(&original_home.path.join("profile.json")).unwrap();
    let original_secrets = unseal(&original_profile, PASSPHRASE).unwrap();

    let added = cli(
        &original_home,
        &[
            "add",
            CREDENTIAL_NAME,
            "--mode",
            "auto",
            "--delivery",
            "inject",
        ],
        &[PASSPHRASE, ACCOUNT_PASSWORD, CANARY],
    );
    assert!(
        added.status.success(),
        "add failed: {}",
        text(&added.stderr)
    );

    double.with_state(|state| state.vault_key_published = false);
    let replacement_home = TempHome::create("v07-recovery-replacement");
    let replacement_login = login(&replacement_home, &double);
    assert!(replacement_login.status.success());
    assert_eq!(replacement_home.profile_json()["vaultKeyEpoch"], 0);

    let recovered = cli(
        &replacement_home,
        &["recover"],
        &[PASSPHRASE, &original_code, ACCOUNT_PASSWORD],
    );
    assert!(
        recovered.status.success(),
        "recovery failed: {}",
        text(&recovered.stderr)
    );
    assert_eq!(replacement_home.profile_json()["vaultKeyEpoch"], 2);
    let output = text(&recovered.stdout);
    assert!(output.contains("rotated the vault key to epoch 2"));
    let new_code = output
        .lines()
        .find_map(|line| line.strip_prefix("New recovery code: "))
        .expect("a rotated recovery code");
    assert_ne!(new_code, original_code);

    double.with_state(|state| {
        for path in [
            "/api/device/vault/recovery",
            "/api/device/vault/member-key/material",
            "/api/device/vault/member-key/rotate",
        ] {
            for body in state.bodies(path) {
                let body = String::from_utf8_lossy(&body);
                assert_absent(&body, &original_code, path);
                assert_absent(&body, new_code, path);
                assert_absent(&body, CANARY, path);
                assert_absent(&body, &original_secrets.vault_private_key, path);
            }
        }
        let rotated: Value = serde_json::from_slice(
            state
                .bodies("/api/device/vault/member-key/rotate")
                .last()
                .expect("a member key rotation"),
        )
        .unwrap();
        assert_eq!(rotated["expectedKeyEpoch"], 1);
        assert_eq!(rotated["replacements"][0]["credentialVersion"], 1);
        assert_eq!(rotated["replacements"][0]["wrap"]["recipientKeyEpoch"], 2);
    });
}

/// VAULT-CLI-INT-003 — listing shows metadata and signs for it.
#[test]
fn vault_cli_int_003_list_shows_metadata_over_a_signed_request() {
    let double = Double::start();
    let home = TempHome::create("list");
    assert!(login(&home, &double).status.success());
    double.with_state(|state| state.credentials = vec![credential_metadata()]);

    let output = cli(&home, &["list"], &[PASSPHRASE]);
    assert!(
        output.status.success(),
        "list failed: {}",
        text(&output.stderr)
    );
    let shown = text(&output.stdout);
    assert!(shown.contains(CREDENTIAL_NAME));
    assert!(shown.contains(CREDENTIAL_ID));
    assert_absent(&shown, CANARY, "the listing");
    assert_absent(&shown, "ciphertext", "the listing");

    // The listing was signed, and the double verified it the way the control
    // plane does rather than taking the request on trust.
    double.with_state(|state| {
        let listed: Vec<_> = state
            .requests
            .iter()
            .filter(|request| request.path == "/api/device/vault/list")
            .collect();
        assert_eq!(listed.len(), 1);
        assert!(
            listed[0].signature_verified,
            "the list request was not correctly signed"
        );
        assert!(listed[0].headers.contains_key("x-lepidy-device-credential"));
    });
}

/// VAULT-CLI-INT-004 — a wrong passphrase opens nothing and calls nothing.
#[test]
fn vault_cli_int_004_a_wrong_passphrase_never_reaches_the_network() {
    let double = Double::start();
    let home = TempHome::create("locked");
    assert!(login(&home, &double).status.success());
    let before = double.with_state(|state| state.requests.len());

    let output = cli(&home, &["list"], &["not the passphrase"]);
    assert_eq!(output.status.code(), Some(1));
    assert!(text(&output.stderr).contains("did not open the local vault"));
    assert_eq!(double.with_state(|state| state.requests.len()), before);
}

/// VAULT-CLI-INT-005 — `add` encrypts before it sends, and only this machine
/// can reverse it.
#[test]
fn vault_cli_int_005_add_seals_the_value_before_it_leaves() {
    let double = Double::start();
    let home = TempHome::create("add");
    assert!(login(&home, &double).status.success());

    let output = cli(
        &home,
        &[
            "add",
            CREDENTIAL_NAME,
            "--mode",
            "auto",
            "--delivery",
            "inject,file",
            "--description",
            "canary",
        ],
        &[PASSPHRASE, ACCOUNT_PASSWORD, CANARY],
    );
    assert!(
        output.status.success(),
        "add failed: {}",
        text(&output.stderr)
    );

    let sent = double.with_state(|state| state.bodies("/api/device/vault/credentials"));
    assert_eq!(sent.len(), 1);
    let raw = String::from_utf8_lossy(&sent[0]).to_string();
    assert_absent(&raw, CANARY, "the create request");
    assert_absent(&raw, PASSPHRASE, "the create request");
    assert_absent(&text(&output.stdout), CANARY, "the add output");

    // What was uploaded is openable only with the key sealed in this machine's
    // keystore — which is the whole zero-knowledge claim, tested rather than
    // asserted.
    let body: serde_json::Value = serde_json::from_slice(&sent[0]).expect("a JSON body");
    let profile = load_profile_at(&home.path.join("profile.json")).expect("the profile");
    let secrets = unseal(&profile, PASSPHRASE).expect("the keystore");

    let credential_id = body["credentialId"].as_str().expect("a credential id");
    let wrap = &body["wraps"][0];
    let decode = |value: &serde_json::Value| {
        lepidy_cli::crypto::decode(value.as_str().expect("base64url"), "field").expect("base64url")
    };
    let dek = secrets
        .vault_key()
        .expect("the vault key")
        .unwrap_dek(
            &decode(&wrap["ephemeralPublicKey"]),
            &decode(&wrap["iv"]),
            &decode(&wrap["wrappedDek"]),
            &lepidy_cli::crypto::wrap_aad(WORKSPACE_ID, credential_id, 1, MEMBER_ID, 1),
        )
        .expect("the wrap to open");
    let opened = lepidy_cli::crypto::aes_gcm_decrypt(
        &dek,
        &decode(&body["envelope"]["iv"]),
        &lepidy_cli::crypto::credential_aad(WORKSPACE_ID, credential_id, 1),
        &decode(&body["envelope"]["ciphertext"]),
    )
    .expect("the envelope to open");
    assert_eq!(String::from_utf8(opened).unwrap(), CANARY);

    // And the wrap is bound to its context: the same key cannot open it under a
    // different credential version.
    assert!(secrets
        .vault_key()
        .expect("the vault key")
        .unwrap_dek(
            &decode(&wrap["ephemeralPublicKey"]),
            &decode(&wrap["iv"]),
            &decode(&wrap["wrappedDek"]),
            &lepidy_cli::crypto::wrap_aad(WORKSPACE_ID, credential_id, 2, MEMBER_ID, 1),
        )
        .is_err());
}

/// VAULT-CLI-INT-006 — an allowed run injects into the child and scrubs what
/// the child prints back.
#[test]
fn vault_cli_int_006_run_injects_and_redacts_the_value_it_injected() {
    let double = Double::start();
    let home = TempHome::create("run-allow");
    assert!(login(&home, &double).status.success());
    let vault_public_key = double
        .with_state(|state| state.vault_public_key.clone())
        .expect("a published key");
    double.with_state(|state| {
        state.credentials = vec![credential_metadata()];
        state.release = allow_release(&vault_public_key);
    });

    let output = cli(
        &home,
        &[
            "run",
            "--with",
            CREDENTIAL_NAME,
            "--origin-channel",
            "channel-1",
            "--origin-message",
            "message-1",
            "--reason",
            "run the deploy",
            "--",
            probe(),
            "--echo-env",
            "PROBE_TOKEN",
            "--echo-env-stderr",
            "PROBE_TOKEN",
            "--exit",
            "7",
        ],
        &[PASSPHRASE],
    );

    // The child's own exit code reaches the caller unchanged: a harness has to
    // be able to tell what the command did.
    assert_eq!(output.status.code(), Some(7));
    let stdout = text(&output.stdout);
    let stderr = text(&output.stderr);
    // The child did receive the value — it printed the variable, not "<unset>".
    assert!(
        stdout.contains("PROBE_TOKEN="),
        "the child did not see the variable: {stdout}"
    );
    assert!(
        !stdout.contains("<unset>"),
        "the credential never reached the child"
    );
    // And it was redacted on the way out, on both streams.
    assert_absent(&stdout, CANARY, "the child's stdout");
    assert_absent(&stderr, CANARY, "the child's stderr");
    assert!(stdout.contains("[redacted:PROBE_TOKEN]"));
    assert!(stderr.contains("[redacted:PROBE_TOKEN]"));
    assert!(stderr.contains("it tried to print a credential"));
}

/// VAULT-CLI-INT-007 — a value printed across two writes is still redacted.
#[test]
fn vault_cli_int_007_scrubbing_survives_a_split_write() {
    let double = Double::start();
    let home = TempHome::create("run-split");
    assert!(login(&home, &double).status.success());
    let vault_public_key = double
        .with_state(|state| state.vault_public_key.clone())
        .expect("a published key");
    double.with_state(|state| {
        state.credentials = vec![credential_metadata()];
        state.release = allow_release(&vault_public_key);
    });

    let output = cli(
        &home,
        &[
            "run",
            "--with",
            CREDENTIAL_NAME,
            "--origin-channel",
            "channel-1",
            "--origin-message",
            "message-1",
            "--reason",
            "run the deploy",
            "--",
            probe(),
            "--split-env",
            "PROBE_TOKEN",
        ],
        &[PASSPHRASE],
    );
    assert!(output.status.success());
    assert_absent(&text(&output.stdout), CANARY, "the child's split output");
}

/// VAULT-CLI-INT-008 — a file delivery is owner-only while the command runs and
/// gone afterwards.
#[test]
fn vault_cli_int_008_a_file_delivery_is_written_owner_only_and_removed() {
    let double = Double::start();
    let home = TempHome::create("run-file");
    assert!(login(&home, &double).status.success());
    let vault_public_key = double
        .with_state(|state| state.vault_public_key.clone())
        .expect("a published key");
    double.with_state(|state| {
        state.credentials = vec![credential_metadata()];
        state.release = allow_release(&vault_public_key);
    });

    let key_path: PathBuf = home.path.join("materialised").join("token");
    let spec = format!("{CREDENTIAL_NAME}:{}", key_path.display());
    let output = cli(
        &home,
        &[
            "run",
            "--with-file",
            &spec,
            "--origin-channel",
            "channel-1",
            "--origin-message",
            "message-1",
            "--reason",
            "run the deploy",
            "--scrub",
            "never",
            "--",
            probe(),
            "--cat",
            &key_path.display().to_string(),
        ],
        &[PASSPHRASE],
    );
    assert!(
        output.status.success(),
        "run failed: {}",
        text(&output.stderr)
    );
    // Scrubbing is off here precisely so the file's content is observable: the
    // point of the scenario is that the child could read it.
    assert!(
        text(&output.stdout).contains(CANARY),
        "the child could not read the materialised file"
    );
    assert!(
        !key_path.exists(),
        "the materialised credential outlived the command"
    );

    // The environment variable pointed at the path rather than holding the value.
    let output = cli(
        &home,
        &[
            "run",
            "--with-file",
            &spec,
            "--origin-channel",
            "channel-1",
            "--origin-message",
            "message-1",
            "--reason",
            "run the deploy",
            "--scrub",
            "never",
            "--",
            probe(),
            "--echo-env",
            "PROBE_TOKEN",
        ],
        &[PASSPHRASE],
    );
    let shown = text(&output.stdout);
    assert!(
        shown.contains(&key_path.display().to_string()),
        "the variable did not name the file: {shown}"
    );
    assert_absent(&shown, CANARY, "the file-delivery environment");
}

/// VAULT-CLI-INT-009 — the injected file is owner-only while it exists.
#[test]
fn vault_cli_int_009_a_file_delivery_is_owner_only_while_it_exists() {
    let double = Double::start();
    let home = TempHome::create("run-file-mode");
    assert!(login(&home, &double).status.success());
    let vault_public_key = double
        .with_state(|state| state.vault_public_key.clone())
        .expect("a published key");
    double.with_state(|state| {
        state.credentials = vec![credential_metadata()];
        state.release = allow_release(&vault_public_key);
    });

    let key_path = home.path.join("mode-check");
    let spec = format!("{CREDENTIAL_NAME}:{}", key_path.display());
    // The child reports the mode from inside the command's own lifetime, so
    // nothing here has to race the unlink to observe it.
    let output = cli(
        &home,
        &[
            "run",
            "--with-file",
            &spec,
            "--origin-channel",
            "channel-1",
            "--origin-message",
            "message-1",
            "--reason",
            "run the deploy",
            "--scrub",
            "never",
            "--",
            probe(),
            "--mode",
            &key_path.display().to_string(),
        ],
        &[PASSPHRASE],
    );
    assert!(
        output.status.success(),
        "run failed: {}",
        text(&output.stderr)
    );
    let shown = text(&output.stdout);
    if cfg!(unix) {
        assert!(
            shown.contains("mode=600"),
            "the credential file was not owner-only: {shown}"
        );
    } else {
        // Windows has no mode bits, so the probe cannot report one — the real
        // question is the file's access-control list, asked below.
        assert!(
            shown.contains("mode=unsupported"),
            "the credential file was missing: {shown}"
        );
    }
    assert!(
        !key_path.exists(),
        "the materialised credential outlived the command"
    );
}

/// VAULT-CLI-INT-021 — the delivered file's real permissions, on this platform.
///
/// Until R04 the Windows half of this claim only asserted that the file
/// existed. A credential file inherits its directory's access by default, which
/// is usually a per-user profile directory and usually fine — but "usually" is
/// not something to rest a private key on. So the delivery strips inheritance
/// and grants exactly one principal, and this reads that back with `icacls`.
#[test]
fn vault_cli_int_021_a_file_delivery_is_owner_only_on_this_platform() {
    let double = Double::start();
    let home = TempHome::create("run-file-acl");
    assert!(login(&home, &double).status.success());
    let vault_public_key = double
        .with_state(|state| state.vault_public_key.clone())
        .expect("a published key");
    double.with_state(|state| {
        state.credentials = vec![credential_metadata()];
        state.release = allow_release(&vault_public_key);
    });

    let key_path = home.path.join("acl-check");
    let spec = format!("{CREDENTIAL_NAME}:{}", key_path.display());
    // The child holds the file open long enough for this process to inspect it,
    // because the permissions only matter while the credential is on disk.
    let output = cli(
        &home,
        &[
            "run",
            "--with-file",
            &spec,
            "--origin-channel",
            "channel-1",
            "--origin-message",
            "message-1",
            "--reason",
            "run the deploy",
            "--scrub",
            "never",
            "--",
            probe(),
            "--assert-owner-only",
            &key_path.display().to_string(),
        ],
        &[PASSPHRASE],
    );
    assert!(
        output.status.success(),
        "run failed: {}",
        text(&output.stderr)
    );
    let shown = text(&output.stdout);
    assert!(
        shown.contains("owner-only=yes"),
        "the delivered credential was readable by somebody else: {shown}"
    );
    assert_absent(&shown, CANARY, "the permission report");
}

/// VAULT-CLI-INT-010 — a refusal stops before the spawn and says so in the exit
/// code.
#[test]
fn vault_cli_int_010_a_denied_release_never_runs_the_command() {
    let double = Double::start();
    let home = TempHome::create("run-deny");
    assert!(login(&home, &double).status.success());
    double.with_state(|state| {
        state.credentials = vec![credential_metadata()];
        state.release = deny_release(
            "project_refused",
            "PROBE_TOKEN is not available to this project. Stop and tell the user.",
        );
    });

    let output = cli(
        &home,
        &[
            "run",
            "--with",
            CREDENTIAL_NAME,
            "--origin-channel",
            "channel-1",
            "--origin-message",
            "message-1",
            "--reason",
            "run the deploy",
            "--",
            probe(),
            "--print",
            "THE-COMMAND-RAN",
        ],
        &[PASSPHRASE],
    );
    assert_eq!(output.status.code(), Some(77));
    assert_absent(&text(&output.stdout), "THE-COMMAND-RAN", "a denied run");
    // The workspace's own wording reaches the agent verbatim.
    assert!(text(&output.stderr).contains("not available to this project"));
}

/// VAULT-CLI-INT-011 — waiting on a human is not a denial, and has its own code.
#[test]
fn vault_cli_int_011_a_pending_approval_is_distinguishable_from_a_refusal() {
    let double = Double::start();
    let home = TempHome::create("run-approval");
    assert!(login(&home, &double).status.success());
    double.with_state(|state| {
        state.credentials = vec![credential_metadata()];
        state.release = pending_release("approval-0001", 1_800_000_300_000);
    });

    let output = cli(
        &home,
        &[
            "run",
            "--with",
            CREDENTIAL_NAME,
            "--origin-channel",
            "channel-1",
            "--origin-message",
            "message-1",
            "--reason",
            "run the deploy",
            "--",
            probe(),
            "--print",
            "THE-COMMAND-RAN",
        ],
        &[PASSPHRASE],
    );
    assert_eq!(output.status.code(), Some(78));
    assert_absent(
        &text(&output.stdout),
        "THE-COMMAND-RAN",
        "a run awaiting approval",
    );
    let reported = text(&output.stderr);
    // The card's identity and the workspace's own waiting wording both reach
    // the agent, so it knows what is outstanding and that it must not poll.
    assert!(reported.contains("a human has to approve this use"));
    assert!(reported.contains("approval-0001"));
    assert!(reported.contains("do not retry in a loop"));

    // The reason travelled with the request, and there is no way to make one
    // without it: a card with no reason on it is one nobody can answer well.
    let sent = double.with_state(|state| state.bodies("/api/device/vault/release"));
    assert!(String::from_utf8_lossy(&sent[0]).contains("run the deploy"));
    let missing = cli(
        &home,
        &[
            "run",
            "--with",
            CREDENTIAL_NAME,
            "--origin-channel",
            "channel-1",
            "--origin-message",
            "message-1",
            "--",
            probe(),
            "--print",
            "THE-COMMAND-RAN",
        ],
        &[PASSPHRASE],
    );
    assert_eq!(missing.status.code(), Some(2));
    assert!(text(&missing.stderr).contains("--reason is required"));
}

/// VAULT-CLI-INT-016 — one command's credentials are one request, not several.
#[test]
fn vault_cli_int_016_one_command_asks_once_for_everything_it_needs() {
    let double = Double::start();
    let home = TempHome::create("run-batch");
    assert!(login(&home, &double).status.success());
    let vault_public_key = double
        .with_state(|state| state.vault_public_key.clone())
        .expect("a published key");
    double.with_state(|state| {
        state.credentials = vec![credential_metadata(), second_credential_metadata()];
        state.release =
            allow_release_many(&vault_public_key, &[CREDENTIAL_ID, SECOND_CREDENTIAL_ID]);
    });

    let output = cli(
        &home,
        &[
            "run",
            "--with",
            CREDENTIAL_NAME,
            "--with",
            SECOND_CREDENTIAL_NAME,
            "--origin-channel",
            "channel-1",
            "--origin-message",
            "message-1",
            "--reason",
            "run the deploy",
            "--",
            probe(),
            "--echo-env",
            "PROBE_TOKEN",
        ],
        &[PASSPHRASE],
    );
    assert!(
        output.status.success(),
        "run failed: {}",
        text(&output.stderr)
    );

    // One release request naming both credentials, so the workspace can raise a
    // single card rather than one per value.
    let sent = double.with_state(|state| state.bodies("/api/device/vault/release"));
    assert_eq!(sent.len(), 1);
    let body: serde_json::Value = serde_json::from_slice(&sent[0]).expect("a JSON body");
    let asked: Vec<&str> = body["credentialIds"]
        .as_array()
        .expect("ids")
        .iter()
        .map(|id| id.as_str().unwrap())
        .collect();
    assert_eq!(asked, vec![CREDENTIAL_ID, SECOND_CREDENTIAL_ID]);
}

/// VAULT-CLI-INT-012 — an unknown credential is refused locally, without a
/// release request and without a spawn.
#[test]
fn vault_cli_int_012_an_invisible_credential_is_refused_before_any_release() {
    let double = Double::start();
    let home = TempHome::create("run-unknown");
    assert!(login(&home, &double).status.success());
    double.with_state(|state| state.credentials = vec![credential_metadata()]);

    let output = cli(
        &home,
        &[
            "run",
            "--with",
            "NOT_A_CREDENTIAL",
            "--origin-channel",
            "channel-1",
            "--origin-message",
            "message-1",
            "--reason",
            "run the deploy",
            "--",
            probe(),
            "--print",
            "THE-COMMAND-RAN",
        ],
        &[PASSPHRASE],
    );
    assert_eq!(output.status.code(), Some(77));
    assert_absent(
        &text(&output.stdout),
        "THE-COMMAND-RAN",
        "an unknown credential",
    );
    assert_eq!(
        double.with_state(|state| state.bodies("/api/device/vault/release").len()),
        0
    );
}

/// VAULT-CLI-INT-013 — a wrap for another key epoch is refused rather than
/// guessed at.
#[test]
fn vault_cli_int_013_a_stale_key_epoch_fails_closed() {
    let double = Double::start();
    let home = TempHome::create("run-epoch");
    assert!(login(&home, &double).status.success());
    let vault_public_key = double
        .with_state(|state| state.vault_public_key.clone())
        .expect("a published key");
    double.with_state(|state| {
        state.credentials = vec![credential_metadata()];
        let mut release = allow_release(&vault_public_key);
        release["results"][0]["wrap"]["recipientKeyEpoch"] = serde_json::json!(2);
        state.release = release;
    });

    let output = cli(
        &home,
        &[
            "run",
            "--with",
            CREDENTIAL_NAME,
            "--origin-channel",
            "channel-1",
            "--origin-message",
            "message-1",
            "--reason",
            "run the deploy",
            "--",
            probe(),
            "--print",
            "THE-COMMAND-RAN",
        ],
        &[PASSPHRASE],
    );
    assert_eq!(output.status.code(), Some(1));
    assert_absent(
        &text(&output.stdout),
        "THE-COMMAND-RAN",
        "a stale key epoch",
    );
    assert!(text(&output.stderr).contains("vault key epoch"));
}

/// VAULT-CLI-INT-014 — no command surface accepts a credential, and no signed
/// request goes anywhere unencrypted.
#[test]
fn vault_cli_int_014_the_surface_refuses_values_in_argv_and_cleartext_hosts() {
    let home = TempHome::create("surface");

    // There is no flag that takes a value, a password or a passphrase.
    let usage = text(&cli(&home, &["--help"], &[]).stdout);
    for forbidden in ["--value", "--password", "--passphrase", "--secret"] {
        assert_absent(&usage, forbidden, "the usage text");
    }
    assert!(usage.contains("No option anywhere accepts a credential value"));

    // A remote host over plain HTTP is refused before anything is generated.
    let output = cli(
        &home,
        &[
            "login",
            "--server",
            "http://vault.example",
            "--workspace",
            WORKSPACE_SLUG,
        ],
        &["operator@example.test", ACCOUNT_PASSWORD, PASSPHRASE],
    );
    assert_eq!(output.status.code(), Some(2));
    assert!(text(&output.stderr).contains("refusing to send a signed request"));
    assert!(!home.path.join("profile.json").exists());
}

/// VAULT-CLI-INT-015 — a device without a registered vault key can look but not
/// touch.
#[test]
fn vault_cli_int_015_a_device_without_a_vault_key_refuses_to_add() {
    let double = Double::start();
    let home = TempHome::create("no-key");
    double.with_state(|state| state.vault_key_published = false);

    let output = login(&home, &double);
    assert!(output.status.success());
    assert!(text(&output.stdout).contains("cannot open credentials yet"));

    // Listing still works: metadata is not the credential.
    double.with_state(|state| state.credentials = vec![credential_metadata()]);
    assert!(cli(&home, &["list"], &[PASSPHRASE]).status.success());

    // Sealing does not, and it says why rather than uploading something nobody
    // can open.
    let profile = load_profile_at(&home.path.join("profile.json")).expect("the profile");
    assert_eq!(profile.vault_key_epoch, 0);
    let output = cli(
        &home,
        &["add", CREDENTIAL_NAME],
        &[PASSPHRASE, ACCOUNT_PASSWORD, CANARY],
    );
    assert_eq!(output.status.code(), Some(1));
    assert!(text(&output.stderr).contains("no registered vault key"));
    assert_eq!(
        double.with_state(|state| state.bodies("/api/device/vault/credentials").len()),
        0
    );
}

fn recovery_code(stdout: &str) -> String {
    stdout
        .lines()
        .find_map(|line| line.strip_prefix("Recovery code: "))
        .expect("a recovery code in the login output")
        .trim()
        .to_string()
}

/// VAULT-CLI-INT-017 — a captured value reaches the vault without passing
/// through the terminal, an agent's context, or `argv`.
#[test]
fn vault_cli_int_017_capture_stores_output_without_showing_it() {
    let double = Double::start();
    let home = TempHome::create("capture");
    assert!(login(&home, &double).status.success());

    let output = cli(
        &home,
        &[
            "capture",
            "CAPTURED_TOKEN",
            "--description",
            "From a probe",
            "--",
            probe(),
            "--print",
            CANARY,
        ],
        &[PASSPHRASE, ACCOUNT_PASSWORD],
    );
    assert!(
        output.status.success(),
        "capture failed: {}",
        text(&output.stderr)
    );

    // The value is in the vault and in neither of the places it must not be.
    assert_absent(&text(&output.stdout), CANARY, "the capture output");
    assert_absent(&text(&output.stderr), CANARY, "the capture output");
    let sent = double.with_state(|state| state.bodies("/api/device/vault/credentials"));
    assert_eq!(sent.len(), 1);
    let body: serde_json::Value = serde_json::from_slice(&sent[0]).expect("a JSON body");
    assert_absent(
        &String::from_utf8_lossy(&sent[0]),
        CANARY,
        "the create request",
    );

    // What produced it is recorded as a bare program name, never a command line.
    let captured_from = body["capturedFrom"].as_str().expect("a capture source");
    assert!(!captured_from.contains(' '));
    assert!(!captured_from.contains('/'));
    // A captured credential lands on the most restrictive policy there is.
    assert_eq!(body["policy"]["mode"], "ask");
    assert_eq!(
        body["policy"]["allowedDeliveries"],
        serde_json::json!(["inject"])
    );
    assert!(body["policy"]["grantTtlMs"].is_null());
    assert!(text(&output.stdout).contains("switched off until a custodian confirms"));

    // A command that fails stores nothing at all: its output is a diagnostic,
    // not a credential.
    let failed = cli(
        &home,
        &[
            "capture",
            "SECOND_TOKEN",
            "--",
            probe(),
            "--print",
            CANARY,
            "--exit",
            "3",
        ],
        &[PASSPHRASE, ACCOUNT_PASSWORD],
    );
    assert_eq!(failed.status.code(), Some(1));
    assert!(text(&failed.stderr).contains("nothing was stored"));
    assert_eq!(
        double.with_state(|state| state.bodies("/api/device/vault/credentials").len()),
        1
    );
}

/// VAULT-CLI-INT-018 — importing a `.env` creates credentials, reports what it
/// skipped and why, and never removes the file unless asked.
#[test]
fn vault_cli_int_018_import_seeds_the_vault_and_leaves_the_source_alone() {
    let double = Double::start();
    let home = TempHome::create("import");
    assert!(login(&home, &double).status.success());
    let env_path = home.path.join("project.env");
    std::fs::write(
        &env_path,
        format!("# seeds\nFIRST_TOKEN={CANARY}\nexport SECOND_TOKEN=\"quoted value\"\nlower=skipped\nEMPTY=\n"),
    )
    .expect("an env file");

    // A dry run says what would happen and sends nothing.
    let dry = cli(
        &home,
        &["import", &env_path.display().to_string(), "--dry-run"],
        &[],
    );
    assert!(dry.status.success());
    assert!(text(&dry.stdout).contains("would be created"));
    assert_absent(&text(&dry.stdout), CANARY, "the dry run");
    assert_eq!(
        double.with_state(|state| state.bodies("/api/device/vault/credentials").len()),
        0
    );

    let output = cli(
        &home,
        &[
            "import",
            &env_path.display().to_string(),
            "--tag",
            "project",
        ],
        &[PASSPHRASE, ACCOUNT_PASSWORD],
    );
    assert!(
        output.status.success(),
        "import failed: {}",
        text(&output.stderr)
    );
    assert!(text(&output.stdout).contains("Created 2 of 2"));
    // Every skip says which line and why, so a big file is fixable.
    let reported = text(&output.stderr);
    assert!(reported.contains("line 4"));
    assert!(reported.contains("not usable as an environment variable"));
    assert!(reported.contains("line 5"));
    assert!(reported.contains("no value"));
    // No value is ever printed, in any of it.
    assert_absent(&text(&output.stdout), CANARY, "the import summary");
    assert_absent(&reported, CANARY, "the import summary");

    let sent = double.with_state(|state| state.bodies("/api/device/vault/credentials"));
    assert_eq!(sent.len(), 2);
    for body in &sent {
        assert_absent(&String::from_utf8_lossy(body), CANARY, "an import request");
        let parsed: serde_json::Value = serde_json::from_slice(body).expect("a JSON body");
        assert_eq!(parsed["metadata"]["tags"], serde_json::json!(["project"]));
        assert_eq!(parsed["policy"]["mode"], "ask");
    }

    // The source file is still there, because nobody asked for it to go.
    assert!(env_path.exists());
    assert!(text(&output.stdout).contains("was left where it is"));

    let shredded = cli(
        &home,
        &["import", &env_path.display().to_string(), "--shred"],
        &[PASSPHRASE, ACCOUNT_PASSWORD],
    );
    assert!(shredded.status.success());
    assert!(!env_path.exists(), "--shred left the source file behind");
    // And it says what shredding is and is not.
    assert!(text(&shredded.stdout).contains("not shredding"));
}

/// VAULT-CLI-INT-019 — a template and a tagged group are one request, and the
/// rendered file lives exactly as long as the command.
#[test]
fn vault_cli_int_019_templates_and_tags_are_one_request() {
    let double = Double::start();
    let home = TempHome::create("template");
    assert!(login(&home, &double).status.success());
    let vault_public_key = double
        .with_state(|state| state.vault_public_key.clone())
        .expect("a published key");
    double.with_state(|state| {
        state.credentials = vec![
            tagged_credential_metadata(CREDENTIAL_ID, CREDENTIAL_NAME, "aws"),
            tagged_credential_metadata(SECOND_CREDENTIAL_ID, SECOND_CREDENTIAL_NAME, "aws"),
        ];
        state.release =
            allow_release_many(&vault_public_key, &[CREDENTIAL_ID, SECOND_CREDENTIAL_ID]);
    });

    // A whole tagged group under one request, so four credentials for one
    // command do not become four cards.
    let tagged = cli(
        &home,
        &[
            "run",
            "--all-tagged",
            "aws",
            "--origin-channel",
            "channel-1",
            "--origin-message",
            "message-1",
            "--reason",
            "run the deploy",
            "--",
            probe(),
            "--echo-env",
            CREDENTIAL_NAME,
        ],
        &[PASSPHRASE],
    );
    assert!(
        tagged.status.success(),
        "tagged run failed: {}",
        text(&tagged.stderr)
    );
    let asked: serde_json::Value = serde_json::from_slice(
        &double.with_state(|state| state.bodies("/api/device/vault/release"))[0],
    )
    .expect("a JSON body");
    assert_eq!(asked["credentialIds"].as_array().expect("ids").len(), 2);

    // A template resolves its own placeholders and nothing else.
    let source = home.path.join("config.template");
    let rendered = home.path.join("config.rendered");
    std::fs::write(&source, "token=${lepidy:PROBE_TOKEN}\nhome=${HOME}\n").expect("a template");
    let output = cli(
        &home,
        &[
            "run",
            "--with-template",
            &format!("{}={}", source.display(), rendered.display()),
            "--origin-channel",
            "channel-1",
            "--origin-message",
            "message-1",
            "--reason",
            "render the config",
            "--scrub",
            "never",
            "--",
            probe(),
            "--cat",
            &rendered.display().to_string(),
        ],
        &[PASSPHRASE],
    );
    assert!(
        output.status.success(),
        "template run failed: {}",
        text(&output.stderr)
    );
    let shown = text(&output.stdout);
    assert!(
        shown.contains(&format!("token={CANARY}")),
        "the template was not resolved: {shown}"
    );
    // Everything that is not a Lepidy placeholder is left exactly as it was.
    assert!(shown.contains("home=${HOME}"));
    // And the rendered credential does not outlive the command.
    assert!(
        !rendered.exists(),
        "the rendered template outlived the command"
    );
}

/// VAULT-CLI-INT-020 — a structured credential arrives as one variable per
/// field rather than as a blob every tool would have to parse.
#[test]
fn vault_cli_int_020_a_structured_credential_expands_into_its_fields() {
    let double = Double::start();
    let home = TempHome::create("structured");
    assert!(login(&home, &double).status.success());
    let vault_public_key = double
        .with_state(|state| state.vault_public_key.clone())
        .expect("a published key");
    double.with_state(|state| {
        state.credentials = vec![structured_credential_metadata()];
        state.release = allow_release_value(
            &vault_public_key,
            CREDENTIAL_ID,
            &serde_json::json!({ "HOST": "db.example.test", "PASSWORD": CANARY }).to_string(),
        );
    });

    let output = cli(
        &home,
        &[
            "run",
            "--with",
            CREDENTIAL_NAME,
            "--origin-channel",
            "channel-1",
            "--origin-message",
            "message-1",
            "--reason",
            "connect to the database",
            "--",
            probe(),
            "--echo-env",
            "PROBE_TOKEN_HOST",
            "--echo-env",
            "PROBE_TOKEN_PASSWORD",
            "--echo-env",
            "PROBE_TOKEN",
        ],
        &[PASSPHRASE],
    );
    assert!(
        output.status.success(),
        "structured run failed: {}",
        text(&output.stderr)
    );
    let shown = text(&output.stdout);
    // One variable per field, and no undivided blob for a tool to have to
    // parse. Every field is part of the credential, so every one of them is
    // redacted on the way out — the marker naming each variable is what proves
    // there was a value there to redact.
    assert!(
        shown.contains("PROBE_TOKEN_HOST=[redacted:PROBE_TOKEN_HOST]"),
        "{shown}"
    );
    assert!(
        shown.contains("PROBE_TOKEN_PASSWORD=[redacted:PROBE_TOKEN_PASSWORD]"),
        "{shown}"
    );
    assert!(shown.contains("PROBE_TOKEN=<unset>"), "{shown}");
    assert_absent(&shown, CANARY, "a structured credential's output");

    // With scrubbing off, the fields are visibly the values they should be.
    let unscrubbed = cli(
        &home,
        &[
            "run",
            "--with",
            CREDENTIAL_NAME,
            "--origin-channel",
            "channel-1",
            "--origin-message",
            "message-1",
            "--reason",
            "connect to the database",
            "--scrub",
            "never",
            "--",
            probe(),
            "--echo-env",
            "PROBE_TOKEN_HOST",
        ],
        &[PASSPHRASE],
    );
    assert!(text(&unscrubbed.stdout).contains("PROBE_TOKEN_HOST=db.example.test"));
}
