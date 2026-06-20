use std::collections::HashSet;

const SPECIAL_TOKENS: &[&str] = &["[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]"];

pub struct Detokenizer {
    id_to_token: Vec<String>,
}

impl Detokenizer {
    /// Parse a vocab where each line is one token; line index = id.
    pub fn from_vocab_str(s: &str) -> Self {
        let id_to_token = s.lines().map(|l| l.to_string()).collect();
        Self { id_to_token }
    }

    /// Read file at `path` and parse with [`from_vocab_str`].
    pub fn from_vocab_file(path: &std::path::Path) -> Result<Self, String> {
        let s =
            std::fs::read_to_string(path).map_err(|e| format!("failed to read vocab file: {e}"))?;
        Ok(Self::from_vocab_str(&s))
    }

    /// Convert token IDs to text.
    ///
    /// Special tokens (`[PAD]`, `[UNK]`, `[CLS]`, `[SEP]`, `[MASK]`) are
    /// skipped.  WordPiece continuation tokens (`##…`) have their prefix
    /// stripped before concatenation.  Out-of-range IDs are silently ignored.
    /// Tokens are joined without separators (Japanese has no word spaces).
    pub fn decode(&self, ids: &[u32]) -> String {
        let specials: HashSet<&str> = SPECIAL_TOKENS.iter().copied().collect();
        let mut out = String::new();
        for &id in ids {
            let Some(token) = self.id_to_token.get(id as usize) else {
                continue;
            };
            if specials.contains(token.as_str()) {
                continue;
            }
            let piece = token.strip_prefix("##").unwrap_or(token.as_str());
            out.push_str(piece);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn simple_vocab() -> Detokenizer {
        // ids: [PAD]=0, [CLS]=1, [SEP]=2, こんにち=3, ##は=4
        Detokenizer::from_vocab_str("[PAD]\n[CLS]\n[SEP]\nこんにち\n##は\n")
    }

    #[test]
    fn test_decode_strips_special_tokens_and_joins_continuation() {
        let d = simple_vocab();
        // CLS and SEP should be stripped; ##は → は and joined directly
        assert_eq!(d.decode(&[1, 3, 4, 2]), "こんにちは");
    }

    #[test]
    fn test_out_of_range_id_ignored() {
        let d = simple_vocab();
        // 999 is out of range; only こんにち (id=3) should appear
        assert_eq!(d.decode(&[3, 999]), "こんにち");
    }

    #[test]
    fn test_continuation_prefix_stripped() {
        // ##test → test; plain token stays unchanged
        let d = Detokenizer::from_vocab_str("hello\n##test\n");
        assert_eq!(d.decode(&[0, 1]), "hellotest");
        assert_eq!(d.decode(&[0]), "hello");
        assert_eq!(d.decode(&[1]), "test");
    }

    #[test]
    fn test_all_special_tokens_skipped() {
        // Build a vocab that is only special tokens
        let d = Detokenizer::from_vocab_str("[PAD]\n[UNK]\n[CLS]\n[SEP]\n[MASK]\n");
        assert_eq!(d.decode(&[0, 1, 2, 3, 4]), "");
    }

    #[test]
    fn test_empty_input() {
        let d = simple_vocab();
        assert_eq!(d.decode(&[]), "");
    }
}
