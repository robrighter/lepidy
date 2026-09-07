//! The remote trigger schema, mirrored.
//!
//! The workspace's copy of this lives in `src/domain/local-agent-trigger.ts`
//! and the two must agree exactly, because the guarantee only holds at the
//! narrower end. A field the server would never send but this side would accept
//! is a field an attacker who reaches the socket can use.
//!
//! What a trigger may say is: which workspace, which agent, which device, the
//! *name* of a preset this machine already holds, that preset's revision, and a
//! request id. What it may not say is anything about what runs — there is no
//! field for an executable, an argument, a working directory, an environment
//! mapping or a permission posture, and an unknown key is a hard refusal rather
//! than something ignored.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

/// Every key a trigger may carry. Kept as a list rather than left implicit in
/// the struct so the refusal message can name what was unexpected.
pub const TRIGGER_KEYS: [&str; 6] = [
    "workspaceId",
    "agentId",
    "deviceId",
    "presetId",
    "configRevision",
    "requestId",
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteTrigger {
    pub workspace_id: String,
    pub agent_id: String,
    pub device_id: String,
    pub preset_id: String,
    pub config_revision: u64,
    pub request_id: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum TriggerError {
    NotAnObject,
    UnexpectedKeys(Vec<String>),
    InvalidField(&'static str),
}

impl std::fmt::Display for TriggerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotAnObject => write!(f, "invalid local agent trigger"),
            Self::UnexpectedKeys(keys) => {
                write!(
                    f,
                    "remote launch configuration is forbidden: {}",
                    keys.join(", ")
                )
            }
            Self::InvalidField(field) => write!(f, "invalid {field}"),
        }
    }
}

impl std::error::Error for TriggerError {}

/// Parse one trigger, refusing anything the schema does not name.
///
/// The unexpected-key check is done before deserialisation so the error can say
/// which keys were refused. `deny_unknown_fields` would catch them too; both are
/// here because this is the boundary the whole "the cloud never says what to
/// run" promise rests on, and it should fail for a legible reason.
pub fn parse_remote_trigger(value: &serde_json::Value) -> Result<RemoteTrigger, TriggerError> {
    let object = value.as_object().ok_or(TriggerError::NotAnObject)?;
    let allowed: BTreeSet<&str> = TRIGGER_KEYS.into_iter().collect();
    let unexpected: Vec<String> = object
        .keys()
        .filter(|key| !allowed.contains(key.as_str()))
        .cloned()
        .collect();
    if !unexpected.is_empty() {
        return Err(TriggerError::UnexpectedKeys(unexpected));
    }

    for key in [
        "workspaceId",
        "agentId",
        "deviceId",
        "presetId",
        "requestId",
    ] {
        let present = object.get(key).and_then(serde_json::Value::as_str);
        if present.is_none_or(str::is_empty) {
            return Err(TriggerError::InvalidField(match key {
                "workspaceId" => "workspaceId",
                "agentId" => "agentId",
                "deviceId" => "deviceId",
                "presetId" => "presetId",
                _ => "requestId",
            }));
        }
    }
    let revision = object
        .get("configRevision")
        .and_then(serde_json::Value::as_u64);
    if revision.is_none_or(|value| value < 1) {
        return Err(TriggerError::InvalidField("configRevision"));
    }

    serde_json::from_value::<RemoteTrigger>(value.clone()).map_err(|_| TriggerError::NotAnObject)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn valid() -> serde_json::Value {
        json!({
            "workspaceId": "workspace-1",
            "agentId": "agent-1",
            "deviceId": "device-1",
            "presetId": "preset-default",
            "configRevision": 3,
            "requestId": "request-1",
        })
    }

    #[test]
    fn accepts_exactly_the_schema() {
        let parsed = parse_remote_trigger(&valid()).expect("the schema's own shape parses");
        assert_eq!(parsed.preset_id, "preset-default");
        assert_eq!(parsed.config_revision, 3);
    }

    #[test]
    fn refuses_anything_that_describes_what_to_run() {
        // The keys a compromised or malicious workspace would most want. None of
        // them is ignored; each one fails the whole trigger.
        for smuggled in [
            "command",
            "args",
            "argv",
            "cwd",
            "env",
            "permissionMode",
            "dangerouslySkipPermissions",
            "executable",
        ] {
            let mut value = valid();
            value
                .as_object_mut()
                .expect("valid() is an object")
                .insert(smuggled.to_string(), json!("anything at all"));
            let error = parse_remote_trigger(&value).expect_err("an extra key must be refused");
            assert_eq!(
                error,
                TriggerError::UnexpectedKeys(vec![smuggled.to_string()]),
                "{smuggled} was not refused",
            );
        }
    }

    #[test]
    fn refuses_missing_or_empty_fields() {
        for key in [
            "workspaceId",
            "agentId",
            "deviceId",
            "presetId",
            "requestId",
        ] {
            let mut value = valid();
            value
                .as_object_mut()
                .expect("valid() is an object")
                .insert(key.to_string(), json!(""));
            assert!(
                parse_remote_trigger(&value).is_err(),
                "empty {key} was accepted"
            );

            let mut value = valid();
            value
                .as_object_mut()
                .expect("valid() is an object")
                .remove(key);
            assert!(
                parse_remote_trigger(&value).is_err(),
                "missing {key} was accepted"
            );
        }
    }

    #[test]
    fn refuses_a_revision_that_is_not_a_positive_whole_number() {
        for revision in [json!(0), json!(-1), json!("3"), json!(1.5), json!(null)] {
            let mut value = valid();
            value
                .as_object_mut()
                .expect("valid() is an object")
                .insert("configRevision".to_string(), revision.clone());
            assert!(
                parse_remote_trigger(&value).is_err(),
                "configRevision {revision} was accepted",
            );
        }
    }

    #[test]
    fn refuses_a_trigger_that_is_not_an_object() {
        for value in [json!(null), json!([]), json!("preset"), json!(7)] {
            assert_eq!(parse_remote_trigger(&value), Err(TriggerError::NotAnObject));
        }
    }
}
