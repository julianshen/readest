use image::GrayImage;
#[cfg(feature = "onnx")]
use std::path::Path;

/// Index of the max logit (ties → lowest index). Returns 0 on empty input so
/// callers (which expect a valid index) can't trigger an out-of-bounds panic.
pub fn argmax(logits: &[f32]) -> usize {
    if logits.is_empty() {
        return 0;
    }
    logits
        .iter()
        .enumerate()
        .fold(0, |best, (i, &v)| if v > logits[best] { i } else { best })
}

/// Trait for on-device OCR engines.
pub trait OcrEngine {
    fn recognize(&mut self, crop: &GrayImage) -> Result<String, String>;
}

/// Manga-OCR engine backed by two ONNX sessions (encoder + decoder).
#[cfg(feature = "onnx")]
pub struct MangaOcrEngine {
    encoder: ort::session::Session,
    decoder: ort::session::Session,
    detok: crate::tokenizer::Detokenizer,
}

#[cfg(feature = "onnx")]
impl MangaOcrEngine {
    /// Load encoder and decoder ONNX models and the vocab file.
    pub fn load(
        encoder_path: &Path,
        decoder_path: &Path,
        vocab_path: &Path,
    ) -> Result<Self, String> {
        let encoder = ort::session::Session::builder()
            .map_err(|e| format!("ort builder (encoder): {e}"))?
            .commit_from_file(encoder_path)
            .map_err(|e| format!("ort load encoder: {e}"))?;
        let decoder = ort::session::Session::builder()
            .map_err(|e| format!("ort builder (decoder): {e}"))?
            .commit_from_file(decoder_path)
            .map_err(|e| format!("ort load decoder: {e}"))?;
        let detok = crate::tokenizer::Detokenizer::from_vocab_file(vocab_path)?;
        Ok(Self {
            encoder,
            decoder,
            detok,
        })
    }
}

#[cfg(feature = "onnx")]
impl OcrEngine for MangaOcrEngine {
    fn recognize(&mut self, crop: &GrayImage) -> Result<String, String> {
        use ndarray::{Array4, ArrayView2, ArrayView3};
        use ort::value::TensorRef;

        // 1. Preprocess: crop → [1,3,224,224] f32.
        let pixels: Array4<f32> = crate::preprocess::manga_ocr_pixels(crop);

        // 2. Encoder forward pass.
        let enc_tensor = TensorRef::from_array_view(pixels.view())
            .map_err(|e| format!("ort encoder input: {e}"))?;
        let enc_outputs = self
            .encoder
            .run(ort::inputs!["pixel_values" => enc_tensor])
            .map_err(|e| format!("ort encoder run: {e}"))?;
        let (enc_shape, enc_data) = enc_outputs["last_hidden_state"]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("ort encoder extract: {e}"))?;
        // Shape: [1, 197, 192]. Guard rank before indexing; view the runtime's
        // buffer directly (it outlives the decode loop) to skip an owned copy.
        if enc_shape.len() < 3 {
            return Err(format!(
                "encoder output rank {} < 3 (shape {:?})",
                enc_shape.len(),
                enc_shape
            ));
        }
        let hidden: ArrayView3<f32> = ArrayView3::from_shape(
            (
                enc_shape[0] as usize,
                enc_shape[1] as usize,
                enc_shape[2] as usize,
            ),
            enc_data,
        )
        .map_err(|e| format!("reshape hidden state: {e}"))?;

        // 3. Greedy decode.
        // bos = 2 ([CLS] / decoder_start_token_id), eos = 3 ([SEP]), max_len = 300.
        let generated = greedy_decode(
            |ids: &[i64]| -> Result<Vec<f32>, String> {
                let seq_len = ids.len();
                // input_ids: i64 [1, seq] — view the slice directly, no copy.
                let input_ids: ArrayView2<i64> = ArrayView2::from_shape((1, seq_len), ids)
                    .map_err(|e| format!("reshape input_ids: {e}"))?;
                let ids_tensor = TensorRef::from_array_view(input_ids)
                    .map_err(|e| format!("ort decoder input_ids tensor: {e}"))?;
                let enc_tensor = TensorRef::from_array_view(hidden)
                    .map_err(|e| format!("ort decoder encoder_hidden_states tensor: {e}"))?;
                let dec_outputs = self
                    .decoder
                    .run(ort::inputs![
                        "input_ids" => ids_tensor,
                        "encoder_hidden_states" => enc_tensor
                    ])
                    .map_err(|e| format!("ort decoder run: {e}"))?;
                let (logits_shape, logits_data) = dec_outputs
                    .get("logits")
                    .ok_or_else(|| "decoder output missing 'logits'".to_string())?
                    .try_extract_tensor::<f32>()
                    .map_err(|e| format!("ort decoder extract logits: {e}"))?;
                // logits shape: [1, seq, 6144]; extract last-position slice.
                if logits_shape.len() < 3 {
                    return Err(format!(
                        "decoder logits rank {} < 3 (shape {:?})",
                        logits_shape.len(),
                        logits_shape
                    ));
                }
                let vocab = logits_shape[2] as usize;
                let last_offset = (seq_len - 1) * vocab;
                Ok(logits_data[last_offset..last_offset + vocab].to_vec())
            },
            2,   // bos
            3,   // eos
            300, // max_len
        )?;

        // 4. Detokenize.
        let ids_u32: Vec<u32> = generated.iter().map(|&id| id as u32).collect();
        Ok(self.detok.decode(&ids_u32))
    }
}

/// Greedy autoregressive decode.
///
/// `step(current_ids)` returns `Ok(next-token logits)` (length = vocab size) for
/// the position after `current_ids`, or `Err(msg)` on failure. Starts from
/// `[bos]`; appends argmax each iteration; stops when the chosen token == `eos`
/// OR the generated length reaches `max_len`. Returns the generated ids WITHOUT
/// the leading bos and WITHOUT a trailing eos.
pub fn greedy_decode<F: FnMut(&[i64]) -> Result<Vec<f32>, String>>(
    mut step: F,
    bos: i64,
    eos: i64,
    max_len: usize,
) -> Result<Vec<i64>, String> {
    let mut ids = vec![bos];
    let mut generated: Vec<i64> = Vec::new();
    loop {
        let logits = step(&ids)?;
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
    Ok(generated)
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
    fn argmax_empty_returns_zero() {
        // Must not panic on an empty slice; callers expect a valid index.
        assert_eq!(argmax(&[]), 0);
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
                Ok(one_hot(tok, 8))
            },
            1,  // bos
            2,  // eos
            10, // max_len
        )
        .unwrap();
        assert_eq!(result, vec![5, 7]);
    }

    #[test]
    fn greedy_decode_max_len_cap() {
        // closure always selects token 4 (never eos=2); result must be capped at max_len=5
        let result = greedy_decode(|_ids| Ok(one_hot(4, 8)), 1, 2, 5).unwrap();
        assert_eq!(result.len(), 5);
        assert!(result.iter().all(|&t| t == 4));
    }

    #[cfg(feature = "onnx")]
    #[test]
    #[ignore]
    fn recognizes_sample_crop() {
        let dir = std::path::PathBuf::from(
            std::env::var("MANGA_OCR_MODEL_DIR").expect("set MANGA_OCR_MODEL_DIR"),
        );
        let mut eng = MangaOcrEngine::load(
            &dir.join("encoder_model.onnx"),
            &dir.join("decoder_model.onnx"),
            &dir.join("vocab.txt"),
        )
        .unwrap();
        let img = image::open("tests-fixtures/manga_ocr_sample.png")
            .unwrap()
            .to_luma8();
        assert_eq!(eng.recognize(&img).unwrap(), "こんにちは");
    }
}
