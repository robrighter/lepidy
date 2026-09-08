//! What this machine will and will not start, decided here.
//!
//! Every brake is local. The workspace can say "there is work"; it cannot say
//! how often, how many at once, or for how long, because those are the three
//! numbers that decide whether a mistake upstream becomes a fork bomb on
//! somebody's laptop. A wake storm, a mention loop and an agent that answers
//! itself all arrive looking identical, and all three are stopped by the same
//! two rules.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::preset::Preset;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StartDecision {
    Start,
    /// Already at this preset's concurrency limit.
    AtCapacity {
        running: u32,
        limit: u32,
    },
    /// Started too recently.
    CoolingDown {
        remaining: Duration,
    },
    /// The runner has been told to stop working this agent.
    Stopped {
        reason: String,
    },
    /// The workspace named a preset this machine does not have.
    UnknownPreset {
        preset_id: String,
    },
    /// The trigger's revision does not match the presets this daemon loaded.
    StaleRevision {
        expected: u64,
        received: u64,
    },
}

impl StartDecision {
    pub fn is_start(&self) -> bool {
        matches!(self, Self::Start)
    }

    /// One line, for the operator watching the log.
    pub fn describe(&self) -> String {
        match self {
            Self::Start => "starting".to_string(),
            Self::AtCapacity { running, limit } => {
                format!("already running {running} of {limit} allowed")
            }
            Self::CoolingDown { remaining } => {
                format!(
                    "cooling down for another {} seconds",
                    remaining.as_secs() + 1
                )
            }
            Self::Stopped { reason } => format!("stopped: {reason}"),
            Self::UnknownPreset { preset_id } => {
                format!("no local preset named {preset_id}; refusing to guess what to run")
            }
            Self::StaleRevision { expected, received } => {
                format!("trigger is for preset revision {received}, this machine is at {expected}")
            }
        }
    }
}

/// The daemon's own bookkeeping. Nothing here is persisted: a restarted runner
/// is a machine with nothing running, and pretending otherwise would leave it
/// refusing to start work because of processes that died with the last process.
pub struct LocalPolicy {
    running: HashMap<String, u32>,
    last_start: HashMap<String, Instant>,
    stopped: HashMap<String, String>,
    revision: u64,
}

impl LocalPolicy {
    pub fn new(revision: u64) -> Self {
        Self {
            running: HashMap::new(),
            last_start: HashMap::new(),
            stopped: HashMap::new(),
            revision,
        }
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// A preset file edited underneath a running daemon.
    pub fn set_revision(&mut self, revision: u64) {
        self.revision = revision;
    }

    pub fn running_for(&self, agent_id: &str) -> u32 {
        self.running.get(agent_id).copied().unwrap_or(0)
    }

    pub fn total_running(&self) -> u32 {
        self.running.values().sum()
    }

    /// A `stop` frame, or a connection this runner no longer holds.
    pub fn stop(&mut self, agent_id: &str, reason: &str) {
        self.stopped
            .insert(agent_id.to_string(), reason.to_string());
    }

    /// An agent starts working again only when a person or a registration says
    /// so — never because a stop frame stopped arriving.
    pub fn resume(&mut self, agent_id: &str) {
        self.stopped.remove(agent_id);
    }

    pub fn is_stopped(&self, agent_id: &str) -> Option<&str> {
        self.stopped.get(agent_id).map(String::as_str)
    }

    /// The whole of the local decision, in the order the answers matter.
    ///
    /// Stopped first: an agent that has been switched off must not be started
    /// even by a preset that is otherwise ready. Then the preset must exist and
    /// match, because a trigger naming something this machine does not have is
    /// the case where a compromised workspace is trying to run something. Then
    /// the two rate rules.
    pub fn decide(
        &self,
        agent_id: &str,
        preset_id: &str,
        config_revision: u64,
        preset: Option<&Preset>,
        now: Instant,
    ) -> StartDecision {
        if let Some(reason) = self.is_stopped(agent_id) {
            return StartDecision::Stopped {
                reason: reason.to_string(),
            };
        }
        let Some(preset) = preset else {
            return StartDecision::UnknownPreset {
                preset_id: preset_id.to_string(),
            };
        };
        if config_revision != self.revision {
            return StartDecision::StaleRevision {
                expected: self.revision,
                received: config_revision,
            };
        }
        let running = self.running_for(agent_id);
        if running >= preset.max_concurrent {
            return StartDecision::AtCapacity {
                running,
                limit: preset.max_concurrent,
            };
        }
        if let Some(last) = self.last_start.get(agent_id) {
            let cooldown = Duration::from_secs(preset.cooldown_seconds);
            let elapsed = now.saturating_duration_since(*last);
            if elapsed < cooldown {
                return StartDecision::CoolingDown {
                    remaining: cooldown - elapsed,
                };
            }
        }
        StartDecision::Start
    }

    pub fn record_start(&mut self, agent_id: &str, now: Instant) {
        *self.running.entry(agent_id.to_string()).or_insert(0) += 1;
        self.last_start.insert(agent_id.to_string(), now);
    }

    pub fn record_exit(&mut self, agent_id: &str) {
        if let Some(count) = self.running.get_mut(agent_id) {
            *count = count.saturating_sub(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn preset(max_concurrent: u32, cooldown_seconds: u64) -> Preset {
        Preset {
            id: "preset-default".to_string(),
            program: "harness".to_string(),
            args: Vec::new(),
            working_directory: None,
            credentials: BTreeMap::new(),
            environment: BTreeMap::new(),
            harness_version: None,
            max_concurrent,
            cooldown_seconds,
            timeout_seconds: 60,
        }
    }

    #[test]
    fn starts_when_nothing_is_in_the_way() {
        let policy = LocalPolicy::new(1);
        let decision = policy.decide(
            "agent-1",
            "preset-default",
            1,
            Some(&preset(1, 15)),
            Instant::now(),
        );
        assert_eq!(decision, StartDecision::Start);
    }

    #[test]
    fn refuses_a_preset_this_machine_does_not_have() {
        let policy = LocalPolicy::new(1);
        // The case that matters: a workspace naming something unknown is either
        // a stale registration or an attempt to run something. Either way this
        // machine does not guess.
        let decision = policy.decide("agent-1", "preset-unknown", 1, None, Instant::now());
        assert_eq!(
            decision,
            StartDecision::UnknownPreset {
                preset_id: "preset-unknown".to_string()
            }
        );
    }

    #[test]
    fn refuses_a_trigger_for_a_revision_this_machine_has_moved_past() {
        let policy = LocalPolicy::new(4);
        let decision = policy.decide(
            "agent-1",
            "preset-default",
            3,
            Some(&preset(1, 0)),
            Instant::now(),
        );
        assert_eq!(
            decision,
            StartDecision::StaleRevision {
                expected: 4,
                received: 3
            }
        );
    }

    #[test]
    fn holds_at_the_concurrency_limit_and_releases_on_exit() {
        let mut policy = LocalPolicy::new(1);
        let now = Instant::now();
        policy.record_start("agent-1", now);
        assert_eq!(
            policy.decide("agent-1", "preset-default", 1, Some(&preset(1, 0)), now),
            StartDecision::AtCapacity {
                running: 1,
                limit: 1
            },
        );
        // A second agent is unaffected: the limit is per agent, because two
        // agents sharing one machine are not competing for the same work.
        assert_eq!(
            policy.decide("agent-2", "preset-default", 1, Some(&preset(1, 0)), now),
            StartDecision::Start,
        );
        policy.record_exit("agent-1");
        assert_eq!(
            policy.decide("agent-1", "preset-default", 1, Some(&preset(1, 0)), now),
            StartDecision::Start,
        );
    }

    #[test]
    fn cools_down_between_starts() {
        let mut policy = LocalPolicy::new(1);
        let start = Instant::now();
        policy.record_start("agent-1", start);
        policy.record_exit("agent-1");
        // A wake storm arrives as many triggers in a moment. The concurrency
        // limit alone would let them run one after another as fast as they
        // finish; the cooldown is what makes that stop.
        let decision = policy.decide("agent-1", "preset-default", 1, Some(&preset(1, 30)), start);
        assert!(
            matches!(decision, StartDecision::CoolingDown { .. }),
            "{decision:?}"
        );
        let later = start + Duration::from_secs(31);
        assert_eq!(
            policy.decide("agent-1", "preset-default", 1, Some(&preset(1, 30)), later),
            StartDecision::Start,
        );
    }

    #[test]
    fn a_stopped_agent_stays_stopped_until_something_says_otherwise() {
        let mut policy = LocalPolicy::new(1);
        policy.stop("agent-1", "delegation_revoked");
        let decision = policy.decide(
            "agent-1",
            "preset-default",
            1,
            Some(&preset(4, 0)),
            Instant::now(),
        );
        assert_eq!(
            decision,
            StartDecision::Stopped {
                reason: "delegation_revoked".to_string()
            },
        );
        // Not un-stopped by silence, by a reconnection, or by a new wake: only
        // by something explicitly saying so.
        policy.resume("agent-1");
        assert_eq!(
            policy.decide(
                "agent-1",
                "preset-default",
                1,
                Some(&preset(4, 0)),
                Instant::now()
            ),
            StartDecision::Start,
        );
    }

    #[test]
    fn being_stopped_outranks_every_other_answer() {
        let mut policy = LocalPolicy::new(9);
        policy.stop("agent-1", "agent_paused");
        // Unknown preset, stale revision and no capacity all apply too. The
        // stop is still the answer, because it is the one about authority.
        let decision = policy.decide("agent-1", "preset-gone", 1, None, Instant::now());
        assert!(
            matches!(decision, StartDecision::Stopped { .. }),
            "{decision:?}"
        );
    }
}
