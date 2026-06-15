import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeComicBook } from 'foliate-js/comic-book.js';
import { assembleSpreads, sectionNeedsRespread } from 'foliate-js/fixed-layout.js';

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

// Flush pending microtasks/timers so the non-blocking spread probe finishes.
const flushProbe = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('comic-book wide-image spread detection', () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  beforeEach(() => {
    URL.createObjectURL = () => 'blob:fake';
    URL.revokeObjectURL = () => {};
  });
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
    await flushProbe();
    expect(book.sections[1].pageSpread).toBe('center');
    expect(hint).toHaveBeenCalledWith(book.sections[1]);
  });

  it('leaves tall pages unmarked and fires no hint', async () => {
    const book = await openComic({ '0.png': { width: 800, height: 1200 } });
    const hint = vi.fn();
    book.onSectionSpreadHint = hint;
    await book.sections[0].load();
    await flushProbe();
    expect(book.sections[0].pageSpread).toBeUndefined();
    expect(hint).not.toHaveBeenCalled();
  });

  it('treats decode failures as normal single pages', async () => {
    const book = await openComic({ '0.png': null });
    const hint = vi.fn();
    book.onSectionSpreadHint = hint;
    await expect(book.sections[0].load()).resolves.toBeTruthy();
    await flushProbe();
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
    await flushProbe();
    await book.sections[0].load();
    await flushProbe();
    expect(hint).toHaveBeenCalledTimes(1);
  });

  // The spread probe decodes the full-resolution image only to detect wide
  // (double-page) scans. In scroll/webtoon mode the hint is ignored anyway, so
  // load() must NOT block page appearance on that decode — the image renders
  // immediately and the hint arrives later (matching the late-hint design).
  it('resolves load() without waiting for the spread-probe decode', async () => {
    const names = ['0.png'];
    const entries = names.map((filename) => ({ filename }));
    const loadBlob = async (name: string) => new Blob([name], { type: 'image/png' });
    let releaseDecode!: () => void;
    const decodeGate = new Promise<void>((resolve) => {
      releaseDecode = resolve;
    });
    vi.stubGlobal('createImageBitmap', async () => {
      await decodeGate; // stays pending until the test releases it
      return { width: 2000, height: 1000, close: vi.fn() };
    });
    const book = await makeComicBook(
      { entries, loadBlob, getSize: () => 0, getComment: async () => '' },
      new File([], 'fixture.cbz'),
    );
    const hint = vi.fn();
    book.onSectionSpreadHint = hint;

    // load() must resolve even though the decode is still gated.
    const page = await book.sections[0].load();
    expect(page).toBeTruthy();
    expect(hint).not.toHaveBeenCalled();

    // Once the decode completes, the hint still fires for paginated respread.
    releaseDecode();
    await flushProbe();
    expect(book.sections[0].pageSpread).toBe('center');
    expect(hint).toHaveBeenCalledWith(book.sections[0]);
  });
});

describe('assembleSpreads', () => {
  type Section = { id: number; pageSpread?: string };
  const makeSections = (count: number, marks: Record<number, string> = {}): Section[] =>
    Array.from({ length: count }, (_, i) =>
      marks[i] ? { id: i, pageSpread: marks[i] } : { id: i },
    );

  it('gives consecutive center sections their own spread records', () => {
    const sections = makeSections(4, { 1: 'center', 2: 'center' });
    const spreads = assembleSpreads(sections, false, 'both');
    expect(spreads).toEqual([
      { right: sections[0] },
      { center: sections[1] },
      { center: sections[2] },
      { left: sections[3] },
    ]);
    expect(spreads[1]!.center).toBe(sections[1]);
    expect(spreads[2]!.center).toBe(sections[2]);
  });

  it('pairs around a wide page: pairing before, standalone center, pairing resumes', () => {
    const sections = makeSections(5, { 2: 'center' });
    const spreads = assembleSpreads(sections, false, 'both');
    expect(spreads).toEqual([
      { right: sections[0] },
      { left: sections[1] },
      { center: sections[2] },
      { left: sections[3], right: sections[4] },
    ]);
  });

  it("centers every section when spread is 'none'", () => {
    const sections = makeSections(3);
    expect(assembleSpreads(sections, false, 'none')).toEqual(
      sections.map((section) => ({ center: section })),
    );
  });

  it('gives the first page its own spread (cover rule) in ltr', () => {
    const sections = makeSections(3);
    expect(assembleSpreads(sections, false, 'both')).toEqual([
      { right: sections[0] },
      { left: sections[1], right: sections[2] },
    ]);
  });

  it('pairs rtl with the first page alone and rtl side assignment', () => {
    const sections = makeSections(5);
    expect(assembleSpreads(sections, true, 'both')).toEqual([
      { left: sections[0] },
      { left: sections[2], right: sections[1] },
      { left: sections[4], right: sections[3] },
    ]);
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
