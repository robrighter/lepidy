//! The Lepidy local credential CLI.
//!
//! Four commands — `login`, `list`, `add`, `run` — over one boundary: signed
//! HTTPS to the workspace, and every decryption on this machine. The workspace
//! decides whether a value may be released and records that it was; it never
//! holds the key that opens one.
//!
//! The library half exists so the integration suite can build the same
//! envelopes and wraps the CLI does and drive the compiled binary against a
//! disposable local double.

pub mod add;
pub mod args;
pub mod client;
pub mod crypto;
pub mod error;
pub mod list;
pub mod login;
pub mod profile;
pub mod prompt;
pub mod run;
pub mod scrub;
pub mod session;
pub mod withfile;

pub const USAGE: &str = "\
lepidy — local credential injection for Lepidy workspaces

  lepidy login --server URL --workspace SLUG [--label NAME] [--project ID] [--kind client|runner]
      Enrol this machine. Reads the account email, the account password and a
      new local vault passphrase, in that order, from the terminal or standard
      input. Prints a recovery code once.

  lepidy list [--json] [--project ID]
      Credential metadata this member can see. Never a value.

  lepidy add NAME [--description TEXT] [--env-var VAR] [--mode ask|auto|never]
             [--delivery inject,file] [--tag T] [--command C] [--proxy-host H]
             [--policy-project ID] [--high-risk]
      Create a credential. Reads the local vault passphrase, the account
      password and the value, in that order. The value is encrypted here.

  lepidy run --with NAME [--with-file NAME:PATH] --origin-channel ID
             --origin-message ID --reason TEXT [--project ID]
             [--scrub auto|always|never] -- COMMAND...
      Release credentials for one command and run it. Reads the local vault
      passphrase first; the rest of standard input belongs to the command.
      --reason is mandatory: it is what the person deciding actually reads.

Exit codes: 0 or the command's own; 77 refused; 78 needs a human's approval;
2 usage; 1 failure.

No option anywhere accepts a credential value, a password or a passphrase:
command lines are readable by other processes and are captured by harness logs.
";
