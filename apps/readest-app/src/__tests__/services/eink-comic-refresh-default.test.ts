import { describe, expect, it } from 'vitest';

import { comicViewSettingsDefaults } from '@/services/bookService';

describe('comicViewSettingsDefaults', () => {
  it('seeds full per-page refresh for comics on e-ink', () => {
    expect(comicViewSettingsDefaults(true)).toMatchObject({ epdRefreshInterval: 1 });
  });

  it('does not seed a refresh interval off e-ink', () => {
    expect(comicViewSettingsDefaults(false).epdRefreshInterval).toBeUndefined();
  });

  it('always includes the base fixed-layout defaults', () => {
    expect(comicViewSettingsDefaults(false)).toMatchObject({ overrideColor: false });
  });
});
