import type { OcrSourceLang } from '@/services/ocr/types';

/** Map a book's primary language (ISO-639-1, possibly region-tagged) to an OCR
 *  source language, or null when it isn't one we recognize. */
export const detectOcrSourceLang = (primaryLanguage?: string): OcrSourceLang | null => {
  const lang = (primaryLanguage ?? '').toLowerCase();
  if (lang.startsWith('ja')) return 'ja';
  if (lang.startsWith('ko')) return 'ko';
  if (lang.startsWith('zh')) return 'zh';
  return null;
};

/** Remembered per-book override wins; otherwise detect from metadata. */
export const resolveOcrSourceLang = (
  primaryLanguage: string | undefined,
  remembered?: OcrSourceLang,
): OcrSourceLang | null => remembered ?? detectOcrSourceLang(primaryLanguage);
