//! Opening the local vault for one command.
//!
//! Every command except `login` starts here: read the profile, ask for the
//! passphrase, open the keystore, and hold the device key only for as long as
//! this process runs. Nothing is cached on disk and there is no agent holding
//! an unlocked key between invocations — a second command asks again.

use crate::client::{Client, Provenance};
use crate::crypto::DeviceSigningKey;
use crate::error::CliResult;
use crate::profile::{load_profile, unseal, Profile, Secrets};
use crate::prompt::read_secret;

pub struct Session {
    pub profile: Profile,
    pub client: Client,
    pub signing: DeviceSigningKey,
    secrets: Secrets,
}

impl Session {
    pub fn open() -> CliResult<Self> {
        let profile = load_profile()?;
        let secret = read_secret("local vault passphrase")?;
        let secrets = unseal(&profile, &secret)?;
        let signing = secrets.signing_key()?;
        let client = Client::new(&profile.server_url)?;
        Ok(Self {
            profile,
            client,
            signing,
            secrets,
        })
    }

    pub fn device_credential(&self) -> &str {
        &self.secrets.device_credential
    }

    pub fn secrets(&self) -> &Secrets {
        &self.secrets
    }

    /// The project this command is running in.
    ///
    /// It is part of the signed claims and part of the policy decision, so a
    /// credential scoped to one project cannot be used from another simply by
    /// running the CLI somewhere else.
    pub fn project(&self, override_value: Option<&str>) -> String {
        override_value
            .unwrap_or(&self.profile.project_id)
            .to_string()
    }

    /// Bind a nested `lepidy run` to the unattended session that launched it.
    ///
    /// The runner supplies these identifiers in the environment, never argv.
    /// The workspace re-checks the exact live delegation, so locally inventing
    /// identifiers cannot widen authority. A half-present pair is refused
    /// instead of quietly falling back to person authority.
    pub fn provenance(&self, project: &str) -> CliResult<Provenance> {
        let agent_id = std::env::var("LEPIDY_AGENT_ID").ok();
        let delegation_id = std::env::var("LEPIDY_DELEGATION_ID").ok();
        match (agent_id, delegation_id) {
            (None, None) => Ok(Provenance::project(project)),
            (Some(agent_id), Some(delegation_id))
                if !agent_id.is_empty() && !delegation_id.is_empty() =>
            {
                Ok(Provenance::project(project).for_agent(
                    &agent_id,
                    &delegation_id,
                    std::env::var("LEPIDY_ORIGIN_ID").ok().as_deref(),
                ))
            }
            _ => Err(crate::error::CliError::failure(
                "the runner supplied incomplete agent provenance",
            )),
        }
    }
}
