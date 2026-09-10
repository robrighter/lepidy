//! A disposable local Lepidy for `lepidy-agentd` to talk to.
//!
//! Real loopback sockets, a real WebSocket handshake, and the signed-device
//! envelope verified the way the control plane verifies it — canonical string,
//! P-256 signature, body hash, path. A double that accepted any request would
//! prove the daemon runs, not that it signs; and a double that faked the socket
//! would prove the frames parse, not that they arrive.
//!
//! The daemon under test is the compiled binary, spawned as a real process,
//! because everything R01 claims is about process boundaries: what reaches a
//! child's environment, what happens to a tree when it is stopped, and what a
//! machine does when the connection it was holding goes away.

#![allow(dead_code)]

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use lepidy_cli::crypto::{encode, DeviceSigningKey, VaultKeyPair};
use lepidy_cli::profile::{fresh_secrets, seal, Profile, PROFILE_VERSION};
use p256::ecdsa::signature::Verifier;
use p256::ecdsa::{Signature, VerifyingKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const WORKSPACE_ID: &str = "ws-runner";
pub const WORKSPACE_SLUG: &str = "runner-workspace";
pub const MEMBER_ID: &str = "member-runner";
pub const DEVICE_ID: &str = "device-runner";
pub const DEVICE_CREDENTIAL: &str = "device-credential-runner-0001";
pub const PASSPHRASE: &str = "correct horse battery staple";
pub const AGENT_ID: &str = "agent-runner-0001";
pub const SESSION_ID: &str = "session-runner-0001";
/// Shaped like a real one, so the double can refuse anything that is not.
pub const SESSION_TOKEN: &str = "lpd_st_runner-workspace_0123456789abcdef0123456789abcdef";

#[derive(Clone, Debug)]
pub struct Recorded {
    pub path: String,
    pub body: Vec<u8>,
    pub signature_verified: bool,
    pub config_revision: u64,
    pub runner_epoch: u64,
}

#[derive(Default)]
pub struct DoubleState {
    pub requests: Vec<Recorded>,
    pub signing_key: Option<VerifyingKey>,
    /// One socket-authentication scenario needs the preceding registration to
    /// succeed under a deliberately different key so the failure is observed
    /// at the upgrade boundary it is testing.
    pub accept_unsigned_registration: bool,
    /// What a depth check answers with. A scenario sets exactly the queue it
    /// wants to test rather than the double modelling one.
    pub depth: Vec<Value>,
    /// Frames to push down the next socket, in order. A scenario can add to
    /// this after the socket is live, which is how a stop that arrives *while*
    /// a run is going is tested rather than a stop that races the start.
    pub outbound: Vec<String>,
    pub sockets_accepted: usize,
    pub socket_rejected_reason: Option<String>,
    /* -- the harness workflow (R02) ---------------------------------- */
    /// Queue items waiting to be claimed, oldest first.
    pub queue: Vec<String>,
    /// Items a harness has claimed and not yet completed.
    pub claimed: Vec<String>,
    pub completed: Vec<String>,
    /// What was posted, so a scenario can check the agent actually answered.
    pub posts: Vec<String>,
    /// Every MCP tool called, in order.
    pub tool_calls: Vec<String>,
    /// How many sessions have been minted. Reuse means this stays at one.
    pub sessions_minted: usize,
    /// Every run outcome reported, as (outcome, session id).
    pub outcomes: Vec<(String, String)>,
    /// Bearer tokens seen on MCP calls, so a scenario can prove one session
    /// served many runs rather than several that merely look alike.
    pub bearers: Vec<String>,
    /// Content the workspace refuses to post. Set by the scenario rather than
    /// modelled here: this double implements the transport, and the rule that
    /// decides a canary has its own suite against a real Durable Object.
    pub refuse_post_containing: Option<String>,
    /// What `list_credentials` answers with, so a scenario can prove a listing
    /// carries metadata and never a value.
    pub credentials: Vec<Value>,
}

impl DoubleState {
    pub fn requests_to(&self, path: &str) -> Vec<Recorded> {
        self.requests
            .iter()
            .filter(|request| request.path == path)
            .cloned()
            .collect()
    }
}

pub struct Double {
    address: SocketAddr,
    pub state: Arc<Mutex<DoubleState>>,
    running: Arc<AtomicBool>,
}

impl Double {
    pub fn start(signing_key: VerifyingKey) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        let address = listener.local_addr().expect("a bound address");
        let state = Arc::new(Mutex::new(DoubleState {
            signing_key: Some(signing_key),
            ..DoubleState::default()
        }));
        let running = Arc::clone(&Arc::new(AtomicBool::new(true)));
        let thread_state = Arc::clone(&state);
        let thread_running = Arc::clone(&running);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                if !thread_running.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(stream) = stream else { break };
                let state = Arc::clone(&thread_state);
                // One thread per connection: the daemon holds a socket open for
                // as long as it runs, and a serialised double would deadlock the
                // moment it also made an HTTP call.
                std::thread::spawn(move || serve(stream, &state));
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

    pub fn with_state<T>(&self, edit: impl FnOnce(&mut DoubleState) -> T) -> T {
        edit(&mut self.state.lock().expect("the double's state"))
    }

    /// Wait for something to become true of the double, or give up.
    ///
    /// The deadline exists so a scenario fails rather than hangs; it is not a
    /// performance assertion, and it must not be one. The slowest waits here
    /// are behind a real spawned harness, and the whole suite runs those in
    /// parallel — at twenty seconds the adversarial evaluation passed alone in
    /// eleven and timed out under the full suite's load, which is a deadline
    /// measuring the machine rather than the product.
    pub fn wait_for<T>(&self, what: &str, mut probe: impl FnMut(&DoubleState) -> Option<T>) -> T {
        let deadline = Instant::now() + Duration::from_secs(90);
        while Instant::now() < deadline {
            if let Some(value) = probe(&self.state.lock().expect("the double's state")) {
                return value;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        panic!("timed out waiting for {what}");
    }
}

impl Drop for Double {
    fn drop(&mut self) {
        self.running.store(false, Ordering::SeqCst);
        let _ = TcpStream::connect(self.address);
    }
}

fn serve(mut stream: TcpStream, state: &Arc<Mutex<DoubleState>>) {
    // The path is read without consuming the stream, so a websocket upgrade can
    // be handed to the handshake untouched while everything else is served as
    // ordinary HTTP.
    let Some(path) = peek_path(&stream) else {
        return;
    };
    if path.starts_with("/api/device/runner/socket") {
        serve_socket(stream, state, &path);
        return;
    }
    if path.starts_with("/w/") {
        serve_mcp(stream, state);
        return;
    }

    let Some((path, headers, body)) = read_request(&mut stream) else {
        return;
    };
    let verified = verify_envelope(state, "POST", &path, &headers, &body);
    let claims = decode_claims(&headers);
    let response = {
        let mut locked = state.lock().expect("the double's state");
        if path == "/api/device/runner/outcome" {
            if let Ok(parsed) = serde_json::from_slice::<Value>(&body) {
                locked.outcomes.push((
                    parsed
                        .get("outcome")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    parsed
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                ));
            }
        }
        locked.requests.push(Recorded {
            path: path.clone(),
            body: body.clone(),
            signature_verified: verified,
            config_revision: claims
                .get("configRevision")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            runner_epoch: serde_json::from_slice::<Value>(&body)
                .ok()
                .and_then(|parsed| parsed.get("runnerEpoch").and_then(Value::as_u64))
                .unwrap_or(0),
        });
        let accepted = verified
            || (path == "/api/device/runner/register" && locked.accept_unsigned_registration);
        respond(&mut locked, &path, accepted)
    };
    let (status, payload) = response;
    let body = payload.to_string();
    let _ = write!(
        stream,
        "HTTP/1.1 {status} OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len(),
    );
    let _ = stream.flush();
}

/// The MCP endpoint a harness speaks, with a bearer session token.
///
/// Deliberately not signed. An MCP call carries its own authority in the
/// session token, which is the boundary R02 is about: the daemon signs as a
/// device, the harness bears a scoped session, and those are two different
/// credentials with two different lifetimes.
fn serve_mcp(mut stream: TcpStream, state: &Arc<Mutex<DoubleState>>) {
    let Some((_path, headers, body)) = read_request(&mut stream) else {
        return;
    };
    let bearer = headers
        .get("authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default()
        .to_string();
    let request: Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let name = request
        .pointer("/params/name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let arguments = request
        .pointer("/params/arguments")
        .cloned()
        .unwrap_or(json!({}));

    let (status, payload) = {
        let mut locked = state.lock().expect("the double's state");
        locked.tool_calls.push(name.clone());
        locked.bearers.push(bearer.clone());
        // A token nobody minted is refused at the transport, before there is a
        // tool result to read — the way a revoked session is.
        if bearer != SESSION_TOKEN {
            (401, json!({ "error": { "message": "unauthorized" } }))
        } else {
            mcp_result(&mut locked, &name, &arguments)
        }
    };
    let body = payload.to_string();
    let _ = write!(
        stream,
        "HTTP/1.1 {status} OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len(),
    );
    let _ = stream.flush();
}

fn mcp_result(state: &mut DoubleState, name: &str, arguments: &Value) -> (u16, Value) {
    let structured = match name {
        "agent_next" => {
            if state.queue.is_empty() {
                json!({ "item": null })
            } else {
                let item_id = state.queue.remove(0);
                state.claimed.push(item_id.clone());
                json!({
                    "item": { "item_id": item_id, "message_id": format!("message-{item_id}"), "channel_id": "channel-runner" },
                    "lease": { "leaseGeneration": 1 },
                })
            }
        }
        "agent_start" => json!({ "started": true }),
        "agent_post" => {
            let content = arguments
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if let Some(refused) = state.refuse_post_containing.clone() {
                if content.contains(&refused) {
                    // Refused before anything is recorded, which is what the
                    // workspace's own tripwire does: the write never happens,
                    // so `posts` stays clean and a scenario can assert on it.
                    return (
                        200,
                        json!({
                            "jsonrpc": "2.0",
                            "id": 1,
                            "result": {
                                "isError": true,
                                "content": [{ "type": "text", "text": "This write contains TRAP_TOKEN, which is a canary credential. It was refused." }],
                            },
                        }),
                    );
                }
            }
            state.posts.push(content);
            json!({ "messageId": "message-1" })
        }
        "list_credentials" => json!({ "credentials": state.credentials }),
        "agent_complete" => {
            if let Some(item_id) = arguments.get("item_id").and_then(Value::as_str) {
                state.claimed.retain(|claimed| claimed != item_id);
                state.completed.push(item_id.to_string());
            }
            json!({ "completed": true })
        }
        // A tool nobody defined is refused at the protocol level, the way the
        // real endpoint refuses one: there is no configuration that turns an
        // invented `request_secret` into a working call.
        other => {
            return (
                200,
                json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "error": { "code": -32602, "message": format!("unknown tool {other}") },
                }),
            )
        }
    };
    (
        200,
        json!({ "jsonrpc": "2.0", "id": 1, "result": { "structuredContent": structured } }),
    )
}

/// Accept the daemon's outbound socket and push whatever the scenario staged.
fn serve_socket(stream: TcpStream, state: &Arc<Mutex<DoubleState>>, path: &str) {
    let headers: Arc<Mutex<HashMap<String, String>>> = Arc::new(Mutex::new(HashMap::new()));
    let captured = Arc::clone(&headers);
    let accepted = tungstenite::accept_hdr(
        stream,
        |request: &tungstenite::handshake::server::Request,
         response: tungstenite::handshake::server::Response| {
            let mut locked = captured.lock().expect("the captured headers");
            for (name, value) in request.headers() {
                locked.insert(
                    name.as_str().to_ascii_lowercase(),
                    value.to_str().unwrap_or_default().to_string(),
                );
            }
            Ok(response)
        },
    );
    let Ok(mut socket) = accepted else { return };

    // The upgrade is signed like every other device request, and the double
    // checks it the same way. An unsigned socket would make every other
    // guarantee here reachable by anybody who can open a TCP connection.
    let captured = headers.lock().expect("the captured headers").clone();
    let signed_path = path.split('?').next().unwrap_or(path).to_string();
    if !verify_envelope(state, "GET", &signed_path, &captured, &[]) {
        state
            .lock()
            .expect("the double's state")
            .socket_rejected_reason = Some("unsigned upgrade".to_string());
        let _ = socket.close(None);
        return;
    }

    state.lock().expect("the double's state").sockets_accepted += 1;
    // A welcome first, the way the workspace sends one. It is what tells the
    // daemon which agents it answers for, and therefore what it should hold a
    // session for — so a wake arriving straight afterwards is not spent
    // discovering there is none.
    let welcome = json!({
        "type": "welcome",
        "deviceId": DEVICE_ID,
        "runnerEpoch": 1,
        "agentIds": [AGENT_ID],
    })
    .to_string();
    if socket
        .send(tungstenite::Message::Text(welcome.into()))
        .is_err()
    {
        return;
    }
    // A short read timeout so this thread can do both jobs: notice frames the
    // daemon sends, and notice frames the scenario stages while it is running.
    let _ = socket
        .get_ref()
        .set_read_timeout(Some(Duration::from_millis(25)));
    loop {
        let staged = {
            let mut locked = state.lock().expect("the double's state");
            std::mem::take(&mut locked.outbound)
        };
        for frame in staged {
            if socket
                .send(tungstenite::Message::Text(frame.into()))
                .is_err()
            {
                return;
            }
        }
        match socket.read() {
            Ok(_) => continue,
            Err(tungstenite::Error::Io(error))
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue
            }
            Err(_) => return,
        }
    }
}

fn peek_path(stream: &TcpStream) -> Option<String> {
    let mut buffer = [0u8; 2048];
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        let read = stream.peek(&mut buffer).ok()?;
        if read == 0 {
            return None;
        }
        if let Some(end) = buffer[..read].windows(2).position(|pair| pair == b"\r\n") {
            let line = String::from_utf8_lossy(&buffer[..end]).to_string();
            return line.split_whitespace().nth(1).map(str::to_string);
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    None
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

fn decode_claims(headers: &HashMap<String, String>) -> Value {
    headers
        .get("x-lepidy-device-claims")
        .and_then(|encoded| URL_SAFE_NO_PAD.decode(encoded).ok())
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .unwrap_or(json!({}))
}

/// The control plane's check, in miniature.
fn verify_envelope(
    state: &Arc<Mutex<DoubleState>>,
    method: &str,
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
    // The signature covers the method and the path, so an upgrade signed for
    // the socket cannot be replayed against the register endpoint.
    if text("path") != path || !text("method").eq_ignore_ascii_case(method) {
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

fn respond(state: &mut DoubleState, path: &str, verified: bool) -> (u16, Value) {
    if !verified {
        return (
            401,
            json!({ "error": "device_unauthorized", "message": "the signature was refused" }),
        );
    }
    match path {
        "/api/device/runner/register" => (
            200,
            json!({
                "workspaceId": WORKSPACE_ID,
                "deviceId": DEVICE_ID,
                "runnerEpoch": 1,
                "agentIds": [AGENT_ID],
                "displacedDeviceIds": [],
            }),
        ),
        "/api/device/runner/depth" => {
            // Derived from the queue, the way the workspace derives it, so a
            // scenario does not have to keep two numbers in step. A scenario
            // that wants a specific answer sets `depth` and that wins.
            let agents = if state.depth.is_empty() && !state.queue.is_empty() {
                vec![json!({
                    "agentId": AGENT_ID,
                    "presetId": "p1",
                    "depth": state.queue.len(),
                    "status": "active",
                })]
            } else {
                state.depth.clone()
            };
            (
                200,
                json!({ "workspaceId": WORKSPACE_ID, "runnerEpoch": 1, "agents": agents }),
            )
        }
        "/api/device/runner/release" => {
            (200, json!({ "workspaceId": WORKSPACE_ID, "released": 1 }))
        }
        "/api/device/runner/session" => {
            state.sessions_minted += 1;
            (
                200,
                json!({
                    "workspaceId": WORKSPACE_ID,
                    "agentId": AGENT_ID,
                    "sessionId": SESSION_ID,
                    "delegationId": "delegation-runner",
                    "token": SESSION_TOKEN,
                    // Far enough away that no scenario is timing-dependent; the
                    // expiry rule itself has its own unit scenario.
                    "tokenExpiresAt": 4_102_444_800_000u64,
                    "hardExpiresAt": 4_102_444_800_000u64,
                    "capabilities": ["agent_next", "agent_start", "agent_post", "agent_complete"],
                    "mcpPath": "/w/runner-workspace/mcp",
                }),
            )
        }
        "/api/device/runner/outcome" => (200, json!({ "workspaceId": WORKSPACE_ID })),
        _ => (
            404,
            json!({ "error": "not_found", "message": "no such endpoint" }),
        ),
    }
}

/* -------------------------------------------------------------------------- */
/* The machine under test                                                      */
/* -------------------------------------------------------------------------- */

static HOMES: AtomicUsize = AtomicUsize::new(0);

/// One scenario's private profile directory, removed when the test ends.
pub struct TempHome {
    pub path: PathBuf,
}

impl TempHome {
    pub fn create(label: &str) -> Self {
        let ordinal = HOMES.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!(
            "lepidy-runner-{}-{label}-{ordinal}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("a scenario home");
        Self { path }
    }
}

impl Drop for TempHome {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// Enrol this scenario's machine without going through `lepidy login`.
///
/// The profile is written exactly as the CLI writes it — the same sealed
/// keystore, the same Argon2id parameters — so the daemon under test is opening
/// a real keystore with a real passphrase, not a fixture shaped like one.
pub fn enrol(home: &TempHome, server_url: &str) -> VerifyingKey {
    let signing = DeviceSigningKey::generate();
    let vault = VaultKeyPair::generate();
    let secrets = fresh_secrets(DEVICE_CREDENTIAL.to_string(), &signing, &vault);
    let sealed = seal(&secrets, PASSPHRASE, DEVICE_ID, WORKSPACE_ID).expect("a sealed keystore");
    let recovery = seal(&secrets, "recovery-code-for-tests", DEVICE_ID, WORKSPACE_ID)
        .expect("a sealed recovery keystore");
    let profile = Profile {
        version: PROFILE_VERSION,
        server_url: server_url.to_string(),
        account_id: "account-runner".to_string(),
        workspace_id: WORKSPACE_ID.to_string(),
        workspace_slug: WORKSPACE_SLUG.to_string(),
        member_id: MEMBER_ID.to_string(),
        authorization_epoch: 1,
        device_id: DEVICE_ID.to_string(),
        device_key_epoch: 1,
        project_id: "project-runner".to_string(),
        vault_key_epoch: 1,
        vault_public_key: encode(&vault.public_key_bytes()),
        passphrase: sealed,
        recovery,
    };
    std::fs::write(
        home.path.join("profile.json"),
        serde_json::to_vec_pretty(&profile).expect("a profile document"),
    )
    .expect("the scenario home is writable");
    verifying_key(&signing)
}

fn verifying_key(signing: &DeviceSigningKey) -> VerifyingKey {
    let jwk = signing.public_jwk();
    let x = URL_SAFE_NO_PAD
        .decode(jwk["x"].as_str().expect("the jwk has an x"))
        .expect("x decodes");
    let y = URL_SAFE_NO_PAD
        .decode(jwk["y"].as_str().expect("the jwk has a y"))
        .expect("y decodes");
    let mut sec1 = vec![0x04];
    sec1.extend_from_slice(&x);
    sec1.extend_from_slice(&y);
    VerifyingKey::from_sec1_bytes(&sec1).expect("a verifying key")
}

/// Run `lepidy-agentd` to completion, writing exactly what the scenario says
/// on standard input — including a wrong passphrase, which is a case worth
/// being able to test.
pub fn agentd(home: &TempHome, arguments: &[&str], stdin: &[&str]) -> std::process::Output {
    let mut child = command(home, arguments);
    {
        let mut handle = child.stdin.take().expect("stdin was piped");
        for line in stdin {
            writeln!(handle, "{line}").expect("write to the daemon");
        }
    }
    child.wait_with_output().expect("the daemon to finish")
}

/// A running daemon, with its output collected as it is produced.
///
/// Collected on a thread rather than read at the end for a concrete reason:
/// the preset's own processes inherit the daemon's stdout, so a `read_to_end`
/// after killing the daemon blocks until every grandchild has also exited —
/// which for a preset that sleeps is the whole test.
pub struct Daemon {
    child: Child,
    output: Arc<Mutex<String>>,
}

impl Daemon {
    /// What the daemon has said so far.
    pub fn output(&self) -> String {
        self.output.lock().expect("the daemon's output").clone()
    }

    /// Wait for the daemon to say something, or give up.
    pub fn wait_for_output(&self, needle: &str) -> String {
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            let seen = self.output();
            if seen.contains(needle) {
                return seen;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        panic!(
            "timed out waiting for {needle:?}; the daemon said: {}",
            self.output()
        );
    }

    pub fn stop(mut self) -> String {
        let _ = self.child.kill();
        let _ = self.child.wait();
        self.output()
    }
}

/// Start `lepidy-agentd` and leave it running, unlocked with the right
/// passphrase — on standard input, never in argv.
pub fn spawn_agentd(home: &TempHome, arguments: &[&str]) -> Daemon {
    // A production `register` persists this assignment so every new daemon
    // epoch can fence its predecessor before opening a socket. Most daemon
    // scenarios intentionally begin at the socket boundary rather than
    // exercising the registration command again, so seed the same local fact.
    let preset_path = home.path.join("presets.json");
    if preset_path.exists() {
        let mut store: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&preset_path).expect("the preset store"))
                .expect("preset json");
        store["runnerAgents"] = json!({ AGENT_ID: "p1" });
        store["runnerEpoch"] = json!(0);
        std::fs::write(
            &preset_path,
            serde_json::to_vec_pretty(&store).expect("preset json"),
        )
        .expect("the preset store is writable");
    }
    let mut child = command(home, arguments);
    if let Some(handle) = child.stdin.as_mut() {
        let _ = writeln!(handle, "{PASSPHRASE}");
    }
    let output = Arc::new(Mutex::new(String::new()));
    if let Some(stdout) = child.stdout.take() {
        let collected = Arc::clone(&output);
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { return };
                let mut locked = collected.lock().expect("the daemon's output");
                locked.push_str(&line);
                locked.push('\n');
            }
        });
    }
    Daemon { child, output }
}

fn command(home: &TempHome, arguments: &[&str]) -> Child {
    Command::new(env!("CARGO_BIN_EXE_lepidy-agentd"))
        .args(arguments)
        .env("LEPIDY_HOME", &home.path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the lepidy-agentd binary")
}

/// The reference harness a preset points at.
pub fn harness_binary() -> &'static str {
    env!("CARGO_BIN_EXE_lepidy-harness-reference")
}

/// The harness that tries every documented circumvention move instead of doing
/// the work. Compiled by the same build, launched by the same daemon.
pub fn adversary_binary() -> &'static str {
    env!("CARGO_BIN_EXE_lepidy-harness-adversary")
}

/// The credential CLI, which the adversary invokes for the hook and the
/// scanner exactly as a real harness on a real machine would.
///
/// `CARGO_BIN_EXE_*` only covers this package's own binaries, and `lepidy`
/// belongs to the CLI crate, so it is found next to this test binary instead —
/// and built if a narrower `cargo test -p lepidy-runner` did not build it. The
/// workspace-wide run the gate uses always has it already.
pub fn cli_binary() -> PathBuf {
    let name = if cfg!(windows) {
        "lepidy.exe"
    } else {
        "lepidy"
    };
    let mut path = std::env::current_exe().expect("the test binary");
    path.pop();
    path.pop();
    path.push(name);
    if !path.exists() {
        let built = Command::new(std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into()))
            .args(["build", "-p", "lepidy-cli", "--bin", "lepidy"])
            .status()
            .expect("cargo");
        assert!(built.success(), "the lepidy binary could not be built");
    }
    assert!(
        path.exists(),
        "the lepidy binary is missing at {}",
        path.display()
    );
    path
}

pub fn text(output: &[u8]) -> String {
    String::from_utf8_lossy(output).to_string()
}

/// A wake frame, as the workspace sends it.
pub fn wake(preset_id: &str, config_revision: u64) -> String {
    json!({
        "type": "wake",
        "trigger": {
            "workspaceId": WORKSPACE_ID,
            "agentId": AGENT_ID,
            "deviceId": DEVICE_ID,
            "presetId": preset_id,
            "configRevision": config_revision,
            "requestId": "request-0001",
        },
    })
    .to_string()
}
