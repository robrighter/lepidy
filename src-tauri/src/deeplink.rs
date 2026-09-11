//! Where a `lepidy://` link may take this window.
//!
//! A deep link is the one piece of shell input that arrives from outside the
//! product entirely. Any web page can navigate a browser to `lepidy://…`, any
//! message can contain one, and the operating system hands it to this process
//! without asking anybody. So it is treated exactly like the message bodies the
//! window renders: written by strangers.
//!
//! Two rules follow, and everything in this file is one of them.
//!
//! **A deep link names a place, never a URL.** What comes back from `parse` is
//! a [`Destination`] from a closed set, and the shell builds the address itself
//! by joining that destination's path onto the trusted origin. There is no
//! branch anywhere that navigates to a string a link supplied — which is what
//! makes `lepidy://open?next=https://evil.test` a parse failure rather than a
//! redirect.
//!
//! **A deep link never does anything.** No verb here approves a credential,
//! stops a runner, releases a secret or changes a setting; the set is complete
//! and every member of it shows a page. A link that could approve would be an
//! approval anybody could cause by getting one click, and the whole point of
//! §8.6's approval card is that the person decides at a surface they trust.

/// A place in the workspace that a link is allowed to open.
///
/// Closed on purpose. Adding a variant is the moment to ask whether the new
/// destination shows something or does something.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Destination {
    /// The ranked home feed.
    Home,
    /// Mentions, threads, direct messages and approval cards.
    Inbox,
    /// One approval card, scrolled to. Showing it, not answering it.
    Approval {
        id: Segment,
    },
    Channel {
        channel: Segment,
    },
    /// A thread inside a room, addressed by the message that opened it.
    Thread {
        channel: Segment,
        message: Segment,
    },
    People,
    Saved,
    Agent {
        agent: Segment,
    },
    /// An agent's runtime page — owner-only, and enforced by the page, not here.
    AgentRuntime {
        agent: Segment,
    },
    /// Credential metadata. Never a value: no route in this product serves one.
    Credential {
        id: Segment,
    },
}

impl Destination {
    /// The path this destination opens, rooted and built from validated pieces.
    ///
    /// Every interpolation below is a [`Segment`], which is why this can be a
    /// `format!` rather than an escaping exercise: a segment that could contain
    /// a slash, a dot-dot or a question mark would not have parsed.
    pub fn path(&self) -> String {
        match self {
            // `/` is the public marketing site; the signed-in home lives here.
            Self::Home => "/workspace".to_string(),
            Self::Inbox => "/inbox".to_string(),
            Self::Approval { id } => format!("/inbox?approval={id}"),
            Self::Channel { channel } => format!("/c/{channel}"),
            Self::Thread { channel, message } => format!("/c/{channel}?thread={message}"),
            Self::People => "/people".to_string(),
            Self::Saved => "/saved".to_string(),
            Self::Agent { agent } => format!("/agents/{agent}"),
            Self::AgentRuntime { agent } => format!("/agents/{agent}/runtime"),
            Self::Credential { id } => format!("/vault/{id}"),
        }
    }
}

/// One validated path segment: a room slug, a handle, a message or approval id.
///
/// A newtype rather than a `String` so that the validation cannot be skipped by
/// constructing a [`Destination`] by hand somewhere else in the shell.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Segment(String);

impl std::fmt::Display for Segment {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl Segment {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum DeepLinkError {
    /// Not a `lepidy://` link at all.
    NotOurScheme,
    /// A destination this version does not know.
    ///
    /// Deliberately not "fall back to the home page": a link that quietly opened
    /// somewhere else would make a mistyped or hostile link indistinguishable
    /// from a working one, and a newer build knowing a destination this one does
    /// not is a thing a person should be told rather than have papered over.
    UnknownDestination,
    /// A query, a fragment, an encoded character or a segment that is not one.
    Malformed,
}

impl std::fmt::Display for DeepLinkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotOurScheme => write!(f, "that link is not a Lepidy link"),
            Self::UnknownDestination => {
                write!(f, "this version of Lepidy does not know that destination")
            }
            Self::Malformed => write!(f, "that is not a link Lepidy can open"),
        }
    }
}

/// The scheme, lowercase. Registered with the operating system by the bundle.
pub const SCHEME: &str = "lepidy";

/// A link longer than this is not a destination anybody typed or a product
/// wrote. The bound is here so a pathological link cannot become work.
const MAX_LINK: usize = 512;

/// The most a single segment may be. Longer than any handle or id the product
/// mints, short enough that a segment cannot carry a payload.
const MAX_SEGMENT: usize = 64;

/// Turn a link from the operating system into a place, or refuse it.
pub fn parse(link: &str) -> Result<Destination, DeepLinkError> {
    let link = link.trim();
    if link.len() > MAX_LINK {
        return Err(DeepLinkError::Malformed);
    }
    let (scheme, rest) = link.split_once(':').ok_or(DeepLinkError::NotOurScheme)?;
    if !scheme.eq_ignore_ascii_case(SCHEME) {
        return Err(DeepLinkError::NotOurScheme);
    }
    // `lepidy:inbox` and `lepidy://inbox` are the same intent, and platforms
    // differ about which one they hand over. Both are accepted; a third slash
    // is not, because `lepidy:///…` is a path with an empty authority and that
    // is the shape a traversal starts from.
    let rest = match rest.strip_prefix("//") {
        Some(rest) => rest,
        None => rest,
    };

    // A query or a fragment on a deep link is how "open this" becomes "open
    // this, and also go here afterwards". There is no destination in the set
    // below that needs either, so both are refused outright rather than
    // ignored — ignoring them would leave the link looking like it worked.
    if rest.contains('?') || rest.contains('#') {
        return Err(DeepLinkError::Malformed);
    }
    // Percent-encoding is refused wholesale rather than decoded. Nothing this
    // parser accepts needs an escape, and a decoder here is the standard place
    // `%2e%2e%2f` becomes a path nobody validated.
    if rest.contains('%') {
        return Err(DeepLinkError::Malformed);
    }
    // A backslash is a path separator on one of the three platforms and not on
    // the other two, which is the entire reason it is refused here.
    if rest.contains('\\') {
        return Err(DeepLinkError::Malformed);
    }

    let mut parts = rest.split('/').filter(|part| !part.is_empty());
    let verb = parts.next().unwrap_or("").to_ascii_lowercase();
    let arguments: Vec<&str> = parts.collect();

    let destination = match (verb.as_str(), arguments.as_slice()) {
        ("", []) | ("home", []) => Destination::Home,
        ("inbox", []) => Destination::Inbox,
        ("approval", [id]) => Destination::Approval { id: segment(id)? },
        ("channel", [channel]) => Destination::Channel {
            channel: segment(channel)?,
        },
        ("channel", [channel, message]) => Destination::Thread {
            channel: segment(channel)?,
            message: segment(message)?,
        },
        ("people", []) => Destination::People,
        ("saved", []) => Destination::Saved,
        ("agent", [agent]) => Destination::Agent {
            agent: segment(agent)?,
        },
        ("agent", [agent, "runtime"]) => Destination::AgentRuntime {
            agent: segment(agent)?,
        },
        ("credential", [id]) => Destination::Credential { id: segment(id)? },
        _ => return Err(DeepLinkError::UnknownDestination),
    };
    Ok(destination)
}

/// Validate one path segment.
///
/// Shape only, and deliberately so: whether the room exists and whether the
/// person may see it is the workspace's decision, made on the read with the
/// viewer's authority, exactly as it would be for a link they typed. What this
/// check owns is that the string cannot be anything other than a segment.
fn segment(value: &str) -> Result<Segment, DeepLinkError> {
    let lowered = value.trim().to_ascii_lowercase();
    if lowered.is_empty() || lowered.len() > MAX_SEGMENT {
        return Err(DeepLinkError::Malformed);
    }
    // `.` and `..` are valid under the character rule below and are the two
    // strings this whole function exists to keep out of a path.
    if lowered == "." || lowered == ".." {
        return Err(DeepLinkError::Malformed);
    }
    if !lowered
        .bytes()
        .next()
        .is_some_and(|byte| byte.is_ascii_alphanumeric())
    {
        return Err(DeepLinkError::Malformed);
    }
    if !lowered
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(DeepLinkError::Malformed);
    }
    Ok(Segment(lowered))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_the_places_a_notification_or_a_colleague_would_link_to() {
        for (link, path) in [
            ("lepidy://inbox", "/inbox"),
            ("lepidy:inbox", "/inbox"),
            ("lepidy://", "/workspace"),
            ("lepidy://home", "/workspace"),
            ("lepidy://channel/deploys", "/c/deploys"),
            (
                "lepidy://channel/deploys/msg-01hx",
                "/c/deploys?thread=msg-01hx",
            ),
            ("lepidy://approval/req-77", "/inbox?approval=req-77"),
            ("lepidy://agent/a.deploy", "/agents/a.deploy"),
            (
                "lepidy://agent/a.deploy/runtime",
                "/agents/a.deploy/runtime",
            ),
            ("lepidy://credential/cred-9", "/vault/cred-9"),
            ("lepidy://people", "/people"),
            ("lepidy://saved", "/saved"),
            // The scheme is a scheme: case is not part of it.
            ("LEPIDY://Inbox", "/inbox"),
        ] {
            let destination = parse(link).unwrap_or_else(|error| panic!("{link}: {error}"));
            assert_eq!(destination.path(), path, "{link}");
        }
    }

    #[test]
    fn refuses_a_link_that_tries_to_carry_a_url_of_its_own() {
        // This is the whole reason the destination is a closed set. A deep link
        // that could name where to go next is an open redirect with an
        // operating-system-registered entry point.
        for link in [
            "lepidy://open?next=https://evil.test",
            "lepidy://inbox?next=https://evil.test",
            "lepidy://inbox#https://evil.test",
            "lepidy://https://evil.test",
            "lepidy://channel/deploys?thread=../../etc",
        ] {
            assert!(parse(link).is_err(), "{link} was accepted");
        }
    }

    #[test]
    fn refuses_a_segment_that_is_not_a_segment() {
        for link in [
            "lepidy://channel/..",
            "lepidy://channel/.",
            "lepidy://channel/../../vault",
            // Encoded traversal: refused because nothing here decodes.
            "lepidy://channel/%2e%2e%2fvault",
            "lepidy://channel/%2Fetc%2Fpasswd",
            // A backslash is a separator on Windows and not on the other two.
            "lepidy://channel/deploys\\..\\vault",
            "lepidy://channel/ ",
            "lepidy://channel/-leading",
            "lepidy://channel/has space",
            "lepidy://channel/has:colon",
        ] {
            assert!(parse(link).is_err(), "{link} was accepted");
        }
        // And a segment longer than any id this product mints.
        let long = "a".repeat(MAX_SEGMENT + 1);
        assert_eq!(
            parse(&format!("lepidy://channel/{long}")),
            Err(DeepLinkError::Malformed)
        );
        let enormous = "a".repeat(MAX_LINK);
        assert_eq!(
            parse(&format!("lepidy://channel/{enormous}")),
            Err(DeepLinkError::Malformed),
        );
    }

    #[test]
    fn refuses_another_application_s_scheme() {
        for link in [
            "https://lepidy.example/inbox",
            "file:///etc/passwd",
            "javascript:fetch('/steal')",
            "lepidyx://inbox",
            "inbox",
        ] {
            assert_eq!(parse(link), Err(DeepLinkError::NotOurScheme), "{link}");
        }
    }

    #[test]
    fn refuses_an_empty_authority_rather_than_walking_a_path() {
        // `lepidy:///…` is a URL with no authority and a leading path, which is
        // the shape traversal attempts arrive in.
        assert_eq!(
            parse("lepidy:///etc/passwd"),
            Err(DeepLinkError::UnknownDestination)
        );
    }

    #[test]
    fn has_no_verb_that_does_anything() {
        // The rule stated as a test, because the temptation to add one arrives
        // with the first push notification somebody wants an action button on.
        for link in [
            "lepidy://approve/req-77",
            "lepidy://deny/req-77",
            "lepidy://stop",
            "lepidy://release/cred-9",
            "lepidy://run/a.deploy",
            "lepidy://signin?token=abc",
        ] {
            assert!(parse(link).is_err(), "{link} was accepted");
        }
    }

    #[test]
    fn every_destination_stays_on_one_path_of_its_own_origin() {
        // The property that makes joining a destination onto the trusted origin
        // safe: a path that began with `//` would be protocol-relative, and a
        // path carrying a second `?` would be a query nobody parsed.
        for destination in [
            Destination::Home,
            Destination::Inbox,
            Destination::Approval {
                id: segment("req-77").expect("segment"),
            },
            Destination::Channel {
                channel: segment("deploys").expect("segment"),
            },
            Destination::Thread {
                channel: segment("deploys").expect("segment"),
                message: segment("msg-1").expect("segment"),
            },
            Destination::People,
            Destination::Saved,
            Destination::Agent {
                agent: segment("a.deploy").expect("segment"),
            },
            Destination::AgentRuntime {
                agent: segment("a.deploy").expect("segment"),
            },
            Destination::Credential {
                id: segment("cred-9").expect("segment"),
            },
        ] {
            let path = destination.path();
            assert!(path.starts_with('/'), "{path}");
            assert!(!path.starts_with("//"), "{path}");
            assert!(!path.contains("://"), "{path}");
            assert!(!path.contains(".."), "{path}");
            assert!(path.matches('?').count() <= 1, "{path}");
        }
    }
}
