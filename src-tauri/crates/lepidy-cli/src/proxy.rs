//! The release-device half of the Tier-0 credential proxy.
//!
//! The workspace can authorize and relay, but it cannot perform this fetch: it
//! has neither the private key that opens the request nor the key that opens the
//! credential. Destination resolution, the credential-bearing header and
//! response redaction therefore all happen here.

use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use crate::crypto::{
    aes_gcm_decrypt, aes_gcm_encrypt, credential_aad, decode, encode, random_bytes, wrap_aad,
    VaultKeyPair, IV_BYTES,
};
use crate::error::{CliError, CliResult};

pub const PROXY_RESULT_PATH: &str = "/api/device/vault/proxy/result";
const MAX_REQUEST_BYTES: usize = 64 * 1024;
const MAX_RESPONSE_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProxyFrame {
    pub request_id: String,
    pub workspace_id: String,
    pub credential_id: String,
    pub credential_version: u64,
    pub credential_key_epoch: u64,
    pub allowed_hosts: Vec<String>,
    pub relay: RelayEnvelope,
    pub envelope: CredentialEnvelope,
    pub wrap: CredentialWrap,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelayEnvelope {
    pub suite: String,
    pub ephemeral_public_key: String,
    pub iv: String,
    pub ciphertext: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialEnvelope {
    pub cipher_suite: String,
    pub aad_version: u64,
    pub version: u64,
    pub key_epoch: u64,
    pub iv: String,
    pub ciphertext: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialWrap {
    pub custodian_member_id: String,
    pub recipient_key_epoch: u64,
    pub wrap_suite: String,
    pub ephemeral_public_key: String,
    pub iv: String,
    pub wrapped_dek: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RelayPayload {
    request: ProxyRequest,
    response_key: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProxyRequest {
    url: String,
    method: String,
    #[serde(default)]
    headers: std::collections::BTreeMap<String, String>,
    body: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ProxyResponseEnvelope {
    pub suite: &'static str,
    pub iv: String,
    pub ciphertext: String,
}

#[derive(Debug, Serialize)]
struct ProxyResult {
    status: u16,
    headers: std::collections::BTreeMap<String, String>,
    body: String,
    truncated: bool,
}

/// Open, execute and seal one request. The returned envelope is safe to relay
/// through the workspace; only its one-time response key can open it.
pub fn perform_proxy(
    frame: &ProxyFrame,
    member_id: &str,
    vault: &VaultKeyPair,
) -> CliResult<ProxyResponseEnvelope> {
    if frame.relay.suite != "P256-HKDF-SHA256-AES256GCM" {
        return Err(CliError::failure("unsupported proxy relay suite"));
    }
    let request_aad = canonical_aad(
        "lepidy-proxy-request",
        &frame.workspace_id,
        &frame.request_id,
    );
    let mut opened = vault
        .open_relay(
            &decode(
                &frame.relay.ephemeral_public_key,
                "proxy ephemeral public key",
            )?,
            &decode(&frame.relay.iv, "proxy relay iv")?,
            &decode(&frame.relay.ciphertext, "proxy relay ciphertext")?,
            &request_aad,
        )
        .map_err(|error| CliError::failure(error.to_string()))?;
    let payload: RelayPayload = serde_json::from_slice(&opened)
        .map_err(|_| CliError::failure("the proxy relay payload is invalid"))?;
    opened.zeroize();
    let mut response_key = decode(&payload.response_key, "proxy response key")?;
    if response_key.len() != 32 {
        response_key.zeroize();
        return Err(CliError::failure("proxy response key must be 256 bits"));
    }
    let mut credential = open_credential(frame, member_id, vault)?;
    let result = execute(&payload.request, &frame.allowed_hosts, &credential);
    credential.zeroize();
    let result = result?;
    let plaintext =
        serde_json::to_vec(&result).map_err(|error| CliError::failure(error.to_string()))?;
    let iv = random_bytes(IV_BYTES);
    let ciphertext = aes_gcm_encrypt(
        &response_key,
        &iv,
        &canonical_aad(
            "lepidy-proxy-response",
            &frame.workspace_id,
            &frame.request_id,
        ),
        &plaintext,
    )
    .map_err(|error| CliError::failure(error.to_string()));
    response_key.zeroize();
    Ok(ProxyResponseEnvelope {
        suite: "AES-256-GCM",
        iv: encode(&iv),
        ciphertext: encode(&ciphertext?),
    })
}

fn open_credential(
    frame: &ProxyFrame,
    member_id: &str,
    vault: &VaultKeyPair,
) -> CliResult<Vec<u8>> {
    if frame.envelope.cipher_suite != "AES-256-GCM"
        || frame.envelope.aad_version != 1
        || frame.envelope.version != frame.credential_version
        || frame.envelope.key_epoch != frame.credential_key_epoch
        || frame.wrap.wrap_suite != "P256-HKDF-SHA256-AES256GCM"
        || frame.wrap.custodian_member_id != member_id
    {
        return Err(CliError::failure("proxy credential binding is invalid"));
    }
    let mut dek = vault
        .unwrap_dek(
            &decode(
                &frame.wrap.ephemeral_public_key,
                "credential wrap public key",
            )?,
            &decode(&frame.wrap.iv, "credential wrap iv")?,
            &decode(&frame.wrap.wrapped_dek, "wrapped credential key")?,
            &wrap_aad(
                &frame.workspace_id,
                &frame.credential_id,
                frame.credential_version,
                member_id,
                frame.wrap.recipient_key_epoch,
            ),
        )
        .map_err(|error| CliError::failure(error.to_string()))?;
    let plaintext = aes_gcm_decrypt(
        &dek,
        &decode(&frame.envelope.iv, "credential iv")?,
        &credential_aad(
            &frame.workspace_id,
            &frame.credential_id,
            frame.credential_version,
        ),
        &decode(&frame.envelope.ciphertext, "credential ciphertext")?,
    )
    .map_err(|error| CliError::failure(error.to_string()));
    dek.zeroize();
    plaintext
}

fn execute(
    request: &ProxyRequest,
    allowed_hosts: &[String],
    credential: &[u8],
) -> CliResult<ProxyResult> {
    let url =
        url::Url::parse(&request.url).map_err(|_| CliError::failure("proxy URL is invalid"))?;
    let host = validate_destination(&url, allowed_hosts)?;
    if request.body.as_ref().map_or(0, |body| body.len()) > MAX_REQUEST_BYTES {
        return Err(CliError::failure("proxy request body is too large"));
    }
    let addresses = resolve_public(&host)?;
    let config = ureq::Agent::config_builder()
        .max_redirects(0)
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(20)))
        .build();
    use ureq::unversioned::transport::{Connector, RustlsConnector, TcpConnector};
    let connector = ().chain(TcpConnector::default()).chain(RustlsConnector::default());
    let agent = ureq::Agent::with_parts(config, connector, PinnedResolver { addresses });
    let secret = std::str::from_utf8(credential)
        .map_err(|_| CliError::failure("proxy credential is not a text token"))?;
    let authorization = format!("Bearer {secret}");
    for name in request.headers.keys() {
        let lower = name.to_ascii_lowercase();
        if !matches!(
            lower.as_str(),
            "accept" | "content-type" | "idempotency-key"
        ) {
            return Err(CliError::failure(format!(
                "proxy header {name} is not allowed"
            )));
        }
    }
    macro_rules! add_headers {
        ($builder:expr) => {{
            let mut builder = $builder.header("authorization", &authorization);
            for (name, value) in &request.headers {
                builder = builder.header(name, value);
            }
            builder
        }};
    }
    let mut response = match request.method.as_str() {
        "GET" => add_headers!(agent.get(request.url.as_str())).call(),
        "POST" => add_headers!(agent.post(request.url.as_str()))
            .send(request.body.as_deref().unwrap_or("").as_bytes()),
        "PUT" => add_headers!(agent.put(request.url.as_str()))
            .send(request.body.as_deref().unwrap_or("").as_bytes()),
        "PATCH" => add_headers!(agent.patch(request.url.as_str()))
            .send(request.body.as_deref().unwrap_or("").as_bytes()),
        "DELETE" => add_headers!(agent.delete(request.url.as_str())).call(),
        "HEAD" => add_headers!(agent.head(request.url.as_str())).call(),
        _ => return Err(CliError::failure("proxy method is not allowed")),
    }
    .map_err(|error| CliError::failure(format!("proxy request failed: {error}")))?;
    let status = response.status().as_u16();
    if (300..400).contains(&status) {
        return Err(CliError::failure("proxy redirects are refused"));
    }
    let mut headers = std::collections::BTreeMap::new();
    for name in ["content-type", "etag", "location", "retry-after"] {
        if let Some(value) = response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
        {
            headers.insert(name.to_string(), value.chars().take(4096).collect());
        }
    }
    let bytes = response
        .body_mut()
        .with_config()
        .limit((MAX_RESPONSE_BYTES + 1) as u64)
        .read_to_vec()
        .map_err(|error| CliError::failure(format!("could not read proxy response: {error}")))?;
    let truncated = bytes.len() > MAX_RESPONSE_BYTES;
    let bounded = &bytes[..bytes.len().min(MAX_RESPONSE_BYTES)];
    let mut body = String::from_utf8_lossy(bounded).to_string();
    if !secret.is_empty() {
        body = body.replace(secret, "[redacted:credential]");
    }
    Ok(ProxyResult {
        status,
        headers,
        body,
        truncated,
    })
}

fn validate_destination(url: &url::Url, allowed_hosts: &[String]) -> CliResult<String> {
    if url.scheme() != "https" || url.port_or_known_default() != Some(443) {
        return Err(CliError::failure(
            "proxy destinations must use HTTPS on port 443",
        ));
    }
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err(CliError::failure(
            "proxy destinations cannot contain credentials or fragments",
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| CliError::failure("proxy URL has no host"))?
        .to_ascii_lowercase();
    if host.parse::<IpAddr>().is_ok()
        || !allowed_hosts
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(&host))
    {
        return Err(CliError::failure("proxy destination is not allowlisted"));
    }
    Ok(host)
}

fn resolve_public(host: &str) -> CliResult<Vec<SocketAddr>> {
    let addresses: Vec<_> = (host, 443)
        .to_socket_addrs()
        .map_err(|_| CliError::failure("proxy destination DNS lookup failed"))?
        .collect();
    if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err(CliError::failure(
            "proxy destination resolved to a non-public address",
        ));
    }
    Ok(addresses)
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => public_v4(ip),
        IpAddr::V6(ip) => {
            if let Some(mapped) = ip.to_ipv4_mapped() {
                return public_v4(mapped);
            }
            !(ip.is_unspecified()
                || ip.is_loopback()
                || ip.is_multicast()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
                || in_v6_prefix(ip, Ipv6Addr::new(0x2001, 0x0db8, 0, 0, 0, 0, 0, 0), 32))
        }
    }
}

fn public_v4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    !(ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_multicast()
        || ip.is_broadcast()
        || ip.is_documentation()
        || octets[0] == 0
        || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
        || (octets[0] == 198 && (18..=19).contains(&octets[1]))
        || octets[0] >= 240)
}

fn in_v6_prefix(value: Ipv6Addr, prefix: Ipv6Addr, bits: u32) -> bool {
    let mask = u128::MAX << (128 - bits);
    (u128::from(value) & mask) == (u128::from(prefix) & mask)
}

fn canonical_aad(label: &str, workspace_id: &str, request_id: &str) -> Vec<u8> {
    serde_json::json!([label, 1, workspace_id, request_id])
        .to_string()
        .into_bytes()
}

#[derive(Clone)]
struct PinnedResolver {
    addresses: Vec<SocketAddr>,
}

impl fmt::Debug for PinnedResolver {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PinnedPublicResolver")
            .field("address_count", &self.addresses.len())
            .finish()
    }
}

impl ureq::unversioned::resolver::Resolver for PinnedResolver {
    fn resolve(
        &self,
        _uri: &ureq::http::Uri,
        _config: &ureq::config::Config,
        _timeout: ureq::unversioned::transport::NextTimeout,
    ) -> Result<ureq::unversioned::resolver::ResolvedSocketAddrs, ureq::Error> {
        let mut resolved = self.empty();
        for address in self.addresses.iter().copied().take(16) {
            resolved.push(address);
        }
        if resolved.is_empty() {
            Err(ureq::Error::HostNotFound)
        } else {
            Ok(resolved)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_private_and_special_use_addresses() {
        for address in [
            "0.0.0.0",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.1.1",
            "192.0.2.1",
            "198.18.0.1",
            "224.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
            "ff02::1",
        ] {
            assert!(
                !is_public_ip(address.parse().unwrap()),
                "{address} must be refused"
            );
        }
        assert!(is_public_ip("1.1.1.1".parse().unwrap()));
        assert!(is_public_ip("2606:4700:4700::1111".parse().unwrap()));
    }

    #[test]
    fn enforces_exact_https_allowlist() {
        let allowed = vec!["api.example.com".to_string()];
        assert!(validate_destination(
            &url::Url::parse("https://api.example.com/v1").unwrap(),
            &allowed
        )
        .is_ok());
        for value in [
            "http://api.example.com/v1",
            "https://api.example.com:444/v1",
            "https://127.0.0.1/v1",
            "https://evil.example/v1",
            "https://user@api.example.com/v1",
            "https://api.example.com/v1#x",
        ] {
            assert!(
                validate_destination(&url::Url::parse(value).unwrap(), &allowed).is_err(),
                "{value}"
            );
        }
    }
}
