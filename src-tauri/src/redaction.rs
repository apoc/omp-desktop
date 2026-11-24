//! Credential key list and key matcher shared by every redaction path: the
//! agent stdout reader (`agent::reader`, structured JSON frames) and the
//! widget error text scanner (`widgets::redact`, free text). One list, one
//! matcher, so the two paths cannot drift apart.

/// Object keys whose values are redacted before a frame ever reaches the
/// webview, except omp's exact boolean `secret` input-request flag (a UI
/// hint, not a credential value). Matched case-insensitively after stripping
/// `_`/`-` separators,
/// so `Authorization`, `api_key`, `api-key`, and `apiKey` are all caught by
/// one entry. Matching is by *suffix*, not exact equality, so compound
/// provider-credential spellings like `x-api-key`, `OPENAI_API_KEY`, and
/// `client_secret` (normalizing to `xapikey`, `openaiapikey`, and
/// `clientsecret`) are caught by the `apikey`/`secret` entries without
/// needing one entry per provider. A few spellings put the sensitive word
/// anywhere but the suffix (`secretkey`, `accesskey`, `privatekey`,
/// `apisecret`) — those get their own explicit entries. `headers` is
/// redacted wholesale (not walked) because a model provider's request
/// headers routinely carry `Authorization` alongside harmless entries, and
/// there is no benefit to preserving the harmless ones once the object as
/// a whole must be treated as sensitive.
pub const REDACTED_KEYS: &[&str] = &[
    "headers",
    "authorization",
    "apikey",
    "accesstoken",
    "refreshtoken",
    "idtoken",
    "password",
    "secret",
    "credential",
    "credentials",
    "secretkey",
    "accesskey",
    "privatekey",
    "apisecret",
];

pub const REDACTED_PLACEHOLDER: &str = "[REDACTED]";

/// Whether `key` names a credential: its normalized form ends with one of
/// [`REDACTED_KEYS`] (see [`normalized_key_ends_with`]).
pub fn is_credential_key(key: &str) -> bool {
    REDACTED_KEYS
        .iter()
        .any(|k| normalized_key_ends_with(key, k))
}

/// Whether `key`'s normalized form (ASCII-lowercased, with `_` and `-`
/// removed) ends with `suffix`.
///
/// `suffix` must already be lowercase and separator-free — every
/// [`REDACTED_KEYS`] entry is. Compares right-to-left over `key`'s bytes so
/// no normalized `String` is ever materialized: this runs for every object
/// key of every JSON frame on the stdout reader thread, the hottest path in
/// the app, where a per-key heap allocation is pure waste.
///
/// Non-ASCII bytes can never match a lowercase-ASCII `suffix`, so comparing
/// ASCII-lowercased bytes is equivalent to a `char`-wise `to_lowercase` fold
/// for every input that could possibly match.
pub fn normalized_key_ends_with(key: &str, suffix: &str) -> bool {
    let mut key_bytes = key.bytes().rev().filter(|b| *b != b'_' && *b != b'-');
    for want in suffix.bytes().rev() {
        match key_bytes.next() {
            Some(got) if got.to_ascii_lowercase() == want => {}
            _ => return false,
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The allocation-free matcher must agree with the obvious
    /// materialize-then-compare form, including on the separator, case, and
    /// non-ASCII edge cases.
    #[test]
    fn normalized_key_ends_with_matches_reference_normalization() {
        fn reference(key: &str, suffix: &str) -> bool {
            let normalized: String = key
                .chars()
                .filter(|c| *c != '_' && *c != '-')
                .flat_map(char::to_lowercase)
                .collect();
            normalized.ends_with(suffix)
        }

        let keys = [
            "api_key",
            "api-key",
            "apiKey",
            "API_KEY",
            "x-api-key",
            "OPENAI_API_KEY",
            "client_secret",
            "input_tokens",
            "output_tokens",
            "monkey",
            "key",
            "",
            "_-_-",
            "clé_api_key",
            "ключ",
            "aPiKeY",
        ];
        for key in keys {
            for suffix in REDACTED_KEYS {
                assert_eq!(
                    normalized_key_ends_with(key, suffix),
                    reference(key, suffix),
                    "mismatch for key {key:?} / suffix {suffix:?}"
                );
            }
        }
    }
}
