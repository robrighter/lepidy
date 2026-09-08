//! `lepidy-agentd`.
//!
//! The daemon a person starts on their own machine. Everything it will run is
//! configured here, locally, behind the same passphrase that opens the vault —
//! so a daemon that has been reached over the network cannot change what it
//! runs, and neither can the workspace it is talking to.

use std::collections::BTreeMap;
use std::io::Write;
use std::process::ExitCode;
use std::time::{Duration, Instant};

use lepidy_cli::args::Args;
use lepidy_cli::client::{signed_headers, Client, Provenance};
use lepidy_cli::error::{CliError, CliResult, EXIT_USAGE};
use lepidy_cli::profile::{load_profile, Profile, Secrets};
use lepidy_cli::prompt::read_secret;
use lepidy_runner::daemon::{self, RunOutcome, Runner, SOCKET_PATH};
use lepidy_runner::preset::{load_presets, preset_path, save_presets_at, Preset, PresetStore};
use lepidy_runner::socket::{clamp_idle_check, reconnect_delay, ServerFrame, DEFAULT_IDLE_CHECK};
use lepidy_runner::USAGE;

const FLAGS: &[&str] = &["json", "help"];

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
    ExitCode::from(u8::try_from(code).unwrap_or(1))
}

fn dispatch(raw: &[String]) -> CliResult<i32> {
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
        "preset" => preset_command(&args),
        "register" => register_command(&args),
        "run" => run_command(&args),
        "status" => status_command(&args),
        "release" => release_command(&args),
        other => Err(CliError::usage(format!(
            "{other:?} is not a lepidy-agentd command"
        ))),
    }
}

/* -------------------------------------------------------------------------- */
/* Local launch configuration                                                  */
/* -------------------------------------------------------------------------- */

/// Prove a person is here before changing what this machine runs.
///
/// The passphrase is the local secret, checked entirely locally: unsealing the
/// keystore either works or it does not, and nothing about the check leaves the
/// machine. It is read from the terminal, never from `argv`.
///
/// This is presence, not identity. A biometric or platform credential — Hello,
/// Touch ID, PAM — is the stronger gesture and belongs to the native shell in
/// R03; until that exists, this is the honest version of the same guarantee
/// rather than a claim that the operating system vouched for anybody.
fn require_local_person(profile: &Profile) -> CliResult<Secrets> {
    let passphrase = read_secret("Local vault passphrase")?;
    lepidy_cli::profile::unseal(profile, &passphrase)
}

fn preset_command(args: &Args) -> CliResult<i32> {
    match args.positional(0) {
        Some("list") => {
            let store = load_presets()?;
            if args.flag("json") {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&store)
                        .map_err(|error| CliError::failure(error.to_string()))?
                );
                return Ok(0);
            }
            println!("preset file: {}", preset_path().display());
            println!("revision:    {}", store.revision);
            if store.presets.is_empty() {
                println!("\nNo presets. Nothing on this machine will run until one exists.");
            }
            for preset in &store.presets {
                println!(
                    "\n  {}\n    program:     {} {}\n    limits:      {} at once, {}s cooldown, {}s timeout\n    credentials: {}",
                    preset.id,
                    preset.program,
                    preset.args.join(" "),
                    preset.max_concurrent,
                    preset.cooldown_seconds,
                    preset.timeout_seconds,
                    if preset.credentials.is_empty() {
                        "none".to_string()
                    } else {
                        preset
                            .credentials
                            .iter()
                            .map(|(name, variable)| format!("{name} as {variable}"))
                            .collect::<Vec<_>>()
                            .join(", ")
                    },
                );
            }
            Ok(0)
        }
        Some("set") => {
            let id = args
                .positional(1)
                .ok_or_else(|| CliError::usage("preset set needs an id"))?
                .to_string();
            let profile = load_profile()?;
            let _person = require_local_person(&profile)?;

            let mut credentials = BTreeMap::new();
            for mapping in args.options("credential") {
                let (name, variable) = mapping
                    .split_once('=')
                    .ok_or_else(|| CliError::usage("--credential takes NAME=ENV_VAR"))?;
                credentials.insert(name.to_string(), variable.to_string());
            }
            let mut environment = BTreeMap::new();
            for mapping in args.options("env") {
                let (name, value) = mapping
                    .split_once('=')
                    .ok_or_else(|| CliError::usage("--env takes NAME=VALUE"))?;
                environment.insert(name.to_string(), value.to_string());
            }
            let preset = Preset {
                id: id.clone(),
                program: args.require("program")?.to_string(),
                args: args.options("arg"),
                working_directory: args.option("dir").map(str::to_string),
                credentials,
                environment,
                // Cleared by an edit on purpose: whatever was validated before
                // was validated against a different preset.
                harness_version: None,
                max_concurrent: parse_number(args.option("max-concurrent"), 1)?,
                cooldown_seconds: parse_number(args.option("cooldown"), 15)?,
                timeout_seconds: parse_number(args.option("timeout"), 30 * 60)?,
            };
            let mut store = load_presets()?;
            store.upsert(preset);
            save_presets_at(&preset_path(), &store)?;
            println!(
                "Preset {id} saved. Local configuration is now at revision {}.",
                store.revision
            );
            println!("Register again so the workspace knows this machine moved on.");
            Ok(0)
        }
        Some("remove") => {
            let id = args
                .positional(1)
                .ok_or_else(|| CliError::usage("preset remove needs an id"))?;
            let profile = load_profile()?;
            let _person = require_local_person(&profile)?;
            let mut store = load_presets()?;
            if !store.remove(id) {
                return Err(CliError::failure(format!("there is no preset named {id}")));
            }
            save_presets_at(&preset_path(), &store)?;
            println!(
                "Preset {id} removed. Local configuration is now at revision {}.",
                store.revision
            );
            Ok(0)
        }
        Some("check") => {
            let store = load_presets()?;
            let host = lepidy_runner::checkup::current_host();
            let wanted = args.positional(1);
            let presets: Vec<&Preset> = match wanted {
                Some(id) => vec![store
                    .get(id)
                    .ok_or_else(|| CliError::failure(format!("there is no preset named {id}")))?],
                None => store.presets.iter().collect(),
            };
            if presets.is_empty() {
                return Err(CliError::failure(
                    "there are no presets to check; define one with `lepidy-agentd preset set`",
                ));
            }

            let mut failed = false;
            let mut observed: Vec<(String, Option<String>)> = Vec::new();
            for preset in &presets {
                let checkup = lepidy_runner::checkup::check_preset(preset, host);
                println!("\n{}", checkup.preset_id);
                for (name, verdict) in &checkup.findings {
                    println!("  [{}] {name:<9} {}", verdict.marker(), verdict.message());
                }
                failed |= !checkup.passed();
                observed.push((checkup.preset_id.clone(), checkup.observed_version.clone()));
            }

            // Pinning happens only when everything else passed. Recording a
            // version for a preset that cannot run would be writing down that
            // something broken was validated.
            if !failed {
                let mut store = load_presets()?;
                for (preset_id, version) in observed {
                    if version.is_some() {
                        store.pin_harness_version(&preset_id, version);
                    }
                }
                save_presets_at(&preset_path(), &store)?;
                println!("\nEverything checked out. Harness versions pinned.");
                return Ok(0);
            }
            println!("\nSomething would stop this machine answering. Nothing was pinned.");
            Err(CliError::denied(
                "one or more presets would not run".to_string(),
                None,
            ))
        }
        _ => Err(CliError::usage("preset takes list, set, check or remove")),
    }
}

fn parse_number<T: std::str::FromStr>(value: Option<&str>, fallback: T) -> CliResult<T> {
    match value {
        None => Ok(fallback),
        Some(raw) => raw
            .parse::<T>()
            .map_err(|_| CliError::usage(format!("{raw:?} is not a whole number"))),
    }
}

/* -------------------------------------------------------------------------- */
/* Talking to the workspace                                                    */
/* -------------------------------------------------------------------------- */

struct Session {
    profile: Profile,
    secrets: Secrets,
    client: Client,
    presets: PresetStore,
}

fn open_session() -> CliResult<Session> {
    let profile = load_profile()?;
    let presets = load_presets()?;
    let secrets = require_local_person(&profile)?;
    let client = Client::new(&profile.server_url)?;
    Ok(Session {
        profile,
        secrets,
        client,
        presets,
    })
}

fn register_command(args: &Args) -> CliResult<i32> {
    let mut session = open_session()?;
    let mut agents = Vec::new();
    for mapping in args.options("agent") {
        let (agent_id, preset_id) = mapping
            .split_once('=')
            .ok_or_else(|| CliError::usage("--agent takes AGENT_ID=PRESET_ID"))?;
        // Refused here rather than by the workspace: a machine that registers
        // for a preset it does not have is a machine that will refuse every
        // wake it then receives, silently.
        if session.presets.get(preset_id).is_none() {
            return Err(CliError::usage(format!(
                "there is no local preset named {preset_id}; run `lepidy-agentd preset set {preset_id} --program ...` first"
            )));
        }
        agents.push((agent_id.to_string(), preset_id.to_string()));
    }
    if agents.is_empty() {
        return Err(CliError::usage("--agent AGENT_ID=PRESET_ID is required"));
    }

    let epoch = runner_epoch();
    let body = daemon::register(
        &session.client,
        &session.profile,
        &session.secrets.signing_key()?,
        &session.secrets.device_credential,
        epoch,
        session.presets.revision,
        &agents,
    )?;
    session.presets.runner_agents = agents.iter().cloned().collect();
    session.presets.runner_epoch = epoch;
    save_presets_at(&preset_path(), &session.presets)?;
    let displaced = body
        .get("displacedDeviceIds")
        .and_then(serde_json::Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    println!(
        "Registered {} agent(s) at runner epoch {epoch}, preset revision {}.",
        agents.len(),
        session.presets.revision,
    );
    if displaced > 0 {
        println!("{displaced} other device(s) were answering for these agents and have been told to stop.");
    }
    Ok(0)
}

fn status_command(args: &Args) -> CliResult<i32> {
    let session = open_session()?;
    let depths = daemon::fetch_depth(
        &session.client,
        &session.profile,
        &session.secrets.signing_key()?,
        &session.secrets.device_credential,
        session.presets.revision,
    )?;
    if args.flag("json") {
        let rendered: Vec<serde_json::Value> = depths
            .iter()
            .map(|entry| {
                serde_json::json!({
                    "agentId": entry.agent_id,
                    "presetId": entry.preset_id,
                    "depth": entry.depth,
                    "status": entry.status,
                })
            })
            .collect();
        println!(
            "{}",
            serde_json::to_string_pretty(&rendered)
                .map_err(|error| CliError::failure(error.to_string()))?
        );
        return Ok(0);
    }
    println!("device:   {}", session.profile.device_id);
    println!("revision: {}", session.presets.revision);
    if depths.is_empty() {
        println!("\nThis machine is not answering for any agent.");
    }
    for entry in &depths {
        println!(
            "  {} via {} — {} waiting ({})",
            entry.agent_id, entry.preset_id, entry.depth, entry.status,
        );
    }
    Ok(0)
}

fn release_command(args: &Args) -> CliResult<i32> {
    let session = open_session()?;
    daemon::release(
        &session.client,
        &session.profile,
        &session.secrets.signing_key()?,
        &session.secrets.device_credential,
        session.presets.revision,
        args.option("reason"),
    )?;
    println!("This machine is no longer answering for any agent.");
    Ok(0)
}

/// The identity of this run of the daemon.
///
/// Seconds since the epoch: monotonic across restarts on any machine whose
/// clock is roughly right, which is what the workspace needs to tell a restarted
/// process from the one it replaced.
fn runner_epoch() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(1)
        .max(1)
}

/* -------------------------------------------------------------------------- */
/* The loop                                                                    */
/* -------------------------------------------------------------------------- */

fn run_command(args: &Args) -> CliResult<i32> {
    let mut session = open_session()?;
    if session.presets.presets.is_empty() {
        return Err(CliError::usage(
            "there are no local presets, so nothing would run: define one with `lepidy-agentd preset set`",
        ));
    }
    // Everything answerable offline, before anything is registered. A preset
    // whose harness has been upgraded since somebody validated it is
    // unvalidated, and a machine that discovered that at the first mention
    // would discover it by failing in front of whoever asked.
    let host = lepidy_runner::checkup::current_host();
    let mut unusable = Vec::new();
    for preset in &session.presets.presets {
        let checkup = lepidy_runner::checkup::check_preset(preset, host);
        for (name, verdict) in &checkup.findings {
            match verdict {
                lepidy_runner::checkup::Verdict::Fail(message) => {
                    eprintln!("lepidy-agentd: {} [{name}] {message}", preset.id);
                }
                lepidy_runner::checkup::Verdict::Warn(message) => {
                    eprintln!("lepidy-agentd: {} [{name}] {message}", preset.id);
                }
                lepidy_runner::checkup::Verdict::Ok(_) => {}
            }
        }
        if !checkup.passed() {
            unusable.push(preset.id.clone());
        }
    }
    if !unusable.is_empty() {
        return Err(CliError::usage(format!(
            "these presets would not run: {}. Fix them, then `lepidy-agentd preset check`",
            unusable.join(", ")
        )));
    }

    let idle_check = clamp_idle_check(Duration::from_secs(parse_number(
        args.option("idle-check"),
        DEFAULT_IDLE_CHECK.as_secs(),
    )?));
    if session.presets.runner_agents.is_empty() {
        return Err(CliError::usage(
            "this machine has no saved agent assignments; run `lepidy-agentd register --agent AGENT_ID=PRESET_ID` first",
        ));
    }
    let epoch = runner_epoch().max(session.presets.runner_epoch.saturating_add(1));
    let revision = session.presets.revision;
    let signing = session.secrets.signing_key()?;
    let agents: Vec<(String, String)> = session
        .presets
        .runner_agents
        .iter()
        .map(|(agent, preset)| (agent.clone(), preset.clone()))
        .collect();
    daemon::register(
        &session.client,
        &session.profile,
        &signing,
        &session.secrets.device_credential,
        epoch,
        revision,
        &agents,
    )?;
    session.presets.runner_epoch = epoch;
    save_presets_at(&preset_path(), &session.presets)?;

    let mut runner = Runner::new(
        session.presets.clone(),
        session.profile.workspace_id.clone(),
    );
    let mut attempt: u32 = 0;
    println!(
        "lepidy-agentd: preset revision {revision}, runner epoch {epoch}, idle check every {}s.",
        idle_check.as_secs(),
    );

    loop {
        match hold_socket(&session, &signing, epoch, revision, idle_check, &mut runner) {
            Ok(()) => attempt = 0,
            Err(error) => {
                // A connection that drops costs a reconnect and a depth check,
                // and never costs work: the queue is durable and the wake this
                // runner missed is still there to be collected.
                eprintln!(
                    "lepidy-agentd: connection lost ({}); reconnecting.",
                    error.message
                );
                attempt = attempt.saturating_add(1);
            }
        }
        // Whatever happens to the socket, the queue is still checked. This is
        // what makes a lost wake cost one bounded call rather than a lost job.
        if let Err(error) = check_depth(&session, &signing, revision, &mut runner) {
            eprintln!(
                "lepidy-agentd: could not check the queue ({}).",
                error.message
            );
        }
        let _ = drain(&mut runner, &session, &signing, revision);
        std::thread::sleep(reconnect_delay(attempt));
    }
}

/// Hold the connection and act on what arrives, until it closes.
fn hold_socket(
    session: &Session,
    signing: &lepidy_cli::crypto::DeviceSigningKey,
    epoch: u64,
    revision: u64,
    idle_check: Duration,
    runner: &mut Runner,
) -> CliResult<()> {
    let headers = signed_headers(
        &session.profile,
        signing,
        &session.secrets.device_credential,
        "GET",
        SOCKET_PATH,
        &[],
        Provenance::project(&session.profile.project_id).at_revision(revision),
    )?;
    let url = socket_url(session.client.base_url(), epoch)?;

    let mut request = tungstenite::http::Request::builder()
        .method("GET")
        .uri(&url)
        .header("host", host_of(&url)?)
        .header("connection", "Upgrade")
        .header("upgrade", "websocket")
        .header("sec-websocket-version", "13")
        .header(
            "sec-websocket-key",
            tungstenite::handshake::client::generate_key(),
        );
    for (name, value) in headers {
        request = request.header(name, value);
    }
    let request = request
        .body(())
        .map_err(|error| CliError::failure(format!("could not build the upgrade: {error}")))?;

    let (mut socket, _) = tungstenite::connect(request)
        .map_err(|error| CliError::failure(format!("could not connect: {error}")))?;
    // The read timeout *is* the clock. Waiting for a frame that never comes and
    // asking the queue anyway are the same act, and doing it this way means the
    // daemon needs no second thread to hold a timer.
    set_read_deadline(
        &mut socket,
        daemon::next_tick(runner.running_count(), idle_check),
    );
    eprintln!("lepidy-agentd: connected.");
    // On connect, before waiting for anything. A wake that arrived while this
    // machine was off is durable and will be replayed, but a wake that was
    // delivered to a socket that then died is not — so the only reliable answer
    // to "did I miss anything" is to ask, every time a connection begins.
    if let Err(error) = check_depth(session, signing, revision, runner) {
        eprintln!(
            "lepidy-agentd: could not check the queue ({}).",
            error.message
        );
    }

    loop {
        let message = match socket.read() {
            Ok(message) => message,
            // The read timed out, which is the idle check arriving: nothing was
            // said, so ask instead. This is the whole of what replaces a parked
            // wait, and it is why a lost wake costs one bounded call.
            Err(error) if is_idle_timeout(&error) => {
                // Reap first. A run that finished while this was waiting frees
                // its slot and has an outcome to report, and asking the queue
                // before noticing that would find work the daemon then refuses
                // for being at capacity.
                let reaped = drain(runner, session, signing, revision);
                if reaped > 0 || runner.running_count() == 0 {
                    if let Err(error) = check_depth(session, signing, revision, runner) {
                        eprintln!(
                            "lepidy-agentd: could not check the queue ({}).",
                            error.message
                        );
                    }
                }
                set_read_deadline(
                    &mut socket,
                    daemon::next_tick(runner.running_count(), idle_check),
                );
                // A ping doubles as a liveness check on a connection that has
                // been silent: a socket that died quietly fails here rather
                // than at the next wake, which could be hours away. Only when
                // actually idle — a busy daemon is polling its children, not
                // sitting in silence.
                if runner.running_count() == 0 {
                    socket
                        .send(tungstenite::Message::Text("{\"type\":\"ping\"}".into()))
                        .map_err(|error| CliError::failure(format!("ping failed: {error}")))?;
                }
                continue;
            }
            Err(error) => return Err(CliError::failure(format!("read failed: {error}"))),
        };
        let text = match message {
            tungstenite::Message::Text(text) => text.to_string(),
            tungstenite::Message::Close(_) => return Ok(()),
            tungstenite::Message::Ping(_) | tungstenite::Message::Pong(_) => continue,
            // The workspace never sends binary. A frame this side does not
            // understand is a version skew worth reconnecting over.
            _ => continue,
        };
        let frame: ServerFrame = serde_json::from_str(&text).map_err(|error| {
            CliError::failure(format!(
                "the workspace sent a frame this runner does not understand: {error}"
            ))
        })?;
        let report = runner.apply_frame(&frame, Instant::now(), now_ms());
        announce(&report);
        // Short while anything is running and the idle check otherwise: a child
        // that exits has to be noticed promptly, because its slot stays taken
        // and its outcome unreported until it is, while a machine with nothing
        // running should be waking twice an hour rather than four times a
        // second.
        set_read_deadline(
            &mut socket,
            daemon::next_tick(runner.running_count(), idle_check),
        );
        if !report.needs_session.is_empty() {
            ensure_sessions(session, signing, revision, runner, &report.needs_session);
            // A wake that arrived before its session did is not lost: the queue
            // is the record, so one check picks the work up now rather than
            // leaving it until the idle timer comes round.
            if let Err(error) = check_depth(session, signing, revision, runner) {
                eprintln!(
                    "lepidy-agentd: could not check the queue ({}).",
                    error.message
                );
            }
        }
        // A finished process frees a slot, and the work it was answering may
        // have grown while it ran. Asking after every exit is the other half of
        // the lost-wake guarantee.
        if drain(runner, session, signing, revision) > 0 {
            if let Err(error) = check_depth(session, signing, revision, runner) {
                eprintln!(
                    "lepidy-agentd: could not check the queue ({}).",
                    error.message
                );
            }
            set_read_deadline(
                &mut socket,
                daemon::next_tick(runner.running_count(), idle_check),
            );
        }
    }
}

/// How long the next read may block before the daemon looks around by itself.
type LiveSocket = tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>;

fn set_read_deadline(socket: &mut LiveSocket, deadline: Duration) {
    match socket.get_ref() {
        tungstenite::stream::MaybeTlsStream::Plain(stream) => {
            let _ = stream.set_read_timeout(Some(deadline));
        }
        tungstenite::stream::MaybeTlsStream::Rustls(stream) => {
            let _ = stream.get_ref().set_read_timeout(Some(deadline));
        }
        _ => {}
    }
}

/// A read that expired rather than failed.
fn is_idle_timeout(error: &tungstenite::Error) -> bool {
    match error {
        tungstenite::Error::Io(io) => matches!(
            io.kind(),
            std::io::ErrorKind::WouldBlock
                | std::io::ErrorKind::TimedOut
                | std::io::ErrorKind::Interrupted
        ),
        _ => false,
    }
}

fn check_depth(
    session: &Session,
    signing: &lepidy_cli::crypto::DeviceSigningKey,
    revision: u64,
    runner: &mut Runner,
) -> CliResult<()> {
    let depths = daemon::fetch_depth(
        &session.client,
        &session.profile,
        signing,
        &session.secrets.device_credential,
        revision,
    )?;
    let report = runner.apply_depth(&depths, Instant::now(), now_ms());
    announce(&report);
    if report.needs_session.is_empty() {
        return Ok(());
    }
    // A session is minted here rather than at start time, so a harness is never
    // spawned with nothing to authenticate with. The same depths are then
    // applied again: the work was found a moment ago and is still there, and
    // making it wait for the idle timer would turn a missing session into a
    // ten-minute delay.
    ensure_sessions(session, signing, revision, runner, &report.needs_session);
    let second = runner.apply_depth(&depths, Instant::now(), now_ms());
    announce(&second);
    Ok(())
}

/// Mint a session for each agent that has work and no usable one.
///
/// One session serves many runs. Starting a harness is the expensive part, and
/// a workspace that forced a new session per mention would spend more on
/// process startup than on work — so this only ever runs when a session is
/// missing, expired, or has been refused.
fn ensure_sessions(
    session: &Session,
    signing: &lepidy_cli::crypto::DeviceSigningKey,
    revision: u64,
    runner: &mut Runner,
    agent_ids: &[String],
) {
    for agent_id in agent_ids {
        match daemon::start_session(
            &session.client,
            &session.profile,
            signing,
            &session.secrets.device_credential,
            revision,
            agent_id,
        ) {
            Ok(harness) => {
                println!("lepidy-agentd: session ready for {agent_id}.");
                runner.remember_session(harness);
            }
            Err(error) => {
                // Said out loud: an agent that cannot get a session will never
                // start, and silence there looks identical to no work.
                println!(
                    "lepidy-agentd: no session for {agent_id}: {}",
                    error.message
                );
                runner.forget_session(agent_id);
            }
        }
    }
    let _ = std::io::stdout().flush();
}

/// Milliseconds since the epoch, for comparing against a token's expiry.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

/// Reap what finished and kill what has run out of time, reporting how many
/// runs ended so the caller knows whether to ask the queue again.
fn drain(
    runner: &mut Runner,
    session: &Session,
    signing: &lepidy_cli::crypto::DeviceSigningKey,
    revision: u64,
) -> usize {
    let report = runner.reap(Instant::now());
    for (agent_id, code) in &report.exited {
        let outcome = RunOutcome::from_exit_code(*code);
        println!(
            "lepidy-agentd: {agent_id} finished with status {code} ({}).",
            outcome.as_str(),
        );
        if outcome == RunOutcome::Blocked {
            // Not a failure and not a refusal by the workspace: the harness
            // declined something under its own safe default permission
            // posture, and a person now has a decision to make.
            println!(
                "lepidy-agentd: {agent_id} was blocked by its own permission posture; its owner has been told."
            );
        }
        let Some(session_id) = runner.session_id_for(agent_id) else {
            continue;
        };
        // Only a session's own work is reported, so this cannot disturb another
        // machine's in-flight items.
        if let Err(error) = daemon::report_outcome(
            &session.client,
            &session.profile,
            signing,
            &session.secrets.device_credential,
            revision,
            (agent_id, &session_id, outcome, exit_reason(*code)),
        ) {
            println!(
                "lepidy-agentd: could not report {agent_id}'s run ({}).",
                error.message,
            );
        }
        // A session the workspace has stopped honouring is not reused: the next
        // turn mints a fresh one rather than burning a process to find out.
        if outcome == RunOutcome::Failed {
            runner.forget_session(agent_id);
        }
    }
    let _ = std::io::stdout().flush();
    report.exited.len()
}

/// A short note for the person who reads it, never the harness's own output.
fn exit_reason(code: i32) -> &'static str {
    match code {
        0 => "the harness finished",
        78 => "the harness was blocked by its permission posture",
        -1 => "the harness was stopped or could not be waited on",
        _ => "the harness exited with a failure",
    }
}

fn announce(report: &daemon::TurnReport) {
    for agent_id in &report.started {
        println!("lepidy-agentd: started work for {agent_id}.");
    }
    for (agent_id, reason) in &report.refused {
        // Printed, always. A runner that silently declines to work is
        // indistinguishable from one that has crashed.
        println!("lepidy-agentd: not starting {agent_id}: {reason}");
    }
    for agent_id in &report.stopped {
        println!("lepidy-agentd: stopped {agent_id}.");
    }
    let _ = std::io::stdout().flush();
}

/// The websocket URL for this workspace, derived from the profile's server URL.
///
/// `https` becomes `wss` and loopback `http` becomes `ws`; there is no way to
/// ask for an unencrypted socket to a remote host, the same rule the signed
/// HTTP client already enforces.
fn socket_url(base: &str, epoch: u64) -> CliResult<String> {
    lepidy_cli::client::assert_transport_is_safe(base)?;
    let socket_base = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        return Err(CliError::usage("the server URL must start with https://"));
    };
    Ok(format!("{socket_base}{SOCKET_PATH}?runner_epoch={epoch}"))
}

fn host_of(url: &str) -> CliResult<String> {
    let rest = url
        .split_once("://")
        .map(|(_, rest)| rest)
        .ok_or_else(|| CliError::usage("the server URL has no host"))?;
    Ok(rest.split('/').next().unwrap_or_default().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_the_socket_url_without_ever_downgrading_a_remote_host() {
        assert_eq!(
            socket_url("https://lepidy.example", 7).expect("https is fine"),
            "wss://lepidy.example/api/device/runner/socket?runner_epoch=7",
        );
        // Loopback in the clear is allowed so `wrangler dev` and the test
        // double can be reached; anything else is refused outright.
        assert_eq!(
            socket_url("http://127.0.0.1:3100", 1).expect("loopback is fine"),
            "ws://127.0.0.1:3100/api/device/runner/socket?runner_epoch=1",
        );
        assert!(socket_url("http://lepidy.example", 1).is_err());
    }

    #[test]
    fn reads_the_host_out_of_a_url() {
        assert_eq!(
            host_of("wss://lepidy.example/api").expect("host"),
            "lepidy.example"
        );
        assert_eq!(
            host_of("ws://127.0.0.1:3100/api").expect("host"),
            "127.0.0.1:3100"
        );
    }
}
