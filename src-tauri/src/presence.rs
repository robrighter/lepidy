//! What this machine says about a workspace when its window is not in front of
//! anybody: a native notification, and an unread badge.
//!
//! Both carry text somebody else wrote. A notification body is a message
//! preview, and messages in this product are written by agents and by
//! strangers; a badge is a count, and the reason it is only ever a count is in
//! [`badge_label`].
//!
//! Neither is a decision. Whether a person should be notified at all is settled
//! by the workspace's notification rules — tiers, per-room modes, keywords,
//! thread subscriptions and do-not-disturb — and this file is only the last few
//! centimetres between that decision and the operating system. What it owns is
//! that the text cannot become something other than text, and that acting on
//! the notification cannot take anybody anywhere but a [`Destination`].

use crate::deeplink::{self, Destination};

/// A notification ready to hand to the operating system.
///
/// Constructed only by [`prepare`], so there is no path to a notification whose
/// text skipped [`sanitise`] or whose activation is a URL rather than a place.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Notification {
    title: String,
    body: String,
    /// Where a click goes. A place, from the closed set, never a URL.
    destination: Destination,
}

impl Notification {
    pub fn title(&self) -> &str {
        &self.title
    }

    pub fn body(&self) -> &str {
        &self.body
    }

    pub fn destination(&self) -> &Destination {
        &self.destination
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum PresenceError {
    /// Nothing legible survived sanitising. A notification with an empty title
    /// is a blank popup with this product's icon on it, which is worse than no
    /// notification: it teaches people the icon means nothing.
    Empty,
    /// The activation target was not a place this shell can open.
    Destination(deeplink::DeepLinkError),
}

impl std::fmt::Display for PresenceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Empty => write!(f, "there is nothing to show in a notification"),
            Self::Destination(error) => write!(f, "{error}"),
        }
    }
}

/// The most of a title and a body an operating system will show anyway.
///
/// Truncating here rather than letting the platform do it is not cosmetic: a
/// body the shell did not bound is a body a message can make arbitrarily long,
/// and on two of the three platforms that is a notification that covers the
/// screen.
const MAX_TITLE: usize = 80;
const MAX_BODY: usize = 240;

/// Build a notification, or refuse to.
///
/// `destination` is a `lepidy://` link, parsed by the *same* parser the
/// operating system's deep links go through. One place decides where a click
/// can lead, whether the click came from a notification this process raised or
/// from a link a stranger sent.
pub fn prepare(title: &str, body: &str, destination: &str) -> Result<Notification, PresenceError> {
    let destination = deeplink::parse(destination).map_err(PresenceError::Destination)?;
    let title = sanitise(title, MAX_TITLE);
    let body = sanitise(body, MAX_BODY);
    if title.is_empty() {
        return Err(PresenceError::Empty);
    }
    Ok(Notification {
        title,
        body,
        destination,
    })
}

/// Make a string safe to be shown as one line of operating-system chrome.
///
/// Three things are removed, and each is a way for text to stop being text:
///
/// * **Control characters**, including newlines and tabs. A notification is one
///   or two lines of chrome; a body containing twenty newlines is a body that
///   pushes the part a person needed to read off the visible area, which is how
///   a preview of an approval ends up showing only the reassuring half.
/// * **Bidirectional overrides** (U+202A–U+202E, U+2066–U+2069). These reorder
///   the characters *around* them when rendered, so a message body can rewrite
///   how the title next to it reads. There is no legitimate use for one in a
///   preview, and a right-to-left language does not need them: the plain
///   characters carry their own direction.
/// * **Runs of whitespace**, collapsed to one space, so leading padding cannot
///   push content out of view either.
fn sanitise(value: &str, limit: usize) -> String {
    let mut out = String::with_capacity(value.len().min(limit * 4));
    let mut pending_space = false;
    for character in value.chars() {
        if character.is_control() || is_bidi_override(character) {
            // A control character becomes a word break rather than vanishing,
            // so "line one\nline two" does not read as "line onelinetwo".
            pending_space = !out.is_empty();
            continue;
        }
        if character.is_whitespace() {
            pending_space = !out.is_empty();
            continue;
        }
        if pending_space {
            out.push(' ');
            pending_space = false;
        }
        out.push(character);
    }
    truncate(out, limit)
}

fn is_bidi_override(character: char) -> bool {
    matches!(character, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{200f}' | '\u{200e}')
}

/// Cut to `limit` characters on a character boundary, with a visible ellipsis.
///
/// Counted in characters rather than bytes: a bound expressed in bytes cuts a
/// Japanese preview to a third of a Latin one for no reason a person could
/// guess, and a byte index that lands mid-sequence panics.
fn truncate(value: String, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value;
    }
    let mut out: String = value.chars().take(limit.saturating_sub(1)).collect();
    // Do not end on a space before the ellipsis; it reads as a missing word.
    while out.ends_with(' ') {
        out.pop();
    }
    out.push('…');
    out
}

/* -------------------------------------------------------------------------- */
/* The badge                                                                   */
/* -------------------------------------------------------------------------- */

/// Above this, the exact number stops being information and starts being noise.
const BADGE_CEILING: u64 = 99;

/// What the tray, dock or taskbar badge should read, or `None` to clear it.
///
/// **A badge is a count and never text.** That is the entire interface, and it
/// is narrow on purpose: a badge whose contents came from a message would put a
/// stranger's characters into the operating system's own chrome, in a place no
/// sanitiser of ours is between — the dock, the taskbar, the window list. There
/// is no story where that is worth the flexibility.
///
/// Zero clears rather than showing a nought, because a dock icon reading `0` is
/// a badge that says there is something here.
pub fn badge_label(unread: u64) -> Option<String> {
    match unread {
        0 => None,
        1..=BADGE_CEILING => Some(unread.to_string()),
        _ => Some(format!("{BADGE_CEILING}+")),
    }
}

/// The same badge as a number, for the platforms whose badge takes one.
///
/// Clamped exactly as [`badge_label`] is, so the dock and the tray never
/// disagree about how much is waiting.
pub fn badge_count(unread: u64) -> Option<i64> {
    match unread {
        0 => None,
        _ => Some(unread.min(BADGE_CEILING) as i64),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn carries_a_preview_and_a_place_to_go() {
        let notification = prepare(
            "#deploys — @a.release",
            "staging is green",
            "lepidy://channel/deploys/msg-01hx",
        )
        .expect("a notification");
        assert_eq!(notification.title(), "#deploys — @a.release");
        assert_eq!(notification.body(), "staging is green");
        assert_eq!(
            notification.destination().path(),
            "/c/deploys?thread=msg-01hx",
        );
    }

    #[test]
    fn a_message_cannot_take_a_click_off_this_workspace() {
        // The page raising a notification is Lepidy's own page, but the values
        // it puts in one come from a message. So the activation target goes
        // through the deep-link parser, and everything that parser refuses is
        // refused here too.
        for destination in [
            "https://evil.test/",
            "lepidy://inbox?next=https://evil.test",
            "javascript:fetch('/steal')",
            "lepidy://channel/../../vault",
            "lepidy://approve/req-77",
        ] {
            let error =
                prepare("Mention", "look", destination).expect_err("{destination} was accepted");
            assert!(
                matches!(error, PresenceError::Destination(_)),
                "{destination}"
            );
        }
    }

    #[test]
    fn a_body_cannot_stop_being_one_line_of_text() {
        let notification = prepare(
            "  #deploys\u{202e}  ",
            "first line\nsecond line\r\n\tthird\u{0007}",
            "lepidy://inbox",
        )
        .expect("a notification");
        // The override is gone, not escaped: it would have reordered the
        // characters after it wherever this string is rendered.
        assert_eq!(notification.title(), "#deploys");
        assert!(!notification.title().contains('\u{202e}'));
        assert_eq!(notification.body(), "first line second line third");
        assert!(!notification.body().contains('\n'));
    }

    #[test]
    fn a_long_preview_is_cut_here_rather_than_by_the_platform() {
        let long = "や".repeat(400);
        let notification = prepare("Mention", &long, "lepidy://inbox").expect("a notification");
        assert_eq!(notification.body().chars().count(), MAX_BODY);
        assert!(notification.body().ends_with('…'));
        // Counted in characters: a multi-byte preview is not cut to a third of
        // a Latin one, and no cut lands inside a character.
        assert!(notification.body().chars().all(|c| c == 'や' || c == '…'));

        let title = "t".repeat(500);
        let notification = prepare(&title, "", "lepidy://inbox").expect("a notification");
        assert_eq!(notification.title().chars().count(), MAX_TITLE);
    }

    #[test]
    fn nothing_legible_means_no_notification_at_all() {
        for title in ["", "   ", "\n\n", "\u{202e}\u{2066}"] {
            assert_eq!(
                prepare(title, "body", "lepidy://inbox"),
                Err(PresenceError::Empty),
                "{title:?}",
            );
        }
        // An empty body is fine — plenty of notifications are a title alone.
        assert!(prepare("Approval requested", "", "lepidy://inbox").is_ok());
    }

    #[test]
    fn the_number_and_the_label_never_disagree() {
        assert_eq!(badge_count(0), None);
        assert_eq!(badge_count(7), Some(7));
        // A dock reading 5,000 and a tray reading "99+" would be two answers to
        // one question.
        assert_eq!(badge_count(5_000), Some(99));
        assert_eq!(badge_count(u64::MAX), Some(99));
        for unread in [0, 1, 99, 100, u64::MAX] {
            assert_eq!(badge_count(unread).is_some(), badge_label(unread).is_some());
        }
    }

    #[test]
    fn the_badge_is_a_count_and_zero_clears_it() {
        assert_eq!(badge_label(0), None);
        assert_eq!(badge_label(1).as_deref(), Some("1"));
        assert_eq!(badge_label(99).as_deref(), Some("99"));
        assert_eq!(badge_label(100).as_deref(), Some("99+"));
        assert_eq!(badge_label(u64::MAX).as_deref(), Some("99+"));
        // Whatever the count, what reaches the operating system is digits and
        // at most one `+`. There is no input to this function that could put a
        // stranger's characters into the dock.
        for unread in [0, 1, 7, 99, 100, 5_000, u64::MAX] {
            if let Some(label) = badge_label(unread) {
                assert!(
                    label.bytes().all(|b| b.is_ascii_digit() || b == b'+'),
                    "{label}",
                );
            }
        }
    }
}
