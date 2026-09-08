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
pub mod capture;
pub mod client;
pub mod crypto;
pub mod envfile;
pub mod error;
pub mod import;
pub mod list;
pub mod login;
pub mod profile;
pub mod prompt;
pub mod proxy;
pub mod recover;
pub mod recovery;
pub mod rotate;
pub mod run;
pub mod scrub;
pub mod seal;
pub mod session;
pub mod template;
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
             [--policy-project ID] [--high-risk] [--kind opaque|structured]
             [--field NAME] [--rotate-at YYYY-MM-DD]
      Create a credential. Reads the local vault passphrase, the account
      password and the value, in that order. The value is encrypted here.
      A structured credential's value is one JSON object carrying every named
      field, and injects as NAME_FIELD for each of them.

  lepidy capture NAME [--description TEXT] [--tag T] -- COMMAND...
      Run a command and store its standard output as a new credential, without
      the value passing through this terminal or an agent's context. Create-only,
      and what it creates is switched off until a custodian confirms it. New
      credentials land inject-only and ask-every-time; a human loosens them.

  lepidy import PATH [--tag T] [--dry-run] [--shred]
      Create a credential for each entry in a `.env` file. Create-only: an
      existing name is reported and skipped. Values are never printed, only
      lengths. The source file stays where it is unless --shred is given.

  lepidy rotate NAME
      Replace a value with a new one, as a new version with a new key. Rotation
      is deliberately something only a person does: `capture` is create-only so
      that a prompt-injected agent cannot swap a token for somebody else's.

  lepidy recover
      Recover a replacement device with the user-held code, rotate every
      custodian wrap, and print a new recovery code. All cryptography stays here.

  lepidy run [--with NAME] [--with-file NAME:PATH] [--with-template SRC=PATH]
             [--all-tagged TAG] --origin-channel ID --origin-message ID
             --reason TEXT [--project ID] [--scrub auto|always|never] -- COMMAND...
      Release credentials for one command and run it. Reads the local vault
      passphrase first; the rest of standard input belongs to the command.
      --reason is mandatory: it is what the person deciding actually reads.
      --all-tagged injects a whole tagged group under one approval, and
      --with-template renders ${lepidy:NAME} placeholders from SRC into an
      owner-only PATH that is removed when the command exits.

Exit codes: 0 or the command's own; 77 refused; 78 needs a human's approval;
2 usage; 1 failure.

No option anywhere accepts a credential value, a password or a passphrase:
command lines are readable by other processes and are captured by harness logs.
";
