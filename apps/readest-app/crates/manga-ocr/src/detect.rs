//! Comic-text-detector post-processing: decode the `blk` head output into
//! axis-aligned bounding boxes in original image coordinates.

use crate::page::BBox;
use ndarray::ArrayView2;

/// Decode the detector's `blk` output into text-block boxes in original px.
///
/// `blk` is an `[N, 7]` view where each row is
/// `[cx, cy, w, h, conf, cls0, cls1]` in 1024-space (raw, no sigmoid).
/// Boxes with `conf < conf_thresh` are discarded; the survivors go through
/// class-agnostic IoU NMS.  Remaining boxes are scaled to original image
/// coordinates and clamped.
pub fn blocks_from_raw(
    blk: ArrayView2<f32>,
    orig_w: u32,
    orig_h: u32,
    conf_thresh: f32,
    nms_thresh: f32,
) -> Vec<BBox> {
    const SIZE: f32 = 1024.0;
    let sx = orig_w as f32 / SIZE;
    let sy = orig_h as f32 / SIZE;

    // Each row must have at least 5 columns ([cx, cy, w, h, conf]); a malformed
    // output would otherwise panic on `row[4]`. Bail out with no boxes.
    if blk.ncols() < 5 {
        return Vec::new();
    }

    // --- threshold ---
    // Collect (conf, x1, y1, x2, y2) in original px for rows above threshold.
    let mut candidates: Vec<(f32, f32, f32, f32, f32)> = blk
        .rows()
        .into_iter()
        .filter_map(|row| {
            let conf = row[4];
            if conf < conf_thresh {
                return None;
            }
            let (cx, cy, w, h) = (row[0], row[1], row[2], row[3]);
            let x1 = ((cx - w / 2.0) * sx).clamp(0.0, orig_w as f32);
            let y1 = ((cy - h / 2.0) * sy).clamp(0.0, orig_h as f32);
            let x2 = ((cx + w / 2.0) * sx).clamp(0.0, orig_w as f32);
            let y2 = ((cy + h / 2.0) * sy).clamp(0.0, orig_h as f32);
            Some((conf, x1, y1, x2, y2))
        })
        .collect();

    // --- class-agnostic IoU NMS (sort descending by conf, greedy keep) ---
    candidates.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    let mut kept: Vec<(f32, f32, f32, f32, f32)> = Vec::new();
    'outer: for cand in candidates {
        for k in &kept {
            if iou(cand, *k) > nms_thresh {
                continue 'outer;
            }
        }
        kept.push(cand);
    }

    // --- convert to BBox (top-left + size, u32) ---
    kept.into_iter()
        .map(|(_, x1, y1, x2, y2)| BBox {
            x: x1 as u32,
            y: y1 as u32,
            w: (x2 - x1) as u32,
            h: (y2 - y1) as u32,
        })
        .collect()
}

/// Intersection-over-union of two `(conf, x1, y1, x2, y2)` boxes.
fn iou(a: (f32, f32, f32, f32, f32), b: (f32, f32, f32, f32, f32)) -> f32 {
    let ix1 = a.1.max(b.1);
    let iy1 = a.2.max(b.2);
    let ix2 = a.3.min(b.3);
    let iy2 = a.4.min(b.4);
    let inter_w = (ix2 - ix1).max(0.0);
    let inter_h = (iy2 - iy1).max(0.0);
    let inter = inter_w * inter_h;
    if inter == 0.0 {
        return 0.0;
    }
    let area_a = (a.3 - a.1) * (a.4 - a.2);
    let area_b = (b.3 - b.1) * (b.4 - b.2);
    inter / (area_a + area_b - inter)
}

/// Wraps an `ort` Session for the comic-text-detector ONNX model.
#[cfg(feature = "onnx")]
pub struct Detector {
    session: ort::session::Session,
}

#[cfg(feature = "onnx")]
impl Detector {
    /// Load the detector ONNX model from disk.
    pub fn load(path: &std::path::Path) -> Result<Self, String> {
        let session = ort::session::Session::builder()
            .map_err(|e| format!("ort builder: {e}"))?
            .commit_from_file(path)
            .map_err(|e| format!("ort load model: {e}"))?;
        Ok(Self { session })
    }

    /// Run detection on an RGB image; returns text-block boxes in original px.
    pub fn detect(
        &mut self,
        img: &image::RgbImage,
        conf_thresh: f32,
        nms_thresh: f32,
    ) -> Result<Vec<BBox>, String> {
        use crate::preprocess::detector_pixels;
        use ort::value::TensorRef;

        let (orig_w, orig_h) = (img.width(), img.height());
        let tensor = detector_pixels(img);
        let input_ref = TensorRef::from_array_view(tensor.view())
            .map_err(|e| format!("ort input tensor: {e}"))?;

        let outputs = self
            .session
            .run(ort::inputs!["images" => input_ref])
            .map_err(|e| format!("ort run: {e}"))?;

        // blk shape: [1, 64512, 7] — extract as [64512, 7] view.
        let blk_raw = outputs["blk"]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("ort extract blk: {e}"))?;
        let blk_flat = blk_raw.1;
        // blk_flat is a flat slice; reshape to [N, 7].
        let n = blk_flat.len() / 7;
        let blk_2d = ndarray::ArrayView2::from_shape((n, 7), blk_flat)
            .map_err(|e| format!("reshape blk: {e}"))?;

        Ok(blocks_from_raw(
            blk_2d,
            orig_w,
            orig_h,
            conf_thresh,
            nms_thresh,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ndarray::arr2;

    /// Build the canonical 4-row test fixture (all coords in 1024-space):
    ///   A: conf=0.9 — kept (above threshold, best conf)
    ///   B: conf=0.1 — filtered (below conf_thresh=0.4)
    ///   C: conf=0.5 — suppressed (heavily overlaps A)
    ///   D: conf=0.8 — kept (separate region)
    fn fixture() -> ndarray::Array2<f32> {
        arr2(&[
            // cx,   cy,   w,   h,   conf, cls0, cls1
            [512.0, 512.0, 200.0, 100.0, 0.9, 0.8, 0.1], // A — kept
            [100.0, 100.0, 50.0, 50.0, 0.1, 0.6, 0.4],   // B — conf filtered
            [520.0, 515.0, 200.0, 100.0, 0.5, 0.7, 0.3], // C — NMS suppressed (overlaps A)
            [800.0, 200.0, 100.0, 80.0, 0.8, 0.9, 0.1],  // D — kept
        ])
    }

    #[test]
    fn two_boxes_kept_at_unit_scale() {
        let data = fixture();
        let result = blocks_from_raw(data.view(), 1024, 1024, 0.4, 0.35);

        assert_eq!(result.len(), 2, "expected 2 boxes, got {:?}", result);

        // A: cx=512,cy=512,w=200,h=100 → x1=412,y1=462,x2=612,y2=562
        // BBox {x=412, y=462, w=200, h=100}
        assert_eq!(
            result[0],
            BBox {
                x: 412,
                y: 462,
                w: 200,
                h: 100
            },
            "box A mismatch: {:?}",
            result[0]
        );

        // D: cx=800,cy=200,w=100,h=80 → x1=750,y1=160,x2=850,y2=240
        // BBox {x=750, y=160, w=100, h=80}
        assert_eq!(
            result[1],
            BBox {
                x: 750,
                y: 160,
                w: 100,
                h: 80
            },
            "box D mismatch: {:?}",
            result[1]
        );
    }

    #[test]
    fn too_few_columns_returns_empty() {
        // A [N, 4] block lacks the conf column (index 4); must not panic.
        let data = arr2(&[[512.0, 512.0, 200.0, 100.0], [100.0, 100.0, 50.0, 50.0]]);
        let result = blocks_from_raw(data.view(), 1024, 1024, 0.4, 0.35);
        assert!(result.is_empty(), "expected no boxes, got {:?}", result);
    }

    #[test]
    fn x_scaling_at_double_width() {
        // orig_w=2048, orig_h=1024 → sx=2.0, sy=1.0
        let data = fixture();
        let result = blocks_from_raw(data.view(), 2048, 1024, 0.4, 0.35);

        assert_eq!(result.len(), 2, "expected 2 boxes, got {:?}", result);

        // A: x1=(512-100)*2=824, y1=512-50=462, w=200*2=400, h=100
        assert_eq!(
            result[0],
            BBox {
                x: 824,
                y: 462,
                w: 400,
                h: 100
            },
            "box A (2× width) mismatch: {:?}",
            result[0]
        );

        // D: x1=(800-50)*2=1500, y1=200-40=160, w=100*2=200, h=80
        assert_eq!(
            result[1],
            BBox {
                x: 1500,
                y: 160,
                w: 200,
                h: 80
            },
            "box D (2× width) mismatch: {:?}",
            result[1]
        );
    }
}
