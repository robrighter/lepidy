//! `lepidy-agentd` — the machine that answers when an agent is mentioned.
//!
//! The shape of this daemon is one decision, made in D03 and implemented here:
//! **nothing waits.** The workspace never holds a request open for an idle
//! agent, so an agent that does nothing all day costs nothing at all — which is
//! what makes "one human, unlimited agents" a business model rather than a
//! slogan. What replaces the parked wait is this: an outbound socket carrying
//! wakes, and the runner's own clock catching the wakes that never arrive.
//!
//! The other half is what a wake is allowed to say. It names an agent and the
//! *name* of a preset this machine already holds. It cannot name a program, an
//! argument, a directory, an environment or a permission posture, because the
//! schema has no field for one and [`trigger`] refuses any key that is not in
//! it. Launch configuration lives in [`preset`], in a file this daemon's own
//! user owns, and gets there only through a local gesture.
//!
//! So the trust runs one way. The workspace decides *that* there is work; this
//! machine decides *whether*, *how often*, *how many at once* and *for how
//! long*, and it can be told to stop by anyone with the authority to stop it.

pub mod checkup;
pub mod daemon;
pub mod policy;
pub mod preset;
pub mod process;
pub mod socket;
pub mod trigger;

pub const USAGE: &str = "\
lepidy-agentd — the local runner for Lepidy agents

  lepidy-agentd preset set ID --program PATH [--arg VALUE]... [--dir PATH]
                [--credential NAME=ENV_VAR]... [--env NAME=VALUE]...
                [--max-concurrent N] [--cooldown SECONDS] [--timeout SECONDS]
      Define what runs locally. Reads the local vault passphrase, so a daemon
      that has been reached over the network cannot change what it runs. The
      preset file is owner-only and is refused if anybody else can read it.

  lepidy-agentd preset list [--json]
      What this machine will run, and under which limits.

  lepidy-agentd preset check [ID]
      Everything about a preset that can be answered without a model: the
      program exists and can be run, the working directory is there, the limits
      are not self-defeating, the program is on the same side of a WSL boundary
      as this daemon, and the harness is the version this preset was validated
      against. Pins that version when everything passes. Reads nothing secret,
      so it needs no passphrase.

  lepidy-agentd preset remove ID
      Forget a preset. Reads the local vault passphrase.

  lepidy-agentd register --agent AGENT_ID=PRESET_ID [--agent ...]
      Tell the workspace this machine answers for these agents. One device per
      agent: registering moves an agent here and displaces whatever answered
      before, rather than quietly sharing it.

  lepidy-agentd run [--idle-check SECONDS]
      Hold the outbound socket and work the queue. Reads the local vault
      passphrase once, at startup.

  lepidy-agentd status [--json]
      What this machine is registered for, and what is pending.

  lepidy-agentd release [--reason TEXT]
      Stop answering for everything, and tell the workspace so.

No option anywhere accepts a credential value, a password or a passphrase:
command lines are readable by other processes and are captured by harness logs.
";
