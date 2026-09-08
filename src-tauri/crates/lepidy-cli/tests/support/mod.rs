//! A disposable local Lepidy for the CLI to talk to.
//!
//! The double is a real HTTP server on a real loopback socket, and it verifies
//! the signed-device envelope the way the control plane does — canonical string,
//! P-256 signature, body hash. That is the point of it: a test that accepted any
//! request would prove the CLI runs, not that it signs.
//!
//! It is deliberately not a mock of the workspace's decisions. Each scenario
//! sets the decision it wants to test and the double returns exactly that, so
//! the CLI's behaviour on allow, deny and needs-approval is what is under test
//! rather than a re-implementation of policy that already has its own suite.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use p256::ecdsa::signature::Verifier;
use p256::ecdsa::{Signature, VerifyingKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const WORKSPACE_ID: &str = "ws-test";
pub const WORKSPACE_SLUG: &str = "test-workspace";
pub const MEMBER_ID: &str = "member-test";
pub const DEVICE_ID: &str = "device-test";
pub const DEVICE_CREDENTIAL: &str = "device-credential-token-0001";
pub const CREDENTIAL_ID: &str = "cred-test-0001";
pub const CREDENTIAL_NAME: &str = "PROBE_TOKEN";
pub const SECOND_CREDENTIAL_ID: &str = "cred-test-0002";
pub const SECOND_CREDENTIAL_NAME: &str = "PROBE_SECOND";
/// Recognisable enough to spot in any output, worthless everywhere.
pub const CANARY: &str = "lepidy-synthetic-canary-4f2a91c7";
pub const PASSPHRASE: &str = "correct horse battery staple";
pub const ACCOUNT_PASSWORD: &str = "account-password-0001";

#[derive(Clone, Debug)]
pub struct Recorded {
    pub path: String,
    pub body: Vec<u8>,
    pub headers: HashMap<String, String>,
    pub signature_verified: bool,
}

#[derive(Default)]
pub struct State {
    pub requests: Vec<Recorded>,
    pub signing_key: Option<VerifyingKey>,
    pub vault_public_key: Option<Vec<u8>>,
    pub credentials: Vec<Value>,
    pub release: Value,
    pub enrol_status: u16,
    pub vault_key_published: bool,
}

impl State {
    pub fn bodies(&self, path: &str) -> Vec<Vec<u8>> {
        self.requests
            .iter()
            .filter(|request| request.path == path)
            .map(|request| request.body.clone())
            .collect()
    }
}

pub struct Double {
    address: SocketAddr,
    pub state: Arc<Mutex<State>>,
    running: Arc<AtomicBool>,
}

impl Double {
    pub fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let address = listener.local_addr().expect("a bound address");
        let state = Arc::new(Mutex::new(State {
            release: deny_release("credential_inactive", "That credential is not available."),
            enrol_status: 200,
            vault_key_published: true,
            ..State::default()
        }));
        let running = Arc::new(AtomicBool::new(true));
        let thread_state = Arc::clone(&state);
        let thread_running = Arc::clone(&running);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                if !thread_running.load(Ordering::SeqCst) {
                    break;
                }
                match stream {
                    Ok(stream) => serve(stream, &thread_state),
                    Err(_) => break,
                }
            }
        });
        Self {
            address,
            state,
            running,
        }
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.address.port())
    }

    pub fn with_state<T>(&self, edit: impl FnOnce(&mut State) -> T) -> T {
        edit(&mut self.state.lock().expect("the double's state"))
    }
}

impl Drop for Double {
    fn drop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        // Unblock the accept loop so the thread ends with the test.
        let _ = TcpStream::connect(self.address);
    }
}

fn serve(mut stream: TcpStream, state: &Arc<Mutex<State>>) {
    let Some((path, headers, body)) = read_request(&mut stream) else {
        return;
    };
    let signature_verified = verify_envelope(state, &path, &headers, &body);
    let response = {
        let mut locked = state.lock().expect("the double's state");
        locked.requests.push(Recorded {
            path: path.clone(),
            body: body.clone(),
            headers: headers.clone(),
            signature_verified,
        });
        respond(&mut locked, &path, &body, signature_verified)
    };
    let (status, payload) = response;
    let body = payload.to_string();
    let _ = write!(
        stream,
        "HTTP/1.1 {status} OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.flush();
}

fn read_request(stream: &mut TcpStream) -> Option<(String, HashMap<String, String>, Vec<u8>)> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line).ok()?;
    let path = request_line.split_whitespace().nth(1)?.to_string();

    let mut headers = HashMap::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).ok()? == 0 {
            break;
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let length: usize = headers
        .get("content-length")
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).ok()?;
    Some((path, headers, body))
}

/// The control plane's check, in miniature: rebuild the canonical string from
/// the claims, verify the signature over it, and confirm the body hash.
fn verify_envelope(
    state: &Arc<Mutex<State>>,
    path: &str,
    headers: &HashMap<String, String>,
    body: &[u8],
) -> bool {
    let Some(key) = state.lock().expect("the double's state").signing_key else {
        return false;
    };
    let (Some(encoded_claims), Some(encoded_signature), Some(credential)) = (
        headers.get("x-lepidy-device-claims"),
        headers.get("x-lepidy-device-signature"),
        headers.get("x-lepidy-device-credential"),
    ) else {
        return false;
    };
    if credential != DEVICE_CREDENTIAL {
        return false;
    }
    let (Ok(claims_bytes), Ok(signature_bytes)) = (
        URL_SAFE_NO_PAD.decode(encoded_claims),
        URL_SAFE_NO_PAD.decode(encoded_signature),
    ) else {
        return false;
    };
    let Ok(claims) = serde_json::from_slice::<Value>(&claims_bytes) else {
        return false;
    };
    let text = |name: &str| {
        claims
            .get(name)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let number = |name: &str| {
        claims
            .get(name)
            .and_then(Value::as_i64)
            .unwrap_or(0)
            .to_string()
    };
    if text("path") != path {
        return false;
    }
    if text("bodyHash") != URL_SAFE_NO_PAD.encode(Sha256::digest(body)) {
        return false;
    }
    let canonical = [
        "lepidy-device-request-v1".to_string(),
        text("method").to_uppercase(),
        text("path"),
        text("bodyHash"),
        text("workspaceId"),
        text("memberId"),
        number("authorizationEpoch"),
        text("deviceId"),
        number("deviceKeyEpoch"),
        number("timestamp"),
        text("nonce"),
        text("requestId"),
        text("projectId"),
        number("configRevision"),
        text("agentId"),
        text("delegationId"),
        text("originId"),
    ]
    .join("\n");
    let Ok(signature) = Signature::from_slice(&signature_bytes) else {
        return false;
    };
    key.verify(canonical.as_bytes(), &signature).is_ok()
}

fn respond(state: &mut State, path: &str, body: &[u8], signature_verified: bool) -> (u16, Value) {
    if path == "/api/device/enroll" {
        let parsed: Value = serde_json::from_slice(body).unwrap_or(json!({}));
        if let Some(jwk) = parsed.get("signingPublicKey") {
            state.signing_key = verifying_key_from_jwk(jwk);
        }
        if let Some(key) = parsed.get("vaultPublicKey").and_then(Value::as_str) {
            state.vault_public_key = URL_SAFE_NO_PAD.decode(key).ok();
        }
        if state.enrol_status != 200 {
            return (
                state.enrol_status,
                json!({ "error": "enrolment_refused", "message": "those sign-in details were refused" }),
            );
        }
        return (
            200,
            json!({
                "deviceId": DEVICE_ID,
                "deviceCredential": DEVICE_CREDENTIAL,
                "deviceKeyEpoch": 1,
                "workspaceId": WORKSPACE_ID,
                "workspaceSlug": WORKSPACE_SLUG,
                "memberId": MEMBER_ID,
                "authorizationEpoch": 1,
                "wrapSuite": "P256-HKDF-SHA256-AES256GCM",
                "vaultKey": if state.vault_key_published {
                    json!({ "keyEpoch": 1, "published": true })
                } else {
                    json!({ "keyEpoch": 1, "published": false, "reason": "another client already registered a vault key for this member" })
                },
            }),
        );
    }

    if !signature_verified {
        return (
            401,
            json!({ "error": "device_unauthorized", "message": "the signature was refused" }),
        );
    }
    match path {
        "/api/device/vault/list" => (
            200,
            json!({ "workspaceId": WORKSPACE_ID, "credentials": state.credentials }),
        ),
        "/api/device/vault/credentials" => (
            200,
            json!({ "credential": { "id": CREDENTIAL_ID, "name": CREDENTIAL_NAME }, "created": true }),
        ),
        "/api/device/vault/release" => (200, state.release.clone()),
        _ => (
            404,
            json!({ "error": "unknown", "message": "no such endpoint" }),
        ),
    }
}

fn verifying_key_from_jwk(jwk: &Value) -> Option<VerifyingKey> {
    let x = URL_SAFE_NO_PAD.decode(jwk.get("x")?.as_str()?).ok()?;
    let y = URL_SAFE_NO_PAD.decode(jwk.get("y")?.as_str()?).ok()?;
    let mut sec1 = vec![0x04];
    sec1.extend_from_slice(&x);
    sec1.extend_from_slice(&y);
    VerifyingKey::from_sec1_bytes(&sec1).ok()
}

/// One scenario's private profile directory, removed when the test ends —
/// including on the failure path, because a leftover keystore is exactly the
/// kind of thing that makes the next run pass for the wrong reason.
pub struct TempHome {
    pub path: PathBuf,
}

static HOMES: AtomicUsize = AtomicUsize::new(0);

impl TempHome {
    pub fn create(label: &str) -> Self {
        let ordinal = HOMES.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!(
            "lepidy-cli-{}-{label}-{ordinal}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("a scenario home");
        Self { path }
    }

    pub fn profile_json(&self) -> Value {
        serde_json::from_str(
            &std::fs::read_to_string(self.path.join("profile.json")).expect("a profile"),
        )
        .expect("a profile document")
    }

    pub fn profile_text(&self) -> String {
        std::fs::read_to_string(self.path.join("profile.json")).expect("a profile")
    }
}

impl Drop for TempHome {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

pub fn cli(home: &TempHome, arguments: &[&str], stdin: &[&str]) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_lepidy"))
        .args(arguments)
        .env("LEPIDY_HOME", &home.path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the lepidy binary");
    {
        let mut handle = child.stdin.take().expect("stdin was piped");
        for line in stdin {
            if let Err(error) = writeln!(handle, "{line}") {
                // A command that rejects its arguments before reading standard
                // input may close the pipe immediately. That early refusal is
                // the behavior the caller is about to assert, not a harness
                // failure caused by whether the scheduler let this write race
                // the process exit.
                if error.kind() == std::io::ErrorKind::BrokenPipe {
                    break;
                }
                panic!("write to the CLI: {error}");
            }
        }
    }
    child.wait_with_output().expect("the CLI to finish")
}

pub fn login(home: &TempHome, double: &Double) -> Output {
    cli(
        home,
        &[
            "login",
            "--server",
            &double.url(),
            "--workspace",
            WORKSPACE_SLUG,
            "--label",
            "test-client",
        ],
        &["operator@example.test", ACCOUNT_PASSWORD, PASSPHRASE],
    )
}

pub fn probe() -> &'static str {
    env!("CARGO_BIN_EXE_lepidy-injection-probe")
}

pub fn text(output: &[u8]) -> String {
    String::from_utf8_lossy(output).to_string()
}

pub fn credential_metadata() -> Value {
    json!({
        "id": CREDENTIAL_ID,
        "name": CREDENTIAL_NAME,
        "description": "A synthetic canary for the CLI suite",
        "envVar": "PROBE_TOKEN",
        "tags": [],
        "commands": [],
        "proxyHosts": [],
        "policy": { "mode": "auto", "allowedDeliveries": ["inject", "file"], "projectIds": [], "highRisk": false },
        "version": 1,
        "keyEpoch": 1,
        "policyEpoch": 1,
        "createdAt": 0,
        "updatedAt": 0,
        "accessCount": 0,
    })
}

pub fn second_credential_metadata() -> Value {
    let mut metadata = credential_metadata();
    metadata["id"] = json!(SECOND_CREDENTIAL_ID);
    metadata["name"] = json!(SECOND_CREDENTIAL_NAME);
    metadata["envVar"] = json!(SECOND_CREDENTIAL_NAME);
    metadata
}

/// Seal the canary the way a custodian client would, so `run` has something
/// real to open. Uses the CLI's own crypto, which is the code under test on the
/// other side of the wire.
/// A refusal in the batch shape the endpoint answers in.
pub fn deny_release(reason: &str, hint: &str) -> Value {
    json!({
        "workspaceId": WORKSPACE_ID,
        "results": [{ "credentialId": CREDENTIAL_ID, "decision": { "kind": "deny", "reason": reason }, "hint": hint }],
        "approvals": [],
    })
}

/// A card was raised: nothing is released, and the CLI is told what to wait for.
pub fn pending_release(approval_id: &str, expires_at: u64) -> Value {
    json!({
        "workspaceId": WORKSPACE_ID,
        "results": [{ "credentialId": CREDENTIAL_ID, "decision": { "kind": "needs_approval" } }],
        "approvals": [{
            "approvalId": approval_id,
            "expiresAt": expires_at,
            "credentialIds": [CREDENTIAL_ID],
            "credentialNames": [CREDENTIAL_NAME],
            "approverMemberIds": [MEMBER_ID],
            "hint": "PROBE_TOKEN needs a human to approve this use. Stop and wait to be asked again; do not retry in a loop.",
        }],
    })
}

pub fn allow_release(vault_public_key: &[u8]) -> Value {
    allow_release_many(vault_public_key, &[CREDENTIAL_ID])
}

/// A release carrying a specific value, for the scenarios where what is inside
/// the envelope is the thing under test.
pub fn allow_release_value(vault_public_key: &[u8], credential_id: &str, value: &str) -> Value {
    let mut release = allow_release_many(vault_public_key, &[credential_id]);
    let sealed = seal_for(vault_public_key, credential_id, value);
    release["results"][0]["envelope"] = sealed.0;
    release["results"][0]["wrap"] = sealed.1;
    release
}

fn seal_for(vault_public_key: &[u8], credential_id: &str, value: &str) -> (Value, Value) {
    use lepidy_cli::crypto::{
        aes_gcm_encrypt, credential_aad, encode, random_bytes, wrap_aad, wrap_dek, DEK_BYTES,
        IV_BYTES,
    };
    let dek = random_bytes(DEK_BYTES);
    let iv = random_bytes(IV_BYTES);
    let ciphertext = aes_gcm_encrypt(
        &dek,
        &iv,
        &credential_aad(WORKSPACE_ID, credential_id, 1),
        value.as_bytes(),
    )
    .expect("a sealed value");
    let wrap = wrap_dek(
        vault_public_key,
        &dek,
        &wrap_aad(WORKSPACE_ID, credential_id, 1, MEMBER_ID, 1),
    )
    .expect("a sealed DEK");
    (
        json!({
            "cipherSuite": "AES-256-GCM", "aadVersion": 1, "version": 1, "keyEpoch": 1,
            "iv": encode(&iv), "ciphertext": encode(&ciphertext),
        }),
        json!({
            "custodianMemberId": MEMBER_ID, "recipientKeyEpoch": 1, "wrapSuite": "P256-HKDF-SHA256-AES256GCM",
            "ephemeralPublicKey": encode(&wrap.ephemeral_public_key), "iv": encode(&wrap.iv),
            "wrappedDek": encode(&wrap.wrapped_dek),
        }),
    )
}

/// Credential metadata that expands into one variable per field.
pub fn structured_credential_metadata() -> Value {
    let mut metadata = credential_metadata();
    metadata["kind"] = json!("structured");
    metadata["fields"] = json!(["HOST", "PASSWORD"]);
    metadata
}

/// Credential metadata carrying a tag, for the tagged-group scenarios.
pub fn tagged_credential_metadata(id: &str, name: &str, tag: &str) -> Value {
    let mut metadata = credential_metadata();
    metadata["id"] = json!(id);
    metadata["name"] = json!(name);
    metadata["envVar"] = json!(name);
    metadata["tags"] = json!([tag]);
    metadata
}

/// Seal the canary the way a custodian client would, once per credential, so
/// `run` has something real to open. Uses the CLI's own crypto, which is the
/// code under test on the other side of the wire.
pub fn allow_release_many(vault_public_key: &[u8], credential_ids: &[&str]) -> Value {
    use lepidy_cli::crypto::{
        aes_gcm_encrypt, credential_aad, encode, random_bytes, wrap_aad, wrap_dek, DEK_BYTES,
        IV_BYTES,
    };
    let results: Vec<Value> = credential_ids
        .iter()
        .map(|credential_id| {
            let dek = random_bytes(DEK_BYTES);
            let iv = random_bytes(IV_BYTES);
            let ciphertext = aes_gcm_encrypt(
                &dek,
                &iv,
                &credential_aad(WORKSPACE_ID, credential_id, 1),
                CANARY.as_bytes(),
            )
            .expect("a sealed canary");
            let wrap = wrap_dek(
                vault_public_key,
                &dek,
                &wrap_aad(WORKSPACE_ID, credential_id, 1, MEMBER_ID, 1),
            )
            .expect("a sealed DEK");
            json!({
                "credentialId": credential_id,
                "decision": { "kind": "allow", "via": "automatic" },
                "envelope": {
                    "cipherSuite": "AES-256-GCM",
                    "aadVersion": 1,
                    "version": 1,
                    "keyEpoch": 1,
                    "iv": encode(&iv),
                    "ciphertext": encode(&ciphertext),
                },
                "wrap": {
                    "custodianMemberId": MEMBER_ID,
                    "recipientKeyEpoch": 1,
                    "wrapSuite": "P256-HKDF-SHA256-AES256GCM",
                    "ephemeralPublicKey": encode(&wrap.ephemeral_public_key),
                    "iv": encode(&wrap.iv),
                    "wrappedDek": encode(&wrap.wrapped_dek),
                },
            })
        })
        .collect();
    json!({ "workspaceId": WORKSPACE_ID, "approvals": [], "results": results })
}

pub fn assert_absent(haystack: &str, needle: &str, what: &str) {
    assert!(!haystack.contains(needle), "{what} contained {needle}");
}
