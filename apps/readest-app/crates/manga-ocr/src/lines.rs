//! Split a comic text-block crop into horizontal text lines. The PaddleOCR CTC
//! recognizer reads one line at a time, so a multi-line bubble must be sliced
//! first (verified necessary in the plan's Task 1).

use image::GrayImage;

/// Row-ink projection: group rows whose dark-pixel count exceeds 10% of the
/// densest row into bands (padded 2px), returning each as a sub-image. Returns
/// the crop unchanged when it finds 0 or 1 line (single-line bubble = no-op).
/// Assumes dark text on a light background (the comic-bubble norm).
pub fn split_text_lines(crop: &GrayImage) -> Vec<GrayImage> {
    let (w, h) = crop.dimensions();
    if w == 0 || h == 0 {
        return vec![crop.clone()];
    }
    let mut ink = vec![0u32; h as usize];
    for y in 0..h {
        let mut c = 0u32;
        for x in 0..w {
            if crop.get_pixel(x, y).0[0] < 128 {
                c += 1;
            }
        }
        ink[y as usize] = c;
    }
    let maxink = *ink.iter().max().unwrap_or(&0);
    if maxink == 0 {
        return vec![crop.clone()];
    }
    let thresh = ((maxink as f32) * 0.10).ceil() as u32;
    let mut bands: Vec<(u32, u32)> = Vec::new();
    let mut start: Option<u32> = None;
    for y in 0..h {
        let inky = ink[y as usize] >= thresh;
        match (inky, start) {
            (true, None) => start = Some(y),
            (false, Some(s)) => {
                bands.push((s, y));
                start = None;
            }
            _ => {}
        }
    }
    if let Some(s) = start {
        bands.push((s, h));
    }
    if bands.len() <= 1 {
        return vec![crop.clone()];
    }
    bands
        .into_iter()
        .map(|(s, e)| {
            let y0 = s.saturating_sub(2);
            let y1 = (e + 2).min(h);
            image::imageops::crop_imm(crop, 0, y0, w, y1 - y0).to_image()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{GrayImage, Luma};

    fn img_with_bands(w: u32, h: u32, bands: &[(u32, u32)]) -> GrayImage {
        let mut img = GrayImage::from_pixel(w, h, Luma([255]));
        for &(s, e) in bands {
            for y in s..e {
                for x in 0..w {
                    img.put_pixel(x, y, Luma([0]));
                }
            }
        }
        img
    }

    #[test]
    fn splits_two_bands_separated_by_gap() {
        let img = img_with_bands(20, 20, &[(2, 6), (12, 16)]);
        let lines = split_text_lines(&img);
        assert_eq!(lines.len(), 2);
        assert!(lines[0].height() < img.height());
    }

    #[test]
    fn single_band_returns_whole_crop() {
        let img = img_with_bands(20, 20, &[(4, 10)]);
        let lines = split_text_lines(&img);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].dimensions(), img.dimensions());
    }

    #[test]
    fn blank_crop_returns_itself() {
        let img = GrayImage::from_pixel(10, 10, Luma([255]));
        let lines = split_text_lines(&img);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].dimensions(), (10, 10));
    }
}
