//! The child the CLI integration suite injects into.
//!
//! A real separate process, because that is the boundary under test: whether a
//! credential reaches a child's environment, whether a child printing one gets
//! redacted, and whether the child's exit status is the one the caller sees.
//! Nothing here is part of the product's own behaviour.

fn main() {
    let mut exit = 0;
    let mut arguments = std::env::args().skip(1);
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            // Print the value of one environment variable, which is how the
            // suite proves both injection and scrubbing.
            "--echo-env" => {
                let name = arguments.next().unwrap_or_default();
                println!(
                    "{}={}",
                    name,
                    std::env::var(&name).unwrap_or_else(|_| "<unset>".to_string())
                );
            }
            "--echo-env-stderr" => {
                let name = arguments.next().unwrap_or_default();
                eprintln!(
                    "{}={}",
                    name,
                    std::env::var(&name).unwrap_or_else(|_| "<unset>".to_string())
                );
            }
            // Print a file's contents, for the --with-file path.
            "--cat" => {
                let path = arguments.next().unwrap_or_default();
                println!(
                    "{}",
                    std::fs::read_to_string(&path).unwrap_or_else(|_| "<unreadable>".to_string())
                );
            }
            // The permission the injected file was created with, reported from
            // inside the command's lifetime so no test has to race the unlink.
            "--mode" => {
                let path = arguments.next().unwrap_or_default();
                println!("mode={}", file_mode(&path));
            }
            "--exists" => {
                let path = arguments.next().unwrap_or_default();
                println!("exists={}", std::path::Path::new(&path).exists());
            }
            "--print" => {
                println!("{}", arguments.next().unwrap_or_default());
            }
            // A value split across two writes, so the suite can prove the
            // scrubber holds bytes back across a chunk boundary.
            "--split-env" => {
                let name = arguments.next().unwrap_or_default();
                let value = std::env::var(&name).unwrap_or_default();
                let (head, tail) = value.split_at(value.len() / 2);
                print!("{head}");
                use std::io::Write;
                let _ = std::io::stdout().flush();
                std::thread::sleep(std::time::Duration::from_millis(50));
                println!("{tail}");
            }
            "--exit" => {
                exit = arguments
                    .next()
                    .and_then(|code| code.parse().ok())
                    .unwrap_or(0);
            }
            other => println!("unknown probe argument {other}"),
        }
    }
    std::process::exit(exit);
}

#[cfg(unix)]
fn file_mode(path: &str) -> String {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::metadata(path) {
        Ok(data) => format!("{:o}", data.permissions().mode() & 0o777),
        Err(_) => "missing".to_string(),
    }
}

#[cfg(not(unix))]
fn file_mode(path: &str) -> String {
    match std::path::Path::new(path).exists() {
        true => "unsupported".to_string(),
        false => "missing".to_string(),
    }
}
