//! CTC greedy decode for PaddleOCR-style recognizers.
//! Convention: class index 0 is the CTC blank; `dict[0]` is its placeholder and
//! `dict[i]` (i>=1) is the i-th character of the model's dictionary.

/// Greedy-decode `[t, c]` row-major logits: argmax per timestep, collapse
/// consecutive duplicates, drop blank (index 0), map index→`dict`, concatenate.
pub fn ctc_greedy_decode(logits: &[f32], t: usize, c: usize, dict: &[String]) -> String {
    let mut out = String::new();
    let mut prev = usize::MAX;
    for ti in 0..t {
        let start = ti * c;
        let Some(slice) = logits.get(start..start + c) else { break };
        let idx = crate::recognize::argmax(slice);
        if idx != prev && idx != 0 {
            if let Some(ch) = dict.get(idx) {
                out.push_str(ch);
            }
        }
        prev = idx;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dict() -> Vec<String> {
        ["<blank>", "a", "b", "c"].iter().map(|s| s.to_string()).collect()
    }
    fn row(idx: usize, c: usize) -> Vec<f32> { let mut v = vec![0.0; c]; v[idx] = 1.0; v }

    #[test]
    fn collapses_repeats_and_drops_blank() {
        let c = 4;
        let mut logits = Vec::new();
        for idx in [1usize, 1, 0, 1, 2, 2] { logits.extend(row(idx, c)); }
        assert_eq!(ctc_greedy_decode(&logits, 6, c, &dict()), "aab");
    }

    #[test]
    fn empty_timesteps_yield_empty() {
        assert_eq!(ctc_greedy_decode(&[], 0, 4, &dict()), "");
    }

    #[test]
    fn out_of_range_index_skipped() {
        let c = 4;
        let logits = row(3, c);
        assert_eq!(ctc_greedy_decode(&logits, 1, c, &dict()), "c");
    }
}
