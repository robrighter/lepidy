//! What this window shows when it cannot reach the workspace.
//!
//! The interesting part of an offline fallback in *this* product is not the
//! page. It is that the machine may still be working while the window cannot
//! see it: the runner holds its own outbound socket to the workspace object and
//! has never needed this window, so "my laptop is offline" and "my agents have
//! stopped" are different facts and a person deciding whether to worry acts on
//! the difference.
//!
//! So the fallback says exactly what is true locally, and it is generated
//! natively from the supervisor's own state rather than written into the
//! bundled document, because a fixed sentence would eventually be the wrong one.
//!
//! ## The fallback page has no native privileges, deliberately
//!
//! The bundled document is served from the application's own local scheme, not
//! from the trusted origin, so [`crate::ipc::require_trusted_caller`] refuses
//! every command to it — including `runner_stop`. That is not an oversight and
//! it is not fixed by adding an exception: the whole reason the origin check is
//! worth having is that it has none, and a local page that could stop the
//! runner would be a local page worth navigating somebody to.
//!
//! The stop stays reachable anyway, which is the point of §10.4 giving it four
//! paths: the tray menu is right there in the same process, the CLI works on
//! the machine, and the web app and push action work from any other device. The
//! fallback page's job is to *say* that, so a person looking at a window that
//! cannot reach the workspace knows where the stop is.

use crate::supervisor::RunnerState;

/// Which document the window is showing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Presentation {
    /// The workspace, on the trusted origin.
    Workspace,
    /// The bundled fallback, because the origin could not be reached.
    Fallback,
}

/// Decide what to show after a load either succeeded or did not.
///
/// A load failure is the only thing that puts this window on the fallback. In
/// particular an HTTP error *from* the workspace is not one: a 500 or a sign-in
/// redirect is the workspace talking, and replacing it with "you are offline"
/// would tell a person the wrong thing about where the problem is.
pub fn presentation(load_succeeded: bool) -> Presentation {
    if load_succeeded {
        Presentation::Workspace
    } else {
        Presentation::Fallback
    }
}

/// What the fallback says about this machine, in one sentence per fact.
///
/// Derived from the supervisor, so it cannot overstate. The three states read
/// differently on purpose — a runner that exited on its own is not a runner
/// somebody stopped, and a person deciding whether their agents are covered
/// needs that distinction more than they need a tidy message.
pub fn fallback_status(runner: RunnerState) -> String {
    let local = match runner {
        RunnerState::Running => {
            "The runner on this machine is still answering. It has its own \
             connection to the workspace and does not need this window."
        }
        RunnerState::Stopped => {
            "The runner on this machine is stopped. Nothing here is answering \
             for your agents."
        }
        RunnerState::Exited { .. } => {
            "The runner on this machine stopped unexpectedly. Nothing here is \
             answering for your agents."
        }
    };
    format!(
        "Lepidy cannot reach your workspace from this computer. {local} \
         The stop is on the Lepidy tray icon, in `lepidy agentd stop` in a \
         terminal, and in the web app on another device.",
    )
}

/// The tray tooltip while the window is on the fallback.
pub fn fallback_tooltip(runner: RunnerState) -> String {
    format!("Lepidy — offline · {}", runner.label())
}

/// Where the bundled fallback document lives, on this platform.
///
/// Tauri serves an application's own bundle over a custom scheme everywhere
/// except Windows, where a custom scheme cannot carry cookies and it uses a
/// fixed http host instead. Getting this wrong would mean the offline fallback
/// navigating to a URL that does not exist — which is the one moment the window
/// has nowhere else to go.
pub fn fallback_url() -> &'static str {
    if cfg!(windows) {
        "http://tauri.localhost/index.html"
    } else {
        "tauri://localhost/index.html"
    }
}

/// Is this URL the bundled fallback document, and nothing else?
///
/// The window's navigation guard admits exactly two things: the trusted origin,
/// and this. So this check has to be as narrow as the origin check is — the
/// application's own scheme is not a licence to load anything served under it,
/// and `tauri.localhost.evil.test` is the same trick the origin check refuses.
///
/// Being admitted here is **not** being trusted: `require_trusted_caller` still
/// refuses every native command to this document, because it is not the trusted
/// origin. It is admitted so the window can show it, and nothing more.
pub fn is_fallback_document(url: &str) -> bool {
    let Some((scheme, rest)) = url.trim().split_once("://") else {
        return false;
    };
    // The three shapes Tauri serves its own bundle under, across the platforms.
    if !matches!(
        scheme.to_ascii_lowercase().as_str(),
        "tauri" | "http" | "https"
    ) {
        return false;
    }
    let (authority, path) = match rest.split_once('/') {
        Some((authority, path)) => (authority, format!("/{path}")),
        None => (rest, "/".to_string()),
    };
    // Exact hosts. A prefix or suffix check here would admit
    // `tauri.localhost.evil.test`, which is the whole reason the origin check
    // compares authorities rather than strings.
    if !matches!(
        authority.to_ascii_lowercase().as_str(),
        "localhost" | "tauri.localhost"
    ) {
        return false;
    }
    matches!(path.as_str(), "/" | "/index.html")
}

/// How long a load of the workspace may be outstanding before this window
/// stops waiting and says so.
///
/// Long enough that a slow network is not called an outage, short enough that
/// nobody sits in front of a blank window wondering. A person who is offline
/// finds out in twelve seconds instead of never.
pub const LOAD_GRACE_MS: u64 = 12_000;

/// Whether a load of the workspace is still outstanding, and for how long.
///
/// A tiny state machine rather than a timer, so the decision it makes is a
/// function of two numbers and can be exercised without waiting for any of them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LoadWatch {
    started_ms: Option<u64>,
    attempts: u32,
}

impl LoadWatch {
    pub fn new() -> Self {
        Self::default()
    }

    /// The window began loading the workspace.
    pub fn started(&mut self, now_ms: u64) {
        self.started_ms = Some(now_ms);
        self.attempts = self.attempts.saturating_add(1);
    }

    /// The workspace answered. Anything outstanding is no longer outstanding,
    /// and the next failure starts its backoff from the beginning.
    pub fn finished(&mut self) {
        self.started_ms = None;
        self.attempts = 0;
    }

    /// The shell stopped waiting and showed the fallback.
    ///
    /// Distinct from [`LoadWatch::finished`] because the attempt count survives:
    /// a workspace that has not answered four times running is backed off, and
    /// a give-up that reset the count would retry every two seconds forever.
    pub fn gave_up(&mut self) {
        self.started_ms = None;
    }

    /// Has the workspace failed to answer for long enough to say so?
    pub fn timed_out(&self, now_ms: u64) -> bool {
        self.started_ms
            .is_some_and(|started| now_ms.saturating_sub(started) >= LOAD_GRACE_MS)
    }

    pub fn attempts(&self) -> u32 {
        self.attempts
    }
}

/// How long to wait before trying the workspace again.
///
/// Doubling, capped at five minutes. The cap matters more than the curve: a
/// laptop that is shut for a weekend must not come back to a window that
/// decided to retry once an hour, and a workspace that is genuinely down must
/// not be retried by every desktop in a company twice a second.
pub fn retry_delay_ms(attempt: u32) -> u64 {
    const FIRST: u64 = 2_000;
    const CAP: u64 = 300_000;
    FIRST.saturating_mul(1u64 << attempt.min(8)).min(CAP)
}

/// An initialisation script that writes the status into the bundled document.
///
/// The status is native text, but it is interpolated into a script, so it is
/// encoded rather than concatenated — and it is assigned to `textContent`, so
/// even a string that got here carrying markup is shown as characters. Two
/// belts for one small thing, because this is the one place where native text
/// crosses into a page.
pub fn status_script(status: &str) -> String {
    format!(
        "(() => {{ const set = () => {{ const node = document.getElementById('state'); \
         if (node) node.textContent = {}; }}; \
         if (document.readyState === 'loading') \
         addEventListener('DOMContentLoaded', set, {{ once: true }}); else set(); }})();",
        encode(status),
    )
}

/// A JavaScript string literal for `value`.
///
/// Hand-written rather than reached for from a serialiser because the two
/// characters that matter here are not the ones JSON cares about: `<` closes a
/// script element in some parsers, and U+2028/U+2029 are line terminators in
/// JavaScript but ordinary characters in JSON.
fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '<' => out.push_str("\\u003c"),
            '>' => out.push_str("\\u003e"),
            '&' => out.push_str("\\u0026"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            character if character.is_control() => {
                out.push_str(&format!("\\u{:04x}", character as u32));
            }
            character => out.push(character),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_failure_to_load_puts_the_window_on_the_fallback() {
        assert_eq!(presentation(true), Presentation::Workspace);
        assert_eq!(presentation(false), Presentation::Fallback);
    }

    #[test]
    fn never_says_the_agents_are_stopped_when_they_are_not() {
        // The distinction this whole file exists for. An unreachable workspace
        // says nothing about whether the runner on this desk is answering.
        let running = fallback_status(RunnerState::Running);
        assert!(running.contains("still answering"), "{running}");
        assert!(!running.contains("Nothing here is answering"), "{running}");

        let stopped = fallback_status(RunnerState::Stopped);
        assert!(stopped.contains("Nothing here is answering"), "{stopped}");

        // Exited is its own sentence: a runner that died is not a runner
        // somebody stopped.
        let exited = fallback_status(RunnerState::Exited { code: 9 });
        assert!(exited.contains("stopped unexpectedly"), "{exited}");
        assert_ne!(exited, stopped);
    }

    #[test]
    fn always_names_where_the_stop_still_is() {
        // The fallback page has no native privileges, so it cannot carry a stop
        // button. It has to say where the stop is instead.
        for state in [
            RunnerState::Running,
            RunnerState::Stopped,
            RunnerState::Exited { code: 1 },
        ] {
            let status = fallback_status(state);
            assert!(status.contains("tray"), "{status}");
            assert!(status.contains("agentd stop"), "{status}");
            assert!(status.contains("web app"), "{status}");
        }
    }

    #[test]
    fn the_status_reaches_the_page_as_characters_and_not_as_code() {
        let script = status_script("</script><img src=x onerror=alert(1)> \u{2028} \"quoted\"");
        // Nothing that could close the script element or start a new statement
        // survives the encoder.
        assert!(!script.contains("</script>"), "{script}");
        assert!(!script.contains('\u{2028}'), "{script}");
        assert!(script.contains("\\u003c"), "{script}");
        // And it lands as text, not as markup, even so.
        assert!(script.contains("textContent"), "{script}");
        assert!(!script.contains("innerHTML"), "{script}");
    }

    #[test]
    fn the_url_it_navigates_to_is_one_the_guard_admits() {
        // The two halves of this have to agree on every platform, or the window
        // navigates itself into a refusal at the one moment it has nowhere
        // else to go.
        assert!(is_fallback_document(fallback_url()), "{}", fallback_url());
    }

    #[test]
    fn admits_the_bundled_document_and_no_other_local_page() {
        for url in [
            "tauri://localhost",
            "tauri://localhost/",
            "tauri://localhost/index.html",
            // Windows serves the bundle over http on a fixed host.
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/",
        ] {
            assert!(is_fallback_document(url), "{url} was refused");
        }
        for url in [
            // The look-alike the origin check exists to refuse, in local dress.
            "https://tauri.localhost.evil.test/index.html",
            "https://evil.test/index.html",
            // Any other bundled page. The fallback is one document.
            "tauri://localhost/settings.html",
            "tauri://localhost/../../etc/passwd",
            "tauri://localhost/index.html?next=https://evil.test",
            "file:///index.html",
            "data:text/html,<script>1</script>",
            "javascript:fetch('/steal')",
        ] {
            assert!(!is_fallback_document(url), "{url} was admitted");
        }
    }

    #[test]
    fn stops_waiting_after_the_grace_period_and_not_before() {
        let mut watch = LoadWatch::new();
        assert!(!watch.timed_out(1_000_000), "nothing is loading");
        watch.started(1_000);
        assert!(!watch.timed_out(1_000 + LOAD_GRACE_MS - 1));
        assert!(watch.timed_out(1_000 + LOAD_GRACE_MS));
        // A workspace that answered clears the watch, so a later moment does
        // not retroactively become an outage.
        watch.finished();
        assert!(!watch.timed_out(u64::MAX));
        assert_eq!(watch.attempts(), 0);
    }

    #[test]
    fn giving_up_keeps_the_count_that_paces_the_retries() {
        let mut watch = LoadWatch::new();
        watch.started(0);
        watch.gave_up();
        assert!(
            !watch.timed_out(u64::MAX),
            "the fallback is already showing"
        );
        assert_eq!(watch.attempts(), 1);
        watch.started(LOAD_GRACE_MS);
        watch.gave_up();
        // Backing off, rather than retrying every two seconds forever.
        assert_eq!(watch.attempts(), 2);
        assert!(retry_delay_ms(watch.attempts()) > retry_delay_ms(1));
        // And one success puts it back to the beginning.
        watch.started(0);
        watch.finished();
        assert_eq!(watch.attempts(), 0);
    }

    #[test]
    fn retries_back_off_and_stop_backing_off() {
        assert_eq!(retry_delay_ms(0), 2_000);
        assert_eq!(retry_delay_ms(1), 4_000);
        assert_eq!(retry_delay_ms(3), 16_000);
        // Capped: a laptop shut for a weekend comes back to a window that is
        // still trying, and a workspace that is down is not hammered.
        assert_eq!(retry_delay_ms(8), 300_000);
        assert_eq!(retry_delay_ms(u32::MAX), 300_000);
        let mut previous = 0;
        for attempt in 0..40 {
            let delay = retry_delay_ms(attempt);
            assert!(delay >= previous, "backoff went backwards at {attempt}");
            assert!(delay <= 300_000);
            previous = delay;
        }
    }

    #[test]
    fn the_tooltip_distinguishes_offline_from_stopped() {
        let tooltip = fallback_tooltip(RunnerState::Running);
        assert!(tooltip.contains("offline"), "{tooltip}");
        assert!(tooltip.contains("answering"), "{tooltip}");
    }
}
