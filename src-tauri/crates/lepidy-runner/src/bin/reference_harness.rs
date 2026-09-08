//! The reference harness.
//!
//! A real, separate process that speaks real MCP over real HTTP: it claims an
//! item, starts it, answers in the room the mention came from, and completes
//! the exact lease it holds. It is what a preset points at when somebody wants
//! to see the whole workflow work, and it is what the gate runs.
//!
//! Why a first-party harness exists at all, rather than the suite driving
//! Claude Code or Codex: a verification gate that needs an API key, a model
//! provider and a network is not a gate. This proves the *contract* — the
//! environment a harness is handed, the tools it may call, the exit codes it
//! reports with — deterministically and offline. Certifying a particular
//! model-backed harness against a live model is R04's matrix, and this file
//! makes no claim about one.
//!
//! It is also the executable form of the harness contract. Anything written
//! against `docs/harness-preset-contract.md` should be able to replace it.

use std::process::ExitCode;

use serde_json::{json, Value};

/// The exit codes this contract defines. 78 is the one that matters: it means
/// a person has a decision to make, and it is the same number the credential
/// CLI uses for the same meaning, so one number means one thing everywhere.
const EXIT_BLOCKED: u8 = 78;
const EXIT_FAILURE: u8 = 1;

fn main() -> ExitCode {
    match run() {
        Ok(code) => ExitCode::from(code),
        Err(message) => {
            eprintln!("lepidy-harness-reference: {message}");
            ExitCode::from(EXIT_FAILURE)
        }
    }
}

struct Environment {
    mcp_url: String,
    token: String,
    agent_id: String,
    session_id: String,
    mode: String,
}

fn environment() -> Result<Environment, String> {
    let required = |name: &str| {
        std::env::var(name)
            .map_err(|_| format!("{name} is not set; this is not a Lepidy runner environment"))
    };
    Ok(Environment {
        mcp_url: required("LEPIDY_MCP_URL")?,
        // The token arrives in the environment and never on a command line: a
        // command line is readable by every other process on this machine and
        // is captured verbatim by logs.
        token: required("LEPIDY_SESSION_TOKEN")?,
        agent_id: required("LEPIDY_AGENT_ID")?,
        session_id: required("LEPIDY_SESSION_ID")?,
        // A preset's own switch, set locally, never by the workspace. It is how
        // a scenario asks this harness to behave like one that hits its
        // permission wall, without pretending the workspace can ask for that.
        mode: std::env::var("LEPIDY_HARNESS_MODE").unwrap_or_else(|_| "drain".to_string()),
    })
}

fn run() -> Result<u8, String> {
    let env = environment()?;
    let agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(std::time::Duration::from_secs(30)))
        .build();
    let agent = ureq::Agent::new_with_config(agent);

    let mut drained = 0;
    // Bounded rather than "until empty": a harness that loops on a queue that
    // is being written to never exits, and a run that never exits never frees
    // its slot or reports its outcome.
    for turn in 0..8 {
        let lease_token = format!(
            "reference-lease-{}-{turn}-{}",
            env.session_id,
            "x".repeat(40)
        );
        let claimed = call(
            &agent,
            &env,
            "agent_next",
            json!({
                "agent": env.agent_id,
                "claim_id": format!("reference-claim-{}-{turn}", env.session_id),
                "lease_token": lease_token,
                "session_id": env.session_id,
            }),
        )?;
        let Some(item) = claimed.get("item").filter(|value| !value.is_null()) else {
            break;
        };
        let item_id = string(item, "item_id")?;
        let channel_id = string(item, "channel_id")?;
        let lease_generation = claimed
            .get("lease")
            .and_then(|lease| lease.get("leaseGeneration"))
            .and_then(Value::as_u64)
            .ok_or_else(|| "the claim carried no lease generation".to_string())?;
        let proof = json!({
            "agent": env.agent_id,
            "item_id": item_id,
            "lease_generation": lease_generation,
            "lease_token": lease_token,
            "session_id": env.session_id,
        });

        call(&agent, &env, "agent_start", proof.clone())?;

        // The blocked case, before anything is posted and before the lease is
        // completed. This is what a harness looks like when its own safe
        // default permission posture refuses the thing it was asked to do: it
        // holds a claim it cannot finish and exits saying so. The daemon sees
        // the code, tells the workspace, and the item becomes a person's
        // decision rather than a retry that would just block again.
        if env.mode == "blocked" {
            eprintln!(
                "lepidy-harness-reference: refused by permission posture; a person needs to decide. item={item_id}"
            );
            return Ok(EXIT_BLOCKED);
        }

        call(
            &agent,
            &env,
            "agent_post",
            json!({
                "agent": env.agent_id,
                "channel_id": channel_id,
                "content": format!("Worked item {item_id} from the reference harness."),
                "idempotency_key": format!("reference-post-{}-{turn}", env.session_id),
            }),
        )?;
        call(
            &agent,
            &env,
            "agent_complete",
            merge(
                proof,
                json!({
                    "completion_id": format!("reference-completion-{}-{turn}", env.session_id),
                    "output_digest": format!("reference-digest-{turn}"),
                }),
            ),
        )?;
        drained += 1;
        println!("lepidy-harness-reference: answered {item_id}.");
    }

    println!("lepidy-harness-reference: drained {drained} item(s).");
    Ok(0)
}

fn merge(mut base: Value, extra: Value) -> Value {
    if let (Some(base), Some(extra)) = (base.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            base.insert(key.clone(), value.clone());
        }
    }
    base
}

fn string(value: &Value, field: &str) -> Result<String, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("the workspace returned no {field}"))
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
    // A dead or revoked session is refused at the transport, before there is a
    // tool result to read. That is not this harness's problem to solve: it says
    // so and exits, and the daemon reports the failure.
    if status != 200 {
        return Err(format!("{name} was refused with status {status}"));
    }
    let parsed: Value =
        serde_json::from_str(&text).map_err(|error| format!("{name} returned no json: {error}"))?;
    let result = parsed
        .get("result")
        .ok_or_else(|| format!("{name} was refused at the protocol level: {text}"))?;
    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        let detail = result
            .get("content")
            .and_then(|content| content.get(0))
            .and_then(|first| first.get("text"))
            .and_then(Value::as_str)
            .unwrap_or("the tool refused");
        return Err(format!("{name}: {detail}"));
    }
    Ok(result
        .get("structuredContent")
        .cloned()
        .unwrap_or_else(|| json!({})))
}
