//! Real OcrPipeline: detect text blocks then OCR each crop.

#[cfg(feature = "onnx")]
pub struct OcrPipeline {
    detector: crate::detect::Detector,
    engine: Box<dyn crate::recognize::OcrEngine + Send>,
    pub conf_thresh: f32,
    pub nms_thresh: f32,
}

#[cfg(feature = "onnx")]
impl OcrPipeline {
    /// Load the shared detector (from `detector_path`) + the per-language engine
    /// files (from `lang_dir`). `ja` → manga-ocr seq2seq; `ko`/`zh` → PP-OCRv5 CTC.
    pub fn load(
        detector_path: &std::path::Path,
        lang_dir: &std::path::Path,
        lang: &str,
    ) -> Result<Self, String> {
        let detector = crate::detect::Detector::load(detector_path)?;
        let engine: Box<dyn crate::recognize::OcrEngine + Send> = match lang {
            "ja" => Box::new(crate::recognize::MangaOcrEngine::load(
                &lang_dir.join("encoder_model.onnx"),
                &lang_dir.join("decoder_model.onnx"),
                &lang_dir.join("vocab.txt"),
            )?),
            "ko" | "zh" => {
                let spec = crate::models::ctc_spec(lang)
                    .ok_or_else(|| format!("no ctc spec for {lang}"))?;
                Box::new(crate::recognize::CtcRecognizer::load(
                    &lang_dir.join(spec.rec_onnx),
                    &lang_dir.join(spec.dict),
                    spec.input_h,
                )?)
            }
            other => return Err(format!("unsupported source language: {other}")),
        };
        Ok(Self {
            detector,
            engine,
            conf_thresh: 0.3,
            nms_thresh: 0.35,
        })
    }

    /// Detect text blocks, OCR each via the bound engine, return regions.
    pub fn run(&mut self, image_bytes: &[u8]) -> Result<Vec<crate::page::DetectedRegion>, String> {
        let dyn_img =
            image::load_from_memory(image_bytes).map_err(|e| format!("decode image: {e}"))?;
        let rgb = dyn_img.to_rgb8();
        let luma = dyn_img.to_luma8();
        let (img_w, img_h) = (rgb.width(), rgb.height());

        let boxes = self
            .detector
            .detect(&rgb, self.conf_thresh, self.nms_thresh)?;
        let mut regions = Vec::with_capacity(boxes.len());
        for (i, b) in boxes.into_iter().enumerate() {
            if b.w == 0 || b.h == 0 || b.x >= img_w || b.y >= img_h {
                continue;
            }
            let x = b.x.min(img_w.saturating_sub(1));
            let y = b.y.min(img_h.saturating_sub(1));
            let w = b.w.min(img_w - x);
            let h = b.h.min(img_h - y);
            if w == 0 || h == 0 {
                continue;
            }
            let crop = image::imageops::crop_imm(&luma, x, y, w, h).to_image();
            let text = self.engine.recognize(&crop)?;
            regions.push(crate::page::DetectedRegion {
                id: i as u32,
                bbox: b,
                original: text,
            });
        }
        Ok(regions)
    }
}

#[cfg(all(feature = "onnx", test))]
mod tests {
    use super::*;

    #[test]
    #[ignore]
    fn pipeline_detects_and_recognizes_sample_page() {
        // Exercise the split cache layout: detector in shared/, engine in <lang>/.
        let root = std::path::PathBuf::from(
            std::env::var("MANGA_OCR_MODEL_ROOT").expect("set MANGA_OCR_MODEL_ROOT"),
        );
        let detector = root
            .join(crate::models::OCR_SHARED_DIR)
            .join(crate::models::DETECTOR_FILE);
        let lang_dir = root.join("ja");
        let mut p = OcrPipeline::load(&detector, &lang_dir, "ja").unwrap();
        p.conf_thresh = 0.12;
        let bytes =
            std::fs::read("tests-fixtures/manga_page_sample.png").expect("fixture not found");
        let regions = p.run(&bytes).unwrap();
        assert!(!regions.is_empty(), "expected at least one region");
        assert!(regions.iter().any(|r| r.original.contains("こんにち")));
        assert!(OcrPipeline::load(&detector, &lang_dir, "xx").is_err());
    }
}
