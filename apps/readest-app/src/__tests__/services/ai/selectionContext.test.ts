import { describe, it, expect } from 'vitest';
import { buildSelectionContext } from '@/services/ai/utils/selectionContext';

describe('buildSelectionContext', () => {
  it('includes preceding text and the marked selection, never text after it', () => {
    const section = 'BEFORE_TEXT SELECTED_PHRASE AFTER_TEXT';
    const ctx = buildSelectionContext(section, 'SELECTED_PHRASE', 1000);
    expect(ctx).toBe('BEFORE_TEXT «SELECTED_PHRASE»');
    expect(ctx).not.toContain('AFTER_TEXT');
  });

  it('caps the preceding context to maxChars', () => {
    const before = 'x'.repeat(50);
    const ctx = buildSelectionContext(`${before}SEL after`, 'SEL', 10);
    expect(ctx).toBe(`${'x'.repeat(10)}«SEL»`);
  });

  it('falls back to the marked selection when not found in the section', () => {
    expect(buildSelectionContext('unrelated section', 'MISSING', 1000)).toBe('«MISSING»');
  });
});
