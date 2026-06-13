import { describe, expect, it } from 'vitest';

import { composeImageFilter } from '@/utils/style';

describe('composeImageFilter', () => {
  it('returns empty string for all defaults and no invert', () => {
    expect(
      composeImageFilter({ contrast: 100, brightness: 100, grayscale: false, invert: false }),
    ).toBe('');
  });

  it('emits contrast only when non-default', () => {
    expect(
      composeImageFilter({ contrast: 140, brightness: 100, grayscale: false, invert: false }),
    ).toBe('filter: contrast(140%);');
  });

  it('composes the boost preset (contrast + brightness + grayscale)', () => {
    expect(
      composeImageFilter({ contrast: 140, brightness: 110, grayscale: true, invert: false }),
    ).toBe('filter: contrast(140%) brightness(110%) grayscale(1);');
  });

  it('keeps dark-mode invert first when combined with adjustments', () => {
    expect(
      composeImageFilter({ contrast: 140, brightness: 100, grayscale: false, invert: true }),
    ).toBe('filter: invert(100%) contrast(140%);');
  });

  it('emits invert alone when only invert is set', () => {
    expect(
      composeImageFilter({ contrast: 100, brightness: 100, grayscale: false, invert: true }),
    ).toBe('filter: invert(100%);');
  });
});
