//! `detect_and_ocr`: detect + OCR a comic page into translatable regions.
//! Phase 1a ships a deterministic STUB so the frontend can integrate against a
//! real IPC command; a later phase replaces the body with the real pipeline.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BBox {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedRegion {
    pub id: u32,
    pub bbox: BBox,
    pub original: String,
}

/// Decode the page enough to know its size, then return deterministic
/// placeholder regions positioned relative to the real image dimensions, so the
/// frontend overlay can be exercised with correct coordinate mapping.
pub fn detect_and_ocr(
    image_bytes: &[u8],
    _source_lang: &str,
) -> Result<Vec<DetectedRegion>, String> {
    let img = image::load_from_memory(image_bytes).map_err(|e| format!("decode image: {e}"))?;
    let (w, h) = (img.width(), img.height());
    Ok(vec![
        DetectedRegion {
            id: 0,
            bbox: BBox {
                x: w / 10,
                y: h / 10,
                w: w / 4,
                h: h / 8,
            },
            original: "サンプル".to_string(),
        },
        DetectedRegion {
            id: 1,
            bbox: BBox {
                x: w / 2,
                y: h / 2,
                w: w / 4,
                h: h / 8,
            },
            original: "テスト".to_string(),
        },
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_regions_scaled_to_image_size() {
        // 100x80 white PNG -> deterministic boxes scaled from the size.
        let mut buf = std::io::Cursor::new(Vec::new());
        image::RgbImage::from_pixel(100, 80, image::Rgb([255, 255, 255]))
            .write_to(&mut buf, image::ImageFormat::Png)
            .unwrap();
        let regions = detect_and_ocr(buf.get_ref(), "ja").unwrap();
        assert_eq!(regions.len(), 2);
        assert_eq!(
            regions[0].bbox,
            BBox {
                x: 10,
                y: 8,
                w: 25,
                h: 10
            }
        );
        assert_eq!(regions[0].original, "サンプル");
    }

    #[test]
    fn errors_on_undecodable_bytes() {
        assert!(detect_and_ocr(&[0, 1, 2, 3], "ja").is_err());
    }
}
