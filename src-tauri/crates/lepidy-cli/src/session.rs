//! Opening the local vault for one command.
//!
//! Every command except `login` starts here: read the profile, ask for the
//! passphrase, open the keystore, and hold the device key only for as long as
//! this process runs. Nothing is cached on disk and there is no agent holding
//! an unlocked key between invocations — a second command asks again.

use crate::client::Client;
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
}
