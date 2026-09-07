//! Redacting injected values out of a child's output.
//!
//! Adapted from Agent Vault's `crates/av-cli/src/scrub.rs` at
//! `d794820084151eddbdbb56bf9cd10b5bf3666cdc`, with the same reasoning and the
//! same honesty about its limits.
//!
//! Injection puts a value in a child's environment, which is the point — but
//! nothing stops the child printing it straight back out. `env`, `set -x`, a
//! verbose curl, a stack trace with the URL in it. When that output is being
//! read by an agent the value lands in the model's context and on disk, and the
//! injection bought nothing. So the child's stdout and stderr stream through a
//! matcher that replaces any injected value with `[redacted:NAME]`.
//!
//! **This is a mitigation, not a guarantee.** A value that is base64'd,
//! JSON-escaped, or printed one character per line goes straight through. It
//! catches the common accident, not a determined leak, and nothing in the
//! product may claim otherwise.

use std::collections::HashMap;

/// Values shorter than this are not matched. Below it, false positives are more
/// likely than real leaks, and redacting fragments of ordinary output is worse
/// than missing a short token.
pub const MIN_LEN: usize = 8;

pub struct Scrubber {
    /// (value bytes, replacement text, name), longest first.
    needles: Vec<(Vec<u8>, Vec<u8>, String)>,
    max_len: usize,
    /// Bytes held back because they might begin a match that continues into the
    /// next chunk.
    carry: Vec<u8>,
    hits: HashMap<String, usize>,
}

impl Scrubber {
    /// `values` is (name, value). Anything shorter than [`MIN_LEN`] is dropped.
    pub fn new<'a>(values: impl IntoIterator<Item = (&'a str, &'a str)>) -> Self {
        let mut needles: Vec<(Vec<u8>, Vec<u8>, String)> = values
            .into_iter()
            .filter(|(_, value)| value.len() >= MIN_LEN)
            .map(|(name, value)| {
                (
                    value.as_bytes().to_vec(),
                    format!("[redacted:{name}]").into_bytes(),
                    name.to_string(),
                )
            })
            .collect();

        // Longest first, so an overlapping pair redacts the larger secret rather
        // than leaving its tail visible.
        needles.sort_by_key(|(needle, _, _)| std::cmp::Reverse(needle.len()));
        let max_len = needles
            .first()
            .map(|(needle, _, _)| needle.len())
            .unwrap_or(0);
        Self {
            needles,
            max_len,
            carry: Vec::new(),
            hits: HashMap::new(),
        }
    }

    /// How many times each value was redacted. A non-zero count means the
    /// command tried to print a credential, which the operator should hear
    /// about even though it was stopped.
    pub fn hits(&self) -> &HashMap<String, usize> {
        &self.hits
    }

    /// Feed a chunk; returns the bytes that are safe to emit now.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<u8> {
        if self.needles.is_empty() {
            return chunk.to_vec();
        }
        self.carry.extend_from_slice(chunk);
        let buffer = std::mem::take(&mut self.carry);
        let (emit, carry) = self.scan(&buffer, false);
        self.carry = carry;
        emit
    }

    /// Flush whatever is held back. Call once, at end of stream.
    pub fn finish(&mut self) -> Vec<u8> {
        if self.needles.is_empty() {
            return Vec::new();
        }
        let buffer = std::mem::take(&mut self.carry);
        self.scan(&buffer, true).0
    }

    /// Returns (emit, carry).
    ///
    /// While the stream is still open the last `max_len - 1` bytes are held
    /// back: a value split across two reads would otherwise slip through, which
    /// is exactly the failure mode a naive per-chunk replace has.
    fn scan(&mut self, buffer: &[u8], final_chunk: bool) -> (Vec<u8>, Vec<u8>) {
        let mut out = Vec::with_capacity(buffer.len());
        let hold = if final_chunk {
            0
        } else {
            self.max_len.saturating_sub(1)
        };
        let limit = buffer.len().saturating_sub(hold);
        let mut found: Vec<String> = Vec::new();

        let mut index = 0;
        while index < buffer.len() {
            let matched = self.needles.iter().find(|(needle, _, _)| {
                buffer.len() - index >= needle.len()
                    && &buffer[index..index + needle.len()] == needle.as_slice()
            });
            if let Some((needle, replacement, name)) = matched {
                out.extend_from_slice(replacement);
                found.push(name.clone());
                index += needle.len();
                continue;
            }
            // Past the safe point with no complete match here: the remainder
            // could still be the head of one, so hold it for the next chunk.
            if index >= limit {
                break;
            }
            out.push(buffer[index]);
            index += 1;
        }

        for name in found {
            *self.hits.entry(name).or_insert(0) += 1;
        }
        (out, buffer[index..].to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scrub_all(values: &[(&str, &str)], chunks: &[&[u8]]) -> String {
        let mut scrubber = Scrubber::new(values.iter().copied());
        let mut out = Vec::new();
        for chunk in chunks {
            out.extend(scrubber.push(chunk));
        }
        out.extend(scrubber.finish());
        String::from_utf8(out).unwrap()
    }

    /// VAULT-CLI-RULE-011
    #[test]
    fn redacts_a_value_in_one_chunk() {
        assert_eq!(
            scrub_all(
                &[("TOKEN", "canary-value-0001")],
                &[b"using canary-value-0001 now"]
            ),
            "using [redacted:TOKEN] now"
        );
    }

    /// VAULT-CLI-RULE-012
    #[test]
    fn redacts_a_value_split_across_reads() {
        assert_eq!(
            scrub_all(
                &[("TOKEN", "canary-value-0001")],
                &[b"using canary-", b"value-0001 now"]
            ),
            "using [redacted:TOKEN] now"
        );
    }

    /// VAULT-CLI-RULE-013
    #[test]
    fn prefers_the_longer_of_two_overlapping_values() {
        assert_eq!(
            scrub_all(
                &[("SHORT", "canary-value"), ("LONG", "canary-value-0001")],
                &[b"x canary-value-0001 y"]
            ),
            "x [redacted:LONG] y"
        );
    }

    /// VAULT-CLI-RULE-014
    #[test]
    fn leaves_short_values_alone_rather_than_shredding_ordinary_output() {
        assert_eq!(scrub_all(&[("TINY", "abc")], &[b"abc def"]), "abc def");
    }

    /// VAULT-CLI-RULE-015
    #[test]
    fn counts_every_redaction_so_a_leak_can_be_reported() {
        let mut scrubber = Scrubber::new([("TOKEN", "canary-value-0001")]);
        scrubber.push(b"canary-value-0001 canary-value-0001");
        scrubber.finish();
        assert_eq!(scrubber.hits().get("TOKEN"), Some(&2));
    }

    /// VAULT-CLI-RULE-016
    #[test]
    fn holds_back_a_trailing_partial_match_until_the_stream_ends() {
        let mut scrubber = Scrubber::new([("TOKEN", "canary-value-0001")]);
        let emitted = scrubber.push(b"tail canary-value-000");
        assert!(!String::from_utf8_lossy(&emitted).contains("canary-value-000"));
        assert_eq!(
            String::from_utf8_lossy(&scrubber.finish()).to_string(),
            "canary-value-000".to_string()
        );
    }
}
