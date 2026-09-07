use std::process::ExitCode;

use lepidy_cli::args::Args;
use lepidy_cli::error::{CliError, EXIT_USAGE};
use lepidy_cli::{add, list, login, run, USAGE};

/// Flags that stand alone. Everything else takes the next argument, and none of
/// them may be a credential.
const FLAGS: &[&str] = &["json", "high-risk", "help"];

fn main() -> ExitCode {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    let code = match dispatch(&raw) {
        Ok(code) => code,
        Err(error) => {
            error.report();
            if error.code == EXIT_USAGE {
                eprintln!();
                eprint!("{USAGE}");
            }
            error.code
        }
    };
    // Codes above 255 do not survive the platform's exit status anyway, and a
    // child's code is already inside that range.
    ExitCode::from(u8::try_from(code).unwrap_or(1))
}

fn dispatch(raw: &[String]) -> Result<i32, CliError> {
    let Some(command) = raw.first() else {
        print!("{USAGE}");
        return Ok(0);
    };
    if command == "--help" || command == "-h" || command == "help" {
        print!("{USAGE}");
        return Ok(0);
    }
    let args = Args::parse(&raw[1..], FLAGS)?;
    if args.flag("help") {
        print!("{USAGE}");
        return Ok(0);
    }
    match command.as_str() {
        "login" => login::run(&args),
        "list" => list::run(&args),
        "add" => add::run(&args),
        "run" => run::run(&args),
        other => Err(CliError::usage(format!(
            "{other:?} is not a lepidy command"
        ))),
    }
}
