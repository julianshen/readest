import { describe, it, expect } from 'vitest';
import { detectOcrSourceLang, resolveOcrSourceLang } from '@/services/ocr/sourceLang';

describe('source language resolution', () => {
  it('detects ja/ko/zh from a primary language code, else null', () => {
    expect(detectOcrSourceLang('ja')).toBe('ja');
    expect(detectOcrSourceLang('ko')).toBe('ko');
    expect(detectOcrSourceLang('zh')).toBe('zh');
    expect(detectOcrSourceLang('zh-CN')).toBe('zh');
    expect(detectOcrSourceLang('zh-Hant')).toBe('zh');
    expect(detectOcrSourceLang('en')).toBeNull();
    expect(detectOcrSourceLang(undefined)).toBeNull();
  });

  it('prefers a remembered override over detection', () => {
    expect(resolveOcrSourceLang('ja', 'ko')).toBe('ko');
    expect(resolveOcrSourceLang('en', 'zh')).toBe('zh');
    expect(resolveOcrSourceLang('ko', undefined)).toBe('ko');
    expect(resolveOcrSourceLang('en', undefined)).toBeNull();
  });
});
