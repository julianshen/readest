/// Index of the max logit (ties → lowest index).
pub fn argmax(logits: &[f32]) -> usize {
    logits
        .iter()
        .enumerate()
        .fold(0, |best, (i, &v)| if v > logits[best] { i } else { best })
}

/// Greedy autoregressive decode.
///
/// `step(current_ids)` returns the next-token logits (length = vocab size) for
/// the position after `current_ids`. Starts from `[bos]`; appends argmax each
/// iteration; stops when the chosen token == `eos` OR the generated length
/// reaches `max_len`. Returns the generated ids WITHOUT the leading bos and
/// WITHOUT a trailing eos.
pub fn greedy_decode<F: FnMut(&[i64]) -> Vec<f32>>(
    mut step: F,
    bos: i64,
    eos: i64,
    max_len: usize,
) -> Vec<i64> {
    let mut ids = vec![bos];
    let mut generated: Vec<i64> = Vec::new();
    loop {
        let logits = step(&ids);
        let next = argmax(&logits) as i64;
        if next == eos {
            break;
        }
        generated.push(next);
        if generated.len() >= max_len {
            break;
        }
        ids.push(next);
    }
    generated
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a one-hot Vec<f32> of length `len` with a 1.0 at position `target`.
    fn one_hot(target: usize, len: usize) -> Vec<f32> {
        let mut v = vec![0.0f32; len];
        v[target] = 1.0;
        v
    }

    #[test]
    fn argmax_picks_max() {
        assert_eq!(argmax(&[0.1, 0.9, 0.3]), 1);
    }

    #[test]
    fn argmax_ties_pick_lowest_index() {
        assert_eq!(argmax(&[0.5, 0.5, 0.3]), 0);
        assert_eq!(argmax(&[0.3, 0.5, 0.5]), 1);
    }

    #[test]
    fn greedy_decode_scripted_sequence() {
        // vocab size 8; bos=1, eos=2
        // call 0 (ids=[1])      → emit token 5
        // call 1 (ids=[1,5])    → emit token 7
        // call 2 (ids=[1,5,7])  → emit eos=2 → stop
        // expected result: [5, 7]
        let mut call = 0usize;
        let targets = [5usize, 7, 2];
        let result = greedy_decode(
            |_ids| {
                let tok = targets[call];
                call += 1;
                one_hot(tok, 8)
            },
            1,  // bos
            2,  // eos
            10, // max_len
        );
        assert_eq!(result, vec![5, 7]);
    }

    #[test]
    fn greedy_decode_max_len_cap() {
        // closure always selects token 4 (never eos=2); result must be capped at max_len=5
        let result = greedy_decode(|_ids| one_hot(4, 8), 1, 2, 5);
        assert_eq!(result.len(), 5);
        assert!(result.iter().all(|&t| t == 4));
    }
}
