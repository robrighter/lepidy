//! The connection this daemon holds open to its workspace.
//!
//! Outbound, and only outbound. The runner dials the workspace and the
//! workspace answers on the socket the runner already holds, so a laptop behind
//! NAT needs no open port, no inbound firewall rule and nothing reachable from
//! the internet. There is no code path anywhere by which a workspace initiates
//! a connection to a machine, and that is deliberate: an inbound listener on a
//! developer's laptop is a much larger promise than this product needs to make.
//!
//! The socket is a hint channel, never an authority. Everything the runner
//! actually does — claiming work, starting it, completing it — happens over
//! signed calls that carry their own authority. So a lost connection costs a
//! reconnect and a queue-depth check, and never costs work.

use std::time::Duration;

use lepidy_cli::proxy::ProxyFrame;
use serde::Deserialize;

/// What the workspace may say. Anything else is a protocol error and closes the
/// connection rather than being ignored, because a frame this side does not
/// understand is a version skew worth noticing.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ServerFrame {
    Welcome {
        #[serde(rename = "deviceId")]
        device_id: String,
        #[serde(rename = "runnerEpoch")]
        runner_epoch: u64,
        #[serde(rename = "agentIds", default)]
        agent_ids: Vec<String>,
    },
    /// Carries the D05a trigger and nothing else. Parsed by `crate::trigger`,
    /// which refuses any key outside the schema.
    Wake {
        trigger: serde_json::Value,
    },
    Stop {
        #[serde(rename = "agentId")]
        agent_id: String,
        reason: String,
    },
    ProxyRequest {
        #[serde(flatten)]
        request: ProxyFrame,
    },
    Pong,
}

/// How long to wait before dialling again, backing off and then holding.
///
/// A daemon that reconnects in a tight loop against a workspace that is down is
/// a denial of service its own owner pays for. A daemon that gives up entirely
/// is a machine that silently stops answering. So it backs off to a minute and
/// stays there, retrying forever, and every attempt is cheap.
pub fn reconnect_delay(attempt: u32) -> Duration {
    const CEILING_SECONDS: u64 = 60;
    let seconds = 1u64
        .checked_shl(attempt.min(6))
        .unwrap_or(CEILING_SECONDS)
        .min(CEILING_SECONDS);
    Duration::from_secs(seconds)
}

/// How long to sit idle before asking whether there is work anyway.
///
/// This is the other half of the no-parked-wait design D03 settled. The
/// workspace holds nothing open, so a wake that never arrives has to be caught
/// by the runner's own clock. Ten minutes by default, and bounded at both ends
/// so a preset cannot set it to zero and turn this into polling.
pub const DEFAULT_IDLE_CHECK: Duration = Duration::from_secs(10 * 60);
pub const MIN_IDLE_CHECK: Duration = Duration::from_secs(60);
pub const MAX_IDLE_CHECK: Duration = Duration::from_secs(60 * 60);

pub fn clamp_idle_check(requested: Duration) -> Duration {
    requested.clamp(MIN_IDLE_CHECK, MAX_IDLE_CHECK)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_the_frames_the_workspace_sends() {
        let welcome: ServerFrame = serde_json::from_value(json!({
            "type": "welcome", "deviceId": "device-1", "runnerEpoch": 2, "agentIds": ["agent-1"],
        }))
        .expect("a welcome parses");
        assert_eq!(
            welcome,
            ServerFrame::Welcome {
                device_id: "device-1".to_string(),
                runner_epoch: 2,
                agent_ids: vec!["agent-1".to_string()],
            },
        );

        let stop: ServerFrame = serde_json::from_value(
            json!({ "type": "stop", "agentId": "agent-1", "reason": "agent_paused" }),
        )
        .expect("a stop parses");
        assert_eq!(
            stop,
            ServerFrame::Stop {
                agent_id: "agent-1".to_string(),
                reason: "agent_paused".to_string(),
            },
        );

        let proxy = json!({
            "type": "proxy_request",
            "requestId": "request-1",
            "workspaceId": "workspace-1",
            "credentialId": "credential-1",
            "credentialVersion": 2,
            "credentialKeyEpoch": 3,
            "allowedHosts": ["api.example.com"],
            "relay": { "suite": "P256-HKDF-SHA256-AES256GCM", "ephemeralPublicKey": "public", "iv": "iv", "ciphertext": "relay" },
            "envelope": { "cipherSuite": "AES-256-GCM", "aadVersion": 1, "version": 2, "keyEpoch": 3, "iv": "iv", "ciphertext": "credential" },
            "wrap": { "custodianMemberId": "member-1", "recipientKeyEpoch": 1, "wrapSuite": "P256-HKDF-SHA256-AES256GCM", "ephemeralPublicKey": "public", "iv": "iv", "wrappedDek": "wrapped" },
        });
        assert!(matches!(
            serde_json::from_value::<ServerFrame>(proxy.clone()).expect("a proxy request parses"),
            ServerFrame::ProxyRequest { request } if request.request_id == "request-1"
        ));
        let mut widened = proxy;
        widened
            .as_object_mut()
            .unwrap()
            .insert("command".to_string(), json!("curl"));
        assert!(serde_json::from_value::<ServerFrame>(widened).is_err());
    }

    #[test]
    fn refuses_a_frame_it_does_not_understand() {
        // Not ignored: an unknown frame is a version skew, and a runner that
        // quietly drops frames is a runner that quietly stops working.
        assert!(
            serde_json::from_value::<ServerFrame>(json!({ "type": "exec", "argv": ["sh"] }))
                .is_err()
        );
        assert!(serde_json::from_value::<ServerFrame>(json!({ "no_type": true })).is_err());
    }

    #[test]
    fn backs_off_and_then_holds() {
        assert_eq!(reconnect_delay(0), Duration::from_secs(1));
        assert_eq!(reconnect_delay(3), Duration::from_secs(8));
        // It never gives up and never spins: every later attempt is a minute.
        assert_eq!(reconnect_delay(6), Duration::from_secs(60));
        assert_eq!(reconnect_delay(1_000), Duration::from_secs(60));
    }

    #[test]
    fn keeps_the_idle_check_from_becoming_polling() {
        assert_eq!(clamp_idle_check(Duration::from_secs(0)), MIN_IDLE_CHECK);
        assert_eq!(
            clamp_idle_check(Duration::from_secs(600)),
            Duration::from_secs(600)
        );
        assert_eq!(
            clamp_idle_check(Duration::from_secs(86_400)),
            MAX_IDLE_CHECK
        );
    }
}
