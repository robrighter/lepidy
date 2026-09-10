//! One global chord, and it stops the runner.
//!
//! §10.4 gives the kill switch four independent paths — the web app, this
//! desktop app, the CLI, and an action on the push notification — precisely so
//! that no single one of them being unavailable is safety-critical. The global
//! hotkey is the desktop app's fastest path: it works with the window closed,
//! with the window behind something else, and on a machine whose tray the
//! desktop environment declined to render.
//!
//! Three decisions define it.
//!
//! **The action is fixed.** A global hotkey is a key that works when this
//! application is not in front of anybody, which makes it the one input that
//! cannot be aimed. So there is exactly one, its action is `stop`, and no
//! configuration path — page, deep link, or file — can point it at anything
//! else. A hotkey that could be rebound to *start* would be a machine that
//! begins answering for somebody's agents because of a keystroke in another
//! application.
//!
//! **The chord is chosen on the machine, not by the page.** It is read from the
//! environment at startup, which is the same place the daemon path and the
//! trusted origin come from, and validated by [`Chord::parse`].
//!
//! **A registration that failed is reported.** A kill switch that silently is
//! not registered is a kill switch that does not exist, and the moment a person
//! discovers that is the moment they needed it.

/// The chord this ships with.
///
/// Deliberately awkward. A global hotkey takes the key away from every other
/// application on the machine, so the cost of a comfortable chord is that it is
/// a chord somebody's editor wanted. Three modifiers and a letter is a chord
/// nothing else claims and nobody presses by accident, and this is a key that
/// stops work — an accidental press costs somebody a re-run.
pub const DEFAULT_CHORD: &str = "CommandOrControl+Alt+Shift+K";

/// The environment variable that overrides it, per machine.
pub const CHORD_ENV: &str = "LEPIDY_KILL_SWITCH";

/// A validated accelerator: at least one non-shift modifier, and one key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Chord {
    accelerator: String,
}

impl Chord {
    /// What to hand the global-shortcut registrar.
    pub fn accelerator(&self) -> &str {
        &self.accelerator
    }

    /// How to write it where a person will read it — the tray, and the shell's
    /// own settings copy.
    pub fn describe(&self) -> String {
        format!("{} stops the runner", self.accelerator)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum ChordError {
    /// No modifier, or shift alone. Either would swallow an ordinary keystroke
    /// in every other application on the machine.
    NotAChord,
    /// A modifier or key name this registrar does not know.
    Unknown(String),
    /// A chord the operating system has already claimed. Registering one of
    /// these either fails or, worse, succeeds and breaks something a person
    /// relies on.
    Reserved,
}

impl std::fmt::Display for ChordError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotAChord => write!(
                f,
                "a global shortcut needs a modifier beyond shift, and one key",
            ),
            Self::Unknown(part) => write!(f, "{part} is not a key this shortcut can use"),
            Self::Reserved => write!(f, "that shortcut belongs to the operating system"),
        }
    }
}

/// The modifiers a chord may use, in the spelling the registrar expects.
const MODIFIERS: [&str; 8] = [
    "commandorcontrol",
    "cmdorctrl",
    "command",
    "cmd",
    "control",
    "ctrl",
    "alt",
    "super",
];

/// Chords the operating systems have taken. Named rather than discovered,
/// because the failure mode of the ones that *do* register is that a person's
/// task manager or window switcher stops working and they never connect it to
/// this application.
const RESERVED: [&str; 6] = [
    "control+shift+escape",
    "control+alt+delete",
    "alt+tab",
    "command+tab",
    "command+space",
    "super+l",
];

impl Chord {
    pub fn parse(value: &str) -> Result<Self, ChordError> {
        let parts: Vec<&str> = value
            .split('+')
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .collect();
        let (key, modifiers) = parts.split_last().ok_or(ChordError::NotAChord)?;

        let mut normalised: Vec<String> = Vec::new();
        let mut has_real_modifier = false;
        for modifier in modifiers {
            let lowered = modifier.to_ascii_lowercase();
            if lowered == "shift" {
                normalised.push(lowered);
                continue;
            }
            if !MODIFIERS.contains(&lowered.as_str()) {
                return Err(ChordError::Unknown((*modifier).to_string()));
            }
            has_real_modifier = true;
            normalised.push(lowered);
        }
        // Shift alone is not a chord: `Shift+K` is how a person types a capital
        // K, and claiming it globally would take capital K away from the whole
        // machine.
        if !has_real_modifier {
            return Err(ChordError::NotAChord);
        }

        let key_lowered = key.to_ascii_lowercase();
        if !is_key(&key_lowered) {
            return Err(ChordError::Unknown((*key).to_string()));
        }
        normalised.push(key_lowered);

        // Compared after normalising, so `CmdOrCtrl+Shift+Escape` and
        // `Control+Shift+Escape` are recognised as the same reserved chord.
        let canonical = normalised
            .iter()
            .map(|part| match part.as_str() {
                "commandorcontrol" | "cmdorctrl" | "cmd" | "ctrl" => {
                    if cfg!(target_os = "macos") {
                        "command"
                    } else {
                        "control"
                    }
                }
                other => other,
            })
            .collect::<Vec<_>>()
            .join("+");
        if RESERVED.contains(&canonical.as_str()) {
            return Err(ChordError::Reserved);
        }

        Ok(Self {
            accelerator: value.trim().to_string(),
        })
    }

    /// The chord this machine will use: the environment's, or the default.
    ///
    /// A bad override is a refusal, never a silent fall back to the default. A
    /// person who mistyped their chord and got the shipped one instead would
    /// have a kill switch on a key they do not know about.
    pub fn from_environment(configured: Option<&str>) -> Result<Self, ChordError> {
        match configured.map(str::trim).filter(|value| !value.is_empty()) {
            Some(value) => Self::parse(value),
            None => Self::parse(DEFAULT_CHORD),
        }
    }
}

fn is_key(key: &str) -> bool {
    if key.len() == 1 {
        return key
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric());
    }
    if let Some(number) = key.strip_prefix('f') {
        if let Ok(index) = number.parse::<u8>() {
            return (1..=24).contains(&index);
        }
    }
    matches!(
        key,
        "escape" | "space" | "enter" | "backspace" | "delete" | "tab" | "home" | "end"
    )
}

/// What the shell says when the operating system would not give it the chord.
///
/// Written here so the message is the same wherever it is shown, and so it says
/// the true thing: the other three paths still work.
pub fn registration_failed(chord: &Chord, reason: &str) -> String {
    format!(
        "Lepidy could not register {} as the kill switch ({reason}). \
         Stop is still on the tray, in the web app, and in `lepidy agentd stop`.",
        chord.accelerator(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shipped_chord_is_a_chord() {
        let chord = Chord::from_environment(None).expect("the default parses");
        assert_eq!(chord.accelerator(), DEFAULT_CHORD);
        assert!(chord.describe().contains("stops the runner"));
    }

    #[test]
    fn a_machine_may_choose_its_own() {
        let chord = Chord::from_environment(Some(" CommandOrControl+Shift+F9 ")).expect("parses");
        assert_eq!(chord.accelerator(), "CommandOrControl+Shift+F9");
        // An empty variable is the same as not setting one.
        assert_eq!(
            Chord::from_environment(Some("   ")).expect("default"),
            Chord::parse(DEFAULT_CHORD).expect("default"),
        );
    }

    #[test]
    fn refuses_a_key_that_would_be_swallowed_everywhere() {
        // Each of these takes an ordinary keystroke away from every other
        // application on the machine.
        for value in ["K", "Escape", "Shift+K", "shift+space"] {
            assert_eq!(Chord::parse(value), Err(ChordError::NotAChord), "{value}");
        }
    }

    #[test]
    fn refuses_a_chord_the_operating_system_already_owns() {
        for value in [
            "Control+Shift+Escape",
            "CommandOrControl+Shift+Escape",
            "Control+Alt+Delete",
            "Alt+Tab",
            "Super+L",
        ] {
            let result = Chord::parse(value);
            // On macOS `CommandOrControl` canonicalises to command, so the
            // Windows task-manager chord is not reserved there; it must still
            // be a *valid* chord either way, never silently accepted as one of
            // the platform's own.
            if cfg!(target_os = "macos") && value.starts_with("CommandOrControl") {
                assert!(result.is_ok(), "{value}");
            } else {
                assert_eq!(result, Err(ChordError::Reserved), "{value}");
            }
        }
    }

    #[test]
    fn refuses_a_name_the_registrar_would_not_understand() {
        for value in [
            "Hyper+K",
            "CommandOrControl+Shift+Fn",
            "CommandOrControl+F25",
            "CommandOrControl+PrintScreen",
            "CommandOrControl+ ",
        ] {
            assert!(
                matches!(
                    Chord::parse(value),
                    Err(ChordError::Unknown(_)) | Err(ChordError::NotAChord)
                ),
                "{value} was accepted",
            );
        }
    }

    #[test]
    fn a_mistyped_override_is_refused_rather_than_replaced() {
        // The silent-fallback bug, written down. A person who set a chord and
        // got a different one would believe they had a kill switch on a key
        // that does nothing.
        assert!(Chord::from_environment(Some("Hyper+K")).is_err());
    }

    #[test]
    fn a_failed_registration_says_what_still_works() {
        let chord = Chord::parse(DEFAULT_CHORD).expect("chord");
        let message = registration_failed(&chord, "already in use");
        assert!(message.contains(DEFAULT_CHORD));
        assert!(message.contains("already in use"));
        // The three other paths from §10.4. An absent hotkey is a cosmetic
        // problem only if a person is told where the stop still is.
        assert!(message.contains("tray"));
        assert!(message.contains("web app"));
        assert!(message.contains("agentd stop"));
    }
}
