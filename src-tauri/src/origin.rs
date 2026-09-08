//! Which origin the desktop shell will load, and which may call into it.
//!
//! This is the boundary that makes every other native capability safe to have.
//! A shell that will navigate anywhere is a shell where one hostile link turns
//! the page into something that can start processes, read a preset file and ask
//! for a user-verification prompt — and the messages in this product are
//! written by agents and by strangers, so hostile links are not hypothetical.
//!
//! So: the main window loads exactly one origin, and IPC is answered only for
//! that origin. Everything else is refused, and anything a person deliberately
//! opens goes to their real browser instead of into this window.

/// Where the shell is allowed to point.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TrustedOrigin {
    scheme: String,
    host: String,
    port: Option<u16>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum OriginError {
    Malformed,
    /// Plain HTTP anywhere but loopback. A shell that will load a workspace in
    /// the clear is a shell whose session cookie is on the wire.
    InsecureTransport,
}

impl std::fmt::Display for OriginError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Malformed => write!(f, "that is not an origin"),
            Self::InsecureTransport => {
                write!(f, "refusing plain http off loopback: use https")
            }
        }
    }
}

impl TrustedOrigin {
    /// Parse the one origin this shell trusts.
    ///
    /// Deliberately strict about shape rather than clever about URLs: an origin
    /// is a scheme, a host and a port, and anything carrying a path, a query, a
    /// fragment or credentials is not one. Those are exactly the pieces a
    /// look-alike relies on.
    pub fn parse(value: &str) -> Result<Self, OriginError> {
        let value = value.trim().trim_end_matches('/');
        let (scheme, rest) = value.split_once("://").ok_or(OriginError::Malformed)?;
        let scheme = scheme.to_ascii_lowercase();
        if scheme != "http" && scheme != "https" {
            return Err(OriginError::Malformed);
        }
        // No path, no query, no fragment, and no `user:pass@` — a URL that
        // reads as one origin to a person and another to a parser.
        if rest.contains('/') || rest.contains('?') || rest.contains('#') || rest.contains('@') {
            return Err(OriginError::Malformed);
        }
        let (host, port) = split_host_port(rest)?;
        if host.is_empty() {
            return Err(OriginError::Malformed);
        }
        if scheme == "http" && !is_loopback(&host) {
            return Err(OriginError::InsecureTransport);
        }
        Ok(Self { scheme, host, port })
    }

    pub fn as_str(&self) -> String {
        match self.port {
            Some(port) => format!("{}://{}:{port}", self.scheme, self.host),
            None => format!("{}://{}", self.scheme, self.host),
        }
    }

    /// Does a URL the webview wants to load belong to this origin?
    ///
    /// Compared as an origin, never as a prefix. `https://lepidy.example.evil`
    /// starts with `https://lepidy.example`, and a prefix check is how that
    /// becomes a navigation nobody intended.
    pub fn allows(&self, url: &str) -> bool {
        let Some((scheme, rest)) = url.trim().split_once("://") else {
            return false;
        };
        if !scheme.eq_ignore_ascii_case(&self.scheme) {
            return false;
        }
        // Everything after the authority is this origin's business, but the
        // authority itself has to match exactly — and credentials in it mean
        // the host a person read is not the host that will be reached.
        let authority = rest
            .split(['/', '?', '#'])
            .next()
            .unwrap_or_default()
            .to_string();
        if authority.contains('@') {
            return false;
        }
        let Ok((host, port)) = split_host_port(&authority) else {
            return false;
        };
        host == self.host
            && effective_port(&self.scheme, port) == effective_port(&self.scheme, self.port)
    }
}

fn split_host_port(authority: &str) -> Result<(String, Option<u16>), OriginError> {
    // An IPv6 literal keeps its brackets, so the colons inside it are not read
    // as a port separator.
    if let Some(rest) = authority.strip_prefix('[') {
        let (host, tail) = rest.split_once(']').ok_or(OriginError::Malformed)?;
        let port = match tail.strip_prefix(':') {
            Some(port) => Some(port.parse::<u16>().map_err(|_| OriginError::Malformed)?),
            None if tail.is_empty() => None,
            None => return Err(OriginError::Malformed),
        };
        return Ok((format!("[{}]", host.to_ascii_lowercase()), port));
    }
    match authority.split_once(':') {
        Some((host, port)) => Ok((
            host.to_ascii_lowercase(),
            Some(port.parse::<u16>().map_err(|_| OriginError::Malformed)?),
        )),
        None => Ok((authority.to_ascii_lowercase(), None)),
    }
}

fn effective_port(scheme: &str, port: Option<u16>) -> u16 {
    port.unwrap_or(if scheme.eq_ignore_ascii_case("https") {
        443
    } else {
        80
    })
}

fn is_loopback(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_workspace_origin_and_loopback_for_development() {
        assert_eq!(
            TrustedOrigin::parse("https://lepidy.example")
                .expect("https")
                .as_str(),
            "https://lepidy.example",
        );
        assert_eq!(
            TrustedOrigin::parse("http://localhost:3000/")
                .expect("loopback")
                .as_str(),
            "http://localhost:3000",
        );
    }

    #[test]
    fn refuses_plain_http_to_anywhere_that_is_not_this_machine() {
        // A shell that will load a workspace in the clear is a shell whose
        // session cookie is on the wire.
        assert_eq!(
            TrustedOrigin::parse("http://lepidy.example"),
            Err(OriginError::InsecureTransport),
        );
    }

    #[test]
    fn refuses_anything_that_is_not_an_origin() {
        for value in [
            "lepidy.example",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "https://",
            // A path, a query or a fragment means somebody is describing a page
            // rather than an origin, and the difference is where trust stops.
            "https://lepidy.example/workspace",
            "https://lepidy.example?next=x",
            "https://lepidy.example#x",
            // Credentials: the host a person reads is not the host reached.
            "https://lepidy.example@evil.example",
        ] {
            assert_eq!(
                TrustedOrigin::parse(value),
                Err(OriginError::Malformed),
                "{value} was accepted",
            );
        }
    }

    #[test]
    fn allows_its_own_pages_and_nothing_else() {
        let origin = TrustedOrigin::parse("https://lepidy.example").expect("origin");
        assert!(origin.allows("https://lepidy.example/"));
        assert!(origin.allows("https://lepidy.example/w/team/mcp"));
        assert!(origin.allows("https://LEPIDY.example/w/team"));
        // The default port is the same origin written two ways.
        assert!(origin.allows("https://lepidy.example:443/w/team"));
    }

    #[test]
    fn refuses_the_look_alikes_a_prefix_check_would_let_through() {
        let origin = TrustedOrigin::parse("https://lepidy.example").expect("origin");
        for url in [
            // Starts with the trusted origin, and is a different site.
            "https://lepidy.example.evil.test/",
            "https://evil.test/https://lepidy.example",
            // Credentials that make the authority read as the trusted host.
            "https://lepidy.example@evil.test/",
            // A different scheme, a different port, a different host.
            "http://lepidy.example/",
            "https://lepidy.example:8443/",
            "https://sub.lepidy.example/",
            "file:///etc/passwd",
            "javascript:fetch('/steal')",
            "data:text/html,<script>1</script>",
        ] {
            assert!(!origin.allows(url), "{url} was allowed");
        }
    }

    #[test]
    fn treats_a_loopback_port_as_part_of_the_origin() {
        let origin = TrustedOrigin::parse("http://localhost:3000").expect("origin");
        assert!(origin.allows("http://localhost:3000/w/team"));
        // A different port on the same machine is a different application, and
        // during development that is very often somebody else's.
        assert!(!origin.allows("http://localhost:3001/w/team"));
        assert!(!origin.allows("http://127.0.0.1:3000/"));
    }
}
