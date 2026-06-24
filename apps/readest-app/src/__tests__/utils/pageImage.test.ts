import { describe, expect, it } from 'vitest';

import { selectPageImageEl } from '@/utils/pageImage';

describe('selectPageImageEl', () => {
  it('finds <img> element and returns kind img', () => {
    const doc = new DOMParser().parseFromString(
      '<html><body><img src="blob:x"/></body></html>',
      'text/html',
    );
    const result = selectPageImageEl(doc);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('img');
    expect((result as { kind: 'img'; el: HTMLImageElement }).el.getAttribute('src')).toBe('blob:x');
  });

  it('finds <svg><image href> and returns kind svg with href', () => {
    const doc = new DOMParser().parseFromString(
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="blob:y"/></svg>',
      'image/svg+xml',
    );
    const result = selectPageImageEl(doc);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('svg');
    expect((result as { kind: 'svg'; el: Element; href: string }).href).toBe('blob:y');
  });

  it('falls back to xlink:href on <svg><image>', () => {
    const doc = new DOMParser().parseFromString(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="blob:z"/></svg>',
      'image/svg+xml',
    );
    const result = selectPageImageEl(doc);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('svg');
    expect((result as { kind: 'svg'; el: Element; href: string }).href).toBe('blob:z');
  });

  it('returns null when the document has no image element', () => {
    const doc = new DOMParser().parseFromString(
      '<html><body><p>text</p></body></html>',
      'text/html',
    );
    const result = selectPageImageEl(doc);
    expect(result).toBeNull();
  });
});
