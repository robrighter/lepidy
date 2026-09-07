//! Reading the things that must never appear in `argv`.
//!
//! A passphrase, an account password and a credential value are all read here
//! and nowhere else. There is deliberately no flag that accepts any of them:
//! command lines are readable by every process on the machine, land in shell
//! history, and are captured verbatim by the harness logs this CLI exists to
//! keep credentials out of.
//!
//! At a terminal that means a prompt with the echo off. Under a pipe it means
//! one line of standard input — read a byte at a time, because `lepidy run`
//! hands the rest of stdin to the child and must not swallow it into a buffer.

use std::io::{IsTerminal, Read, Write};

use crate::error::{CliError, CliResult};

pub fn read_secret(label: &str) -> CliResult<String> {
    if std::io::stdin().is_terminal() {
        return rpassword::prompt_password(format!("{label}: "))
            .map_err(|error| CliError::failure(format!("could not read {label}: {error}")));
    }
    let line = read_line()?;
    if line.is_empty() {
        return Err(CliError::usage(format!(
            "expected {label} on standard input, but the input ended"
        )));
    }
    Ok(line)
}

pub fn read_line_field(label: &str) -> CliResult<String> {
    if std::io::stdin().is_terminal() {
        print!("{label}: ");
        std::io::stdout()
            .flush()
            .map_err(|error| CliError::failure(error.to_string()))?;
    }
    let line = read_line()?;
    if line.is_empty() {
        return Err(CliError::usage(format!(
            "expected {label} on standard input, but the input ended"
        )));
    }
    Ok(line)
}

/// One line, one byte at a time.
///
/// A `BufReader` would read ahead past the newline, and for `lepidy run` those
/// bytes belong to the child.
fn read_line() -> CliResult<String> {
    let mut stdin = std::io::stdin();
    let mut line = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        match stdin.read(&mut byte) {
            Ok(0) => break,
            Ok(_) => {
                if byte[0] == b'\n' {
                    break;
                }
                line.push(byte[0]);
            }
            Err(error) => {
                return Err(CliError::failure(format!(
                    "could not read standard input: {error}"
                )))
            }
        }
    }
    while line.last() == Some(&b'\r') {
        line.pop();
    }
    String::from_utf8(line)
        .map_err(|_| CliError::usage("standard input was not valid UTF-8".to_string()))
}
