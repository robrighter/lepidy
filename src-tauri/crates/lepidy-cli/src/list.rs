//! `lepidy list` — what this member is allowed to know exists.
//!
//! Metadata only. The endpoint behind this serialises no ciphertext, no wrap
//! and no value, so listing tells an agent what it may ask for and how the
//! credential expects to be delivered — never what it is.

use serde_json::json;

use crate::args::Args;
use crate::client::Provenance;
use crate::error::{CliError, CliResult};
use crate::session::Session;

pub fn run(args: &Args) -> CliResult<i32> {
    let session = Session::open()?;
    let project = session.project(args.option("project"));
    let response = session.client.post_signed(
        &session.profile,
        &session.signing,
        session.device_credential(),
        "/api/device/vault/list",
        &json!({}),
        Provenance::project(&project),
    )?;
    if response.status != 200 {
        return Err(CliError::failure(format!(
            "listing refused: {}",
            response.error_message()
        )));
    }

    let credentials = response
        .body
        .get("credentials")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    if args.flag("json") {
        println!("{}", serde_json::Value::Array(credentials));
        return Ok(0);
    }
    if credentials.is_empty() {
        println!(
            "No credentials are visible to {} in {}.",
            session.profile.member_id, session.profile.workspace_slug
        );
        return Ok(0);
    }

    for credential in &credentials {
        let field = |name: &str| {
            credential
                .get(name)
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
        };
        let policy = credential.get("policy").cloned().unwrap_or(json!({}));
        let deliveries = policy
            .get("allowedDeliveries")
            .and_then(serde_json::Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default();
        println!("{}", field("name"));
        println!("  id          {}", field("id"));
        if !field("description").is_empty() {
            println!("  about       {}", field("description"));
        }
        if !field("envVar").is_empty() {
            println!("  variable    {}", field("envVar"));
        }
        println!(
            "  policy      {} · {deliveries}",
            policy
                .get("mode")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("ask")
        );
        if policy
            .get("highRisk")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
        {
            println!("  high risk   yes");
        }
    }
    Ok(0)
}
