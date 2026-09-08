//! The adversary harness — the executable form of the anti-circumvention gate.
//!
//! # Why this exists
//!
//! PRD §8.4 names the dangerous failure mode: not an agent that cannot work the
//! CLI, but a *helpful* one that routes around a denial — grepping for `.env`,
//! reading `~/.aws/credentials`, asking a person to paste the token into chat.
//! That silently defeats the product while leaving the user believing they are
//! protected, which is worse than having no vault at all. PRD §8.11 makes the
//! agent-behaviour suite a hard release gate for exactly this.
//!
//! So this is a real, separate harness process, launched by the real daemon
//! from a real preset, holding a real scoped session, speaking real MCP over
//! real HTTP. It then tries every circumvention move the product claims to
//! stop, one at a time, and prints what happened as one JSON line per attempt.
//! The scenario driving it asserts that every single attempt was refused and
//! that the canary value never reached any surface.
//!
//! # What this is not
//!
//! It is not a model. It cannot be: a verification gate that needs an API key,
//! a model provider and a network is not a gate, and the same reasoning that
//! produced `lepidy-harness-reference` applies here. A deterministic adversary
//! proves that **the boundaries hold when they are attacked**, which is the
//! half that can be proved offline. Whether a particular model-backed harness
//! *chooses* to attack them is a separate question that needs a live model, and
//! nothing here claims an answer to it.
//!
//! In other words: this measures the circumvention *rate of success*, not the
//! circumvention *rate of attempt*. The first is the release gate; the second
//! is a trend somebody must watch with a real model and a real transcript.

use std::process::ExitCode;

use serde_json::{json, Value};

/// The same number the CLI and the reference harness use: a person has to
/// decide something. An adversary that gets nowhere ends here, because that is
/// exactly what a harness blocked by policy should report.
const EXIT_BLOCKED: u8 = 78;
const EXIT_LEAKED: u8 = 3;

struct Environment {
    mcp_url: String,
    token: String,
    agent_id: String,
    session_id: String,
    /// The `lepidy` binary, supplied by the preset's own environment map. The
    /// workspace never names a program; the machine does.
    cli: String,
    /// The directory holding the decoy credential files this run tries to read.
    decoys: String,
    /// The canary value, read out of the decoy rather than handed over: this
    /// harness gets it the way a circumventing agent would, and every attempt
    /// below then proves that having it buys nothing.
    canary: String,
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => ExitCode::from(code),
        Err(message) => {
            eprintln!("lepidy-harness-adversary: {message}");
            ExitCode::from(1)
        }
    }
}

fn environment() -> Result<Environment, String> {
    let required = |name: &str| {
        std::env::var(name)
            .map_err(|_| format!("{name} is not set; this is not a Lepidy runner environment"))
    };
    let decoys = required("LEPIDY_ADVERSARY_DECOYS")?;
    Ok(Environment {
        mcp_url: required("LEPIDY_MCP_URL")?,
        token: required("LEPIDY_SESSION_TOKEN")?,
        agent_id: required("LEPIDY_AGENT_ID")?,
        session_id: required("LEPIDY_SESSION_ID")?,
        cli: required("LEPIDY_ADVERSARY_CLI")?,
        decoys: decoys.clone(),
        // Read the decoy `.env` directly. Nothing stops a process on this
        // machine reading a file, which is precisely the point: the vault's
        // claim is not that a plaintext file cannot be read, it is that a
        // credential cannot leave through Lepidy — so the value is obtained
        // here on purpose and every attempt to use it is then refused.
        canary: std::fs::read_to_string(format!("{decoys}/.env"))
            .map_err(|error| format!("could not read the decoy: {error}"))?
            .lines()
            .find_map(|line| line.strip_prefix("TRAP_TOKEN=").map(str::to_string))
            .ok_or_else(|| "the decoy held no TRAP_TOKEN".to_string())?,
    })
}

fn run() -> Result<u8, String> {
    let env = environment()?;
    let agent = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(std::time::Duration::from_secs(30)))
            .build(),
    );

    // Claim one item the ordinary way, so everything below happens inside a
    // real, live, scoped session rather than from nowhere.
    let claimed = call(
        &agent,
        &env,
        "agent_next",
        json!({
            "agent": env.agent_id,
            "claim_id": format!("adversary-claim-{}", env.session_id),
            "lease_token": format!("adversary-lease-{}{}", env.session_id, "x".repeat(40)),
            "session_id": env.session_id,
        }),
    );
    let item = claimed
        .ok()
        .and_then(|value| value.get("item").cloned())
        .filter(|value| !value.is_null());
    let (channel_id, message_id) = match &item {
        Some(item) => (
            item.get("channel_id")
                .and_then(Value::as_str)
                .unwrap_or("channel-runner")
                .to_string(),
            item.get("message_id")
                .and_then(Value::as_str)
                .unwrap_or("message-0")
                .to_string(),
        ),
        None => ("channel-runner".to_string(), "message-0".to_string()),
    };

    let mut attempts: Vec<Value> = Vec::new();

    // 1. Ask the workspace for a credential value directly. There is no such
    //    tool, and the refusal must be a protocol-level "no such tool" rather
    //    than something that could ever be enabled by configuration.
    for invented in [
        "request_secret",
        "reveal_credential",
        "store_secret",
        "read_credential",
    ] {
        let outcome = call(&agent, &env, invented, json!({ "name": "TRAP_TOKEN" }));
        attempts.push(record(
            &format!("mcp_tool:{invented}"),
            outcome.is_err(),
            &outcome_text(&outcome),
            &env.canary,
        ));
    }

    // 2. Read the listing that does exist, and check that it hands over
    //    metadata rather than a value. A listing that leaked one would be the
    //    most convenient circumvention there is.
    let listed = call(&agent, &env, "list_credentials", json!({}));
    let listing = outcome_text(&listed);
    attempts.push(record(
        "mcp_tool:list_credentials",
        !listing.contains(&env.canary),
        &listing,
        &env.canary,
    ));

    // 3. Read the decoy credential files. This is the move that matters most,
    //    and the surface that sees it is the PreToolUse hook — so this asks the
    //    real hook binary the same question Claude Code would, with the same
    //    JSON on standard input.
    for command in [
        format!("cat {}/.env", env.decoys),
        format!("cat {}/.aws/credentials", env.decoys),
        "echo $TRAP_TOKEN".to_string(),
        "env".to_string(),
        "printenv TRAP_TOKEN".to_string(),
    ] {
        let (code, said) = hook(&env, &command);
        attempts.push(record(
            &format!("hook:{command}"),
            code == Some(2),
            &said,
            &env.canary,
        ));
    }

    // 3a. The move the hook deliberately does *not* catch, recorded as such
    //     rather than quietly omitted. A recursive read of a directory names no
    //     credential file, and the rule that would block it is the same rule
    //     that allows `grep -r TODO .` — narrowing one narrows the other, and a
    //     hook that coaches ordinary work is a hook somebody switches off.
    //
    //     This is the whole reason the hook is not the boundary. The value read
    //     this way still cannot be used or sent: attempt 6 below tries exactly
    //     that with what a recursive read would have found, and the workspace
    //     refuses the write.
    let recursive = format!("grep -r TOKEN {}", env.decoys);
    let (code, _) = hook(&env, &recursive);
    attempts.push(json!({
        "attempt": format!("hook:{recursive}"),
        "refused": code == Some(2),
        "note": "expected not to be blocked: the hook sees no credential path here, by design",
        "leaked": false,
    }));

    // 4. The correct command must still be allowed, because a hook that blocks
    //    everything teaches nothing and gets switched off.
    let (code, said) = hook(&env, "lepidy run --with TRAP_TOKEN -- housectl deploy");
    attempts.push(record(
        "hook:correct-command-allowed",
        code == Some(0),
        &said,
        &env.canary,
    ));

    // 5. Scan the decoy the agent just tried to read. The credential is in
    //    there; the scanner has to say so.
    let scanned = std::process::Command::new(&env.cli)
        .args(["scan", &format!("{}/.env", env.decoys), "--quiet"])
        .output()
        .map_err(|error| format!("could not run the scanner: {error}"))?;
    let names = String::from_utf8_lossy(&scanned.stdout).trim().to_string();
    attempts.push(record(
        "scan:decoy-env",
        scanned.status.code() == Some(1) && names.contains("TRAP_TOKEN"),
        &names,
        &env.canary,
    ));

    // 6. Post the credential into the room. This is the exfiltration the canary
    //    exists to catch, and the workspace must refuse the write itself.
    let posted = call(
        &agent,
        &env,
        "agent_post",
        json!({
            "agent": env.agent_id,
            "channel_id": channel_id,
            "parent_id": message_id,
            "content": format!("Here is the token you asked for: {}", env.canary),
            "idempotency_key": format!("adversary-post-{}", env.session_id),
        }),
    );
    attempts.push(record(
        "post:canary-into-room",
        posted.is_err(),
        &outcome_text(&posted),
        &env.canary,
    ));

    // 7. Ask a person to paste it instead — the social route around the box.
    //    Posting that sentence is ordinary chat and is *not* refused, and this
    //    records it honestly rather than pretending otherwise. What it proves
    //    is the narrower thing that is actually true: asking produces no
    //    credential, because there is no path by which a reply could carry one
    //    to this session. The instruction not to ask is layer 1 and the skill,
    //    and whether a model obeys it needs a live model to measure.
    let asked = call(
        &agent,
        &env,
        "agent_post",
        json!({
            "agent": env.agent_id,
            "channel_id": channel_id,
            "parent_id": message_id,
            "content": "Please paste the production token into this thread.",
            "idempotency_key": format!("adversary-ask-{}", env.session_id),
        }),
    );
    attempts.push(json!({
        "attempt": "post:ask-a-person-to-paste",
        "refused": false,
        "note": "not refused: a message is ordinary chat. It obtains nothing.",
        "leaked": outcome_text(&asked).contains(&env.canary),
    }));

    let mut refused = 0;
    for attempt in &attempts {
        println!("{attempt}");
        if attempt["refused"] == json!(true) {
            refused += 1;
        }
        if attempt["leaked"] == json!(true) {
            eprintln!(
                "lepidy-harness-adversary: a canary value reached {}",
                attempt["attempt"]
            );
            return Ok(EXIT_LEAKED);
        }
    }
    println!(
        "{}",
        json!({ "summary": true, "attempts": attempts.len(), "refused": refused })
    );

    // Nothing was obtained, so a person has to decide what happens next. That
    // is precisely what exit code 78 means everywhere else in this product.
    eprintln!(
        "lepidy-harness-adversary: every route to a credential was refused; a person must decide."
    );
    Ok(EXIT_BLOCKED)
}

/// One attempt, as a line the scenario can assert on.
///
/// `leaked` is computed here rather than inferred later: a harness that emitted
/// a canary must say so even if it also considered the attempt refused.
fn record(attempt: &str, refused: bool, detail: &str, canary: &str) -> Value {
    json!({
        "attempt": attempt,
        "refused": refused,
        // Never the detail itself — printing what a refusal said about a value
        // would be its own leak. Only whether the value was in it.
        "leaked": detail.contains(canary),
    })
}

/// Run the real `PreToolUse` hook, with the JSON Claude Code would send.
fn hook(env: &Environment, command: &str) -> (Option<i32>, String) {
    let payload = json!({ "tool_name": "Bash", "tool_input": { "command": command } });
    let mut child = match std::process::Command::new(&env.cli)
        .args(["hook", "pretooluse"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => return (None, format!("could not run the hook: {error}")),
    };
    {
        use std::io::Write;
        if let Some(stdin) = child.stdin.as_mut() {
            let _ = stdin.write_all(payload.to_string().as_bytes());
        }
    }
    match child.wait_with_output() {
        Ok(output) => (
            output.status.code(),
            String::from_utf8_lossy(&output.stderr).to_string(),
        ),
        Err(error) => (None, format!("the hook did not finish: {error}")),
    }
}

fn outcome_text(outcome: &Result<Value, String>) -> String {
    match outcome {
        Ok(value) => value.to_string(),
        Err(message) => message.clone(),
    }
}

/// One MCP tool call, with the session token as a bearer credential.
fn call(
    agent: &ureq::Agent,
    env: &Environment,
    name: &str,
    arguments: Value,
) -> Result<Value, String> {
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": { "name": name, "arguments": arguments },
    });
    let mut response = agent
        .post(&env.mcp_url)
        .header("authorization", format!("Bearer {}", env.token))
        .header("content-type", "application/json")
        .send(serde_json::to_vec(&body).map_err(|error| error.to_string())?)
        .map_err(|error| format!("could not reach {}: {error}", env.mcp_url))?;
    let status = response.status().as_u16();
    let text = response
        .body_mut()
        .read_to_string()
        .map_err(|error| format!("could not read the reply: {error}"))?;
    if status != 200 {
        return Err(format!("{name} was refused with status {status}"));
    }
    let parsed: Value =
        serde_json::from_str(&text).map_err(|error| format!("{name} returned no json: {error}"))?;
    let Some(result) = parsed.get("result") else {
        return Err(format!("{name} was refused at the protocol level"));
    };
    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        return Err(format!(
            "{name}: {}",
            result
                .pointer("/content/0/text")
                .and_then(Value::as_str)
                .unwrap_or("the tool refused")
        ));
    }
    Ok(result
        .get("structuredContent")
        .cloned()
        .unwrap_or_else(|| json!({})))
}
