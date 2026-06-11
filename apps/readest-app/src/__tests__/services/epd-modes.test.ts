import { describe, it, expect, vi } from 'vitest';

vi.mock('@/utils/config', () => ({
  getDefaultMaxBlockSize: vi.fn(() => 1600),
  getDefaultMaxInlineSize: vi.fn(() => 720),
}));
vi.mock('@/utils/misc', () => ({
  stubTranslation: vi.fn((key: string) => key),
  getOSPlatform: vi.fn(() => 'macos'),
}));

import { EPD_MODES, filterEpdModes } from '@/services/constants';

describe('filterEpdModes', () => {
  it('returns all modes when the device reports no mode list', () => {
    expect(filterEpdModes([])).toEqual(EPD_MODES);
  });

  it('keeps only modes the device EPDMode enum actually supports', () => {
    const filtered = filterEpdModes(['AUTO', 'TEXT']);
    expect(filtered.map((m) => m.value)).toEqual(['AUTO', 'TEXT']);
  });

  it('drops UpdateMode-only values like GC/GU that EPDMode does not accept', () => {
    const filtered = filterEpdModes(['AUTO', 'FULL', 'TEXT', 'A2']);
    expect(filtered.map((m) => m.value)).not.toContain('GC');
    expect(filtered.map((m) => m.value)).not.toContain('GU');
  });
});
