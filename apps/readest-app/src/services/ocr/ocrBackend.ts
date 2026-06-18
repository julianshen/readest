import { invoke } from '@tauri-apps/api/core';
import type { DetectedRegion, OcrSourceLang } from './types';

// Detect + OCR a comic page in the Rust backend. Returns image-pixel boxes +
// the original (untranslated) text per region.
export const ocrPageRegions = (
  imageBytes: Uint8Array,
  sourceLang: OcrSourceLang,
): Promise<DetectedRegion[]> =>
  invoke<DetectedRegion[]>('ocr_page_regions', {
    imageBytes: Array.from(imageBytes),
    sourceLang,
  });
