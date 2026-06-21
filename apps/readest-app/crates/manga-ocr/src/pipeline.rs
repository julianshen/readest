//! Real OcrPipeline: detect text blocks then OCR each crop.

#[cfg(feature = "onnx")]
use crate::recognize::OcrEngine;

#[cfg(feature = "onnx")]
pub struct OcrPipeline {
    detector: crate::detect::Detector,
    ja_engine: crate::recognize::MangaOcrEngine,
    pub conf_thresh: f32,
    pub nms_thresh: f32,
}

#[cfg(feature = "onnx")]
impl OcrPipeline {
    /// Load all models from a directory containing `comic-text-detector.onnx`,
    /// `encoder_model.onnx`, `decoder_model.onnx`, and `vocab.txt`.
    pub fn load(model_dir: &std::path::Path) -> Result<Self, String> {
        let detector = crate::detect::Detector::load(&model_dir.join("comic-text-detector.onnx"))?;
        let ja_engine = crate::recognize::MangaOcrEngine::load(
            &model_dir.join("encoder_model.onnx"),
            &model_dir.join("decoder_model.onnx"),
            &model_dir.join("vocab.txt"),
        )?;
        Ok(Self {
            detector,
            ja_engine,
            conf_thresh: 0.3,
            nms_thresh: 0.35,
        })
    }

    /// Detect text blocks, OCR each, return regions (image-pixel boxes + text).
    pub fn run(
        &mut self,
        image_bytes: &[u8],
        source_lang: &str,
    ) -> Result<Vec<crate::page::DetectedRegion>, String> {
        if source_lang != "ja" {
            return Err(format!("unsupported source language: {source_lang}"));
        }

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
            if b.w == 0 || b.h == 0 {
                continue;
            }
            // Discard boxes whose top-left is outside the image: clamping such a
            // box would yield a meaningless 1×1 edge crop.
            if b.x >= img_w || b.y >= img_h {
                continue;
            }
            // Clamp crop rect to image bounds.
            let x = b.x.min(img_w.saturating_sub(1));
            let y = b.y.min(img_h.saturating_sub(1));
            let w = b.w.min(img_w - x);
            let h = b.h.min(img_h - y);
            if w == 0 || h == 0 {
                continue;
            }
            let crop = image::imageops::crop_imm(&luma, x, y, w, h).to_image();
            let text = self.ja_engine.recognize(&crop)?;
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
        let dir = std::path::PathBuf::from(
            std::env::var("MANGA_OCR_MODEL_DIR").expect("set MANGA_OCR_MODEL_DIR"),
        );
        let mut p = OcrPipeline::load(&dir).unwrap();
        p.conf_thresh = 0.12; // synthetic fixture scores ~0.19
        let bytes =
            std::fs::read("tests-fixtures/manga_page_sample.png").expect("fixture not found");
        let regions = p.run(&bytes, "ja").unwrap();
        assert!(
            !regions.is_empty(),
            "expected at least one region, got none"
        );
        assert!(
            regions.iter().any(|r| r.original.contains("こんにち")),
            "expected 「こんにちは」; got: {:?}",
            regions.iter().map(|r| &r.original).collect::<Vec<_>>()
        );
        // unsupported lang errors:
        assert!(p.run(&bytes, "xx").is_err());
    }
}
