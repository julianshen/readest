import { describe, expect, it } from 'vitest';

import { shouldRecreateViewerOnWritingModeChange } from '@/utils/book';

describe('shouldRecreateViewerOnWritingModeChange', () => {
  it('returns false when the mode is unchanged', () => {
    expect(shouldRecreateViewerOnWritingModeChange('auto', 'auto', true)).toBe(false);
  });

  it('recreates on any change for fixed-layout books', () => {
    expect(shouldRecreateViewerOnWritingModeChange('auto', 'horizontal-tb', true)).toBe(true);
    expect(shouldRecreateViewerOnWritingModeChange('horizontal-tb', 'horizontal-rl', true)).toBe(
      true,
    );
  });

  it('recreates for reflowable books only when entering or leaving an rl mode', () => {
    expect(shouldRecreateViewerOnWritingModeChange('auto', 'horizontal-rl', false)).toBe(true);
    expect(shouldRecreateViewerOnWritingModeChange('vertical-rl', 'auto', false)).toBe(true);
    expect(shouldRecreateViewerOnWritingModeChange('auto', 'horizontal-tb', false)).toBe(false);
  });
});
