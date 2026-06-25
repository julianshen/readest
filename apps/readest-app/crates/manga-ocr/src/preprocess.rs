use image::{imageops::FilterType, GrayImage, RgbImage};
use ndarray::Array4;

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

/// PaddleOCR CTC recognizer input: resize to height `input_h` keeping aspect
/// ratio (dynamic width), replicate gray→3ch (so BGR/RGB ordering is moot for a
/// grayscale crop), normalize (v/255 - 0.5)/0.5. Returns [1,3,input_h,W].
pub fn ctc_rec_pixels(img: &GrayImage, input_h: u32) -> Array4<f32> {
    let (w, h) = img.dimensions();
    let out_w = (((input_h as f32) * (w as f32) / (h.max(1) as f32)).round() as u32).max(1);
    let resized = image::imageops::resize(img, out_w, input_h, FilterType::Triangle);
    let mut tensor = Array4::<f32>::zeros([1, 3, input_h as usize, out_w as usize]);
    for y in 0..input_h as usize {
        for x in 0..out_w as usize {
            let v = resized.get_pixel(x as u32, y as u32).0[0] as f32 / 255.0;
            let norm = (v - 0.5) / 0.5;
            tensor[[0, 0, y, x]] = norm;
            tensor[[0, 1, y, x]] = norm;
            tensor[[0, 2, y, x]] = norm;
        }
    }
    tensor
}

/// Detector input: STRETCH to exactly 1024×1024 (CatmullRom), RGB, normalize v/255.
/// Returns [1,3,1024,1024]. The caller supplies original (w,h) to the decoder for
/// scaling boxes back to original pixel coordinates.
pub fn detector_pixels(img: &RgbImage) -> Array4<f32> {
    const TARGET: u32 = 1024;
    let resized = image::imageops::resize(img, TARGET, TARGET, FilterType::CatmullRom);
    let mut tensor = Array4::<f32>::zeros([1, 3, TARGET as usize, TARGET as usize]);
    for y in 0..TARGET as usize {
        for x in 0..TARGET as usize {
            let px = resized.get_pixel(x as u32, y as u32).0;
            tensor[[0, 0, y, x]] = px[0] as f32 / 255.0;
            tensor[[0, 1, y, x]] = px[1] as f32 / 255.0;
            tensor[[0, 2, y, x]] = px[2] as f32 / 255.0;
        }
    }
    tensor
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
    fn ctc_rec_pixels_shape_dynamic_width_and_norm() {
        let img = GrayImage::from_pixel(40, 20, image::Luma([0u8]));
        let t = ctc_rec_pixels(&img, 48);
        assert_eq!(t.shape(), &[1, 3, 48, 96]);
        assert!((t[[0, 0, 0, 0]] - (-1.0)).abs() < 1e-4);
        assert!((t[[0, 1, 10, 10]] - t[[0, 2, 10, 10]]).abs() < 1e-6);
    }

    #[test]
    fn ctc_rec_pixels_min_width_one() {
        let img = GrayImage::from_pixel(1, 1000, image::Luma([255u8]));
        let t = ctc_rec_pixels(&img, 48);
        assert_eq!(t.shape()[3], 1);
        assert!((t[[0, 0, 0, 0]] - 1.0).abs() < 1e-4);
    }

    #[test]
    fn detector_pixels_shape_and_values() {
        // Any image is stretched to exactly 1024×1024.
        let img = RgbImage::new(512, 256);
        let t = detector_pixels(&img);

        assert_eq!(t.shape(), &[1, 3, 1024, 1024]);

        // All pixels in the source image are black (0,0,0), so every tensor
        // value should be 0.0 (= 0/255).
        let expected = 0.0_f32;
        let actual = t[[0, 0, 0, 0]];
        assert!(
            (actual - expected).abs() < 1e-6,
            "expected {expected}, got {actual}"
        );

        // Verify a known non-zero pixel: create a 1×1 image with R=128.
        let img2 = RgbImage::from_pixel(1, 1, image::Rgb([128u8, 0, 0]));
        let t2 = detector_pixels(&img2);
        assert_eq!(t2.shape(), &[1, 3, 1024, 1024]);
        let r = t2[[0, 0, 0, 0]];
        assert!(
            (r - 128.0 / 255.0).abs() < 1e-4,
            "expected ≈{}, got {r}",
            128.0_f32 / 255.0
        );
    }
}
