use image::{imageops::FilterType, GrayImage, RgbImage};
use ndarray::Array4;

/// Letterbox transform params, to un-project detector boxes back to original px.
pub struct Letterbox {
    pub scale: f32,
    pub pad_x: u32,
    pub pad_y: u32,
}

/// manga-ocr ViT input: resize to 224x224 (bilinear/Triangle), replicate gray->3ch,
/// normalize (v/255 - 0.5)/0.5. Returns [1,3,224,224].
pub fn manga_ocr_pixels(img: &GrayImage) -> Array4<f32> {
    const SIZE: u32 = 224;
    let resized = image::imageops::resize(img, SIZE, SIZE, FilterType::Triangle);
    let mut tensor = Array4::<f32>::zeros([1, 3, SIZE as usize, SIZE as usize]);
    for y in 0..SIZE as usize {
        for x in 0..SIZE as usize {
            let v = resized.get_pixel(x as u32, y as u32).0[0] as f32 / 255.0;
            let norm = (v - 0.5) / 0.5;
            tensor[[0, 0, y, x]] = norm;
            tensor[[0, 1, y, x]] = norm;
            tensor[[0, 2, y, x]] = norm;
        }
    }
    tensor
}

/// detector input: letterbox to 1024x1024 preserving aspect ratio (pad value 114),
/// RGB, normalize v/255 (range 0..1). Returns ([1,3,1024,1024], Letterbox).
pub fn detector_pixels(img: &RgbImage) -> (Array4<f32>, Letterbox) {
    const TARGET: u32 = 1024;
    const PAD_VAL: f32 = 114.0 / 255.0;

    let (w, h) = (img.width(), img.height());
    let scale = (TARGET as f32 / w as f32).min(TARGET as f32 / h as f32);
    let new_w = (w as f32 * scale).round() as u32;
    let new_h = (h as f32 * scale).round() as u32;

    let resized = image::imageops::resize(img, new_w, new_h, FilterType::Triangle);

    let pad_x = (TARGET - new_w) / 2;
    let pad_y = (TARGET - new_h) / 2;

    let mut tensor = Array4::<f32>::from_elem([1, 3, TARGET as usize, TARGET as usize], PAD_VAL);

    for y in 0..new_h as usize {
        for x in 0..new_w as usize {
            let px = resized.get_pixel(x as u32, y as u32).0;
            let ty = y + pad_y as usize;
            let tx = x + pad_x as usize;
            tensor[[0, 0, ty, tx]] = px[0] as f32 / 255.0;
            tensor[[0, 1, ty, tx]] = px[1] as f32 / 255.0;
            tensor[[0, 2, ty, tx]] = px[2] as f32 / 255.0;
        }
    }

    (
        tensor,
        Letterbox {
            scale,
            pad_x,
            pad_y,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manga_ocr_pixels_shape_and_values() {
        // 2x2 gray image: top-left=0, top-right=255, bottom-left=0, bottom-right=255
        let img = GrayImage::from_raw(2, 2, vec![0u8, 255, 0, 255]).unwrap();
        let t = manga_ocr_pixels(&img);

        // Shape must be [1,3,224,224]
        assert_eq!(t.shape(), &[1, 3, 224, 224]);

        // top-left corner (0,0) originated from pixel value 0 → normalized to -1.0
        let val_zero = t[[0, 0, 0, 0]];
        assert!(
            (val_zero - (-1.0_f32)).abs() < 1e-4,
            "expected -1.0 at (0,0,0,0), got {val_zero}"
        );

        // top-right corner (0,0,0,223) originated from pixel value 255 → normalized to 1.0
        let val_one = t[[0, 0, 0, 223]];
        assert!(
            (val_one - 1.0_f32).abs() < 1e-4,
            "expected 1.0 at (0,0,0,223), got {val_one}"
        );

        // All 3 channels are identical at a given (h, w)
        for h in [0usize, 100, 223] {
            for w in [0usize, 100, 223] {
                let c0 = t[[0, 0, h, w]];
                let c1 = t[[0, 1, h, w]];
                let c2 = t[[0, 2, h, w]];
                assert!(
                    (c0 - c1).abs() < 1e-6 && (c0 - c2).abs() < 1e-6,
                    "channels differ at ({h},{w}): {c0} {c1} {c2}"
                );
            }
        }
    }

    #[test]
    fn detector_pixels_shape_scale_and_padding() {
        // 512x256 image: scale = min(1024/512, 1024/256) = min(2.0, 4.0) = 2.0
        // new_w=1024, new_h=512, pad_x=0, pad_y=(1024-512)/2=256
        let img = RgbImage::new(512, 256);
        let (t, lb) = detector_pixels(&img);

        assert_eq!(t.shape(), &[1, 3, 1024, 1024]);
        assert!(
            (lb.scale - 2.0_f32).abs() < 1e-6,
            "expected scale=2.0, got {}",
            lb.scale
        );
        assert_eq!(lb.pad_x, 0, "expected pad_x=0");
        assert!(lb.pad_y > 0, "expected pad_y > 0, got {}", lb.pad_y);

        // Spot-check: first row (y=0) is a padded region → value = 114/255
        let expected = 114.0_f32 / 255.0;
        let actual = t[[0, 0, 0, 0]];
        assert!(
            (actual - expected).abs() < 1e-6,
            "padded region: expected {expected}, got {actual}"
        );
    }
}
