//! The signed HTTPS transport.
//!
//! Every call after enrolment carries the F05 envelope: canonical claims, an
//! ECDSA signature over them, and the SHA-256 of the exact body bytes inside
//! those claims. The method and path are covered too, so a captured request
//! cannot be pointed at a different endpoint, and the nonce is single-use in the
//! control plane, so it cannot be replayed at the same one.
//!
//! The canonical string below is the twin of `canonicalSignedDeviceRequest` in
//! `src/control/authorization.ts`. The server rebuilds it from the claims it
//! parsed; a byte of disagreement is a failed signature.

use serde::Serialize;
use serde_json::json;

use crate::crypto::{encode, random_bytes, sha256_base64url, DeviceSigningKey};
use crate::error::{CliError, CliResult};
use crate::profile::Profile;

pub const CREDENTIAL_HEADER: &str = "x-lepidy-device-credential";
pub const CLAIMS_HEADER: &str = "x-lepidy-device-claims";
pub const SIGNATURE_HEADER: &str = "x-lepidy-device-signature";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedClaims {
    pub method: String,
    pub path: String,
    pub body_hash: String,
    pub workspace_id: String,
    pub member_id: String,
    pub authorization_epoch: u64,
    pub device_id: String,
    pub device_key_epoch: u64,
    pub timestamp: i64,
    pub nonce: String,
    pub request_id: String,
    pub project_id: String,
    pub config_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delegation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_id: Option<String>,
}

impl SignedClaims {
    fn canonical(&self) -> String {
        [
            "lepidy-device-request-v1",
            &self.method.to_uppercase(),
            &self.path,
            &self.body_hash,
            &self.workspace_id,
            &self.member_id,
            &self.authorization_epoch.to_string(),
            &self.device_id,
            &self.device_key_epoch.to_string(),
            &self.timestamp.to_string(),
            &self.nonce,
            &self.request_id,
            &self.project_id,
            &self.config_revision.to_string(),
            self.agent_id.as_deref().unwrap_or(""),
            self.delegation_id.as_deref().unwrap_or(""),
            self.origin_id.as_deref().unwrap_or(""),
        ]
        .join("\n")
    }
}

pub struct Client {
    agent: ureq::Agent,
    base: String,
}

pub struct Response {
    pub status: u16,
    pub body: serde_json::Value,
}

impl Response {
    pub fn error_message(&self) -> String {
        self.body
            .get("message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("the request was refused")
            .to_string()
    }
}

impl Client {
    pub fn new(base_url: &str) -> CliResult<Self> {
        let base = base_url.trim_end_matches('/').to_string();
        assert_transport_is_safe(&base)?;
        let config = ureq::Agent::config_builder()
            // Refusals arrive as 4xx with a body worth reading — the workspace's
            // own denial wording lives there — so a status is data, not an error.
            .http_status_as_error(false)
            .timeout_global(Some(std::time::Duration::from_secs(30)))
            .build();
        Ok(Self {
            agent: ureq::Agent::new_with_config(config),
            base,
        })
    }

    pub fn base_url(&self) -> &str {
        &self.base
    }

    /// An unsigned call. Only enrolment uses this: there is no device key yet.
    pub fn post_unsigned(&self, path: &str, body: &serde_json::Value) -> CliResult<Response> {
        let bytes =
            serde_json::to_vec(body).map_err(|error| CliError::failure(error.to_string()))?;
        self.send(path, &bytes, Vec::new())
    }

    pub fn post_signed(
        &self,
        profile: &Profile,
        signing: &DeviceSigningKey,
        device_credential: &str,
        path: &str,
        body: &serde_json::Value,
        provenance: Provenance,
    ) -> CliResult<Response> {
        let bytes =
            serde_json::to_vec(body).map_err(|error| CliError::failure(error.to_string()))?;
        let claims = SignedClaims {
            method: "POST".to_string(),
            path: path.to_string(),
            body_hash: sha256_base64url(&bytes),
            workspace_id: profile.workspace_id.clone(),
            member_id: profile.member_id.clone(),
            authorization_epoch: profile.authorization_epoch,
            device_id: profile.device_id.clone(),
            device_key_epoch: profile.device_key_epoch,
            timestamp: now_ms(),
            nonce: encode(&random_bytes(18)),
            request_id: encode(&random_bytes(18)),
            project_id: provenance.project_id,
            // The revision of the local launch configuration this request was
            // made under. One until R01 owns real presets, but signed from the
            // start so a preset change cannot be replayed past.
            config_revision: 1,
            agent_id: provenance.agent_id,
            delegation_id: provenance.delegation_id,
            origin_id: provenance.origin_id,
        };
        let encoded_claims = encode(
            serde_json::to_vec(&claims)
                .map_err(|error| CliError::failure(error.to_string()))?
                .as_slice(),
        );
        let signature = encode(&signing.sign(claims.canonical().as_bytes()));
        self.send(
            path,
            &bytes,
            vec![
                (CREDENTIAL_HEADER, device_credential.to_string()),
                (CLAIMS_HEADER, encoded_claims),
                (SIGNATURE_HEADER, signature),
            ],
        )
    }

    fn send(&self, path: &str, body: &[u8], headers: Vec<(&str, String)>) -> CliResult<Response> {
        let mut request = self
            .agent
            .post(format!("{}{path}", self.base))
            .header("content-type", "application/json");
        for (name, value) in headers {
            request = request.header(name, value);
        }
        let mut response = request.send(body).map_err(|error| {
            CliError::failure(format!("could not reach {}: {error}", self.base))
        })?;
        let status = response.status().as_u16();
        let text = response
            .body_mut()
            .read_to_string()
            .map_err(|error| CliError::failure(format!("could not read the reply: {error}")))?;
        let body = serde_json::from_str::<serde_json::Value>(&text)
            .unwrap_or_else(|_| json!({ "message": text }));
        Ok(Response { status, body })
    }
}

pub struct Provenance {
    pub project_id: String,
    pub agent_id: Option<String>,
    pub delegation_id: Option<String>,
    pub origin_id: Option<String>,
}

impl Provenance {
    pub fn project(project_id: &str) -> Self {
        Self {
            project_id: project_id.to_string(),
            agent_id: None,
            delegation_id: None,
            origin_id: None,
        }
    }
}

/// HTTPS, or a loopback address.
///
/// The loopback exception exists so the integration suite can drive a
/// disposable local double, and so a developer can point at `wrangler dev`. It
/// is deliberately an address check rather than a flag: there is no way to ask
/// this CLI to send a signed request to a remote host in the clear.
pub fn assert_transport_is_safe(base_url: &str) -> CliResult<()> {
    if let Some(rest) = base_url.strip_prefix("https://") {
        if rest.is_empty() {
            return Err(CliError::usage("the server URL has no host"));
        }
        return Ok(());
    }
    let rest = base_url
        .strip_prefix("http://")
        .ok_or_else(|| CliError::usage("the server URL must start with https://"))?;
    let host = rest.split(['/', ':']).next().unwrap_or("");
    if host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host == "::1" {
        return Ok(());
    }
    Err(CliError::usage(format!(
        "refusing to send a signed request to {base_url} in the clear: use https://, or a loopback address for local testing"
    )))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// VAULT-CLI-RULE-005
    #[test]
    fn plain_http_is_refused_except_on_loopback() {
        assert!(assert_transport_is_safe("https://lepidy.example").is_ok());
        assert!(assert_transport_is_safe("http://127.0.0.1:3100").is_ok());
        assert!(assert_transport_is_safe("http://localhost:3100").is_ok());
        assert!(assert_transport_is_safe("http://lepidy.example").is_err());
        assert!(assert_transport_is_safe("http://127.0.0.1.evil.example").is_err());
        assert!(assert_transport_is_safe("lepidy.example").is_err());
    }

    /// VAULT-CLI-RULE-006
    #[test]
    fn the_canonical_string_matches_the_control_plane_form() {
        let claims = SignedClaims {
            method: "post".to_string(),
            path: "/api/device/vault/list".to_string(),
            body_hash: "hash".to_string(),
            workspace_id: "ws".to_string(),
            member_id: "member".to_string(),
            authorization_epoch: 4,
            device_id: "device".to_string(),
            device_key_epoch: 2,
            timestamp: 17,
            nonce: "nonce".to_string(),
            request_id: "request".to_string(),
            project_id: "project".to_string(),
            config_revision: 1,
            agent_id: None,
            delegation_id: None,
            origin_id: None,
        };
        assert_eq!(
            claims.canonical(),
            "lepidy-device-request-v1\nPOST\n/api/device/vault/list\nhash\nws\nmember\n4\ndevice\n2\n17\nnonce\nrequest\nproject\n1\n\n\n"
        );
    }
}
