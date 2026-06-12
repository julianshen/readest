import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeComicBook } from 'foliate-js/comic-book.js';
import { sectionNeedsRespread } from 'foliate-js/fixed-layout.js';

type Dimensions = { width: number; height: number };

// jsdom has no URL.createObjectURL / createImageBitmap; stub both. The image
// "blobs" carry their entry name as text so the bitmap stub can map name → size.
const stubImageDecoding = (images: Record<string, Dimensions>) => {
  vi.stubGlobal('createImageBitmap', async (blob: Blob) => {
    const name = await blob.text();
    const dims = images[name];
    if (!dims) throw new Error('decode failure');
    return { ...dims, close: vi.fn() };
  });
};

const openComic = async (images: Record<string, Dimensions | null>) => {
  const names = Object.keys(images);
  const entries = names.map((filename) => ({ filename }));
  const loadBlob = async (name: string) => new Blob([name], { type: 'image/png' });
  stubImageDecoding(
    Object.fromEntries(Object.entries(images).filter(([, dims]) => dims !== null)) as Record<
      string,
      Dimensions
    >,
  );
  return makeComicBook(
    { entries, loadBlob, getSize: () => 0, getComment: async () => '' },
    new File([], 'fixture.cbz'),
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('comic-book wide-image spread detection', () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = () => 'blob:fake';
  URL.revokeObjectURL = () => {};
  afterEach(() => {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  it('marks a wide page center and fires the spread hint', async () => {
    const book = await openComic({
      '0.png': { width: 800, height: 1200 },
      '1.png': { width: 2000, height: 1400 },
    });
    const hint = vi.fn();
    book.onSectionSpreadHint = hint;
    await book.sections[1].load();
    expect(book.sections[1].pageSpread).toBe('center');
    expect(hint).toHaveBeenCalledWith(book.sections[1]);
  });

  it('leaves tall pages unmarked and fires no hint', async () => {
    const book = await openComic({ '0.png': { width: 800, height: 1200 } });
    const hint = vi.fn();
    book.onSectionSpreadHint = hint;
    await book.sections[0].load();
    expect(book.sections[0].pageSpread).toBeUndefined();
    expect(hint).not.toHaveBeenCalled();
  });

  it('treats decode failures as normal single pages', async () => {
    const book = await openComic({ '0.png': null });
    const hint = vi.fn();
    book.onSectionSpreadHint = hint;
    await expect(book.sections[0].load()).resolves.toBeTruthy();
    expect(book.sections[0].pageSpread).toBeUndefined();
    expect(hint).not.toHaveBeenCalled();
  });

  it('still loads when createImageBitmap is unavailable', async () => {
    const book = await openComic({ '0.png': { width: 2000, height: 1000 } });
    vi.unstubAllGlobals(); // remove createImageBitmap
    await expect(book.sections[0].load()).resolves.toBeTruthy();
    expect(book.sections[0].pageSpread).toBeUndefined();
  });

  it('fires the hint at most once per section', async () => {
    const book = await openComic({ '0.png': { width: 2000, height: 1000 } });
    const hint = vi.fn();
    book.onSectionSpreadHint = hint;
    await book.sections[0].load();
    await book.sections[0].load();
    expect(hint).toHaveBeenCalledTimes(1);
  });
});

describe('sectionNeedsRespread', () => {
  const a = { id: 'a' };
  const b = { id: 'b' };
  const c = { id: 'c' };

  it('returns true when the section is currently paired left/right', () => {
    expect(sectionNeedsRespread([{ right: a }, { left: b, right: c }], b)).toBe(true);
    expect(sectionNeedsRespread([{ right: a }, { left: b, right: c }], c)).toBe(true);
  });

  it('returns false when the section is already centered', () => {
    expect(sectionNeedsRespread([{ center: a }, { left: b, right: c }], a)).toBe(false);
  });

  it('returns false when the section is not in the map or the map is missing', () => {
    expect(sectionNeedsRespread([{ right: a }], b)).toBe(false);
    expect(sectionNeedsRespread(undefined, a)).toBe(false);
  });
});
