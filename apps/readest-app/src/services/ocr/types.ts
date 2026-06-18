export type OcrSourceLang = 'ja' | 'ko' | 'zh';

export interface OcrBBox {
  x: number;
  y: number;
  w: number;
  h: number;
} // image pixels

export interface DetectedRegion {
  id: number;
  bbox: OcrBBox;
  original: string;
}

// A region after the TS layer has translated `original`.
export interface TranslatedRegion extends DetectedRegion {
  translation: string;
}
