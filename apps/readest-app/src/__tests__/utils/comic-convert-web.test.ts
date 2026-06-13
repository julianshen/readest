import { describe, expect, it } from 'vitest';

import { repackToCbz } from '@/utils/comicConvertWeb';

describe('repackToCbz', () => {
  it('packs image entries into a STORE-mode CBZ, sorted, dropping non-images', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const blob = await repackToCbz([
      { name: '02.png', bytes: png },
      { name: '01.png', bytes: png },
      { name: 'ComicInfo.xml', bytes: new TextEncoder().encode('<ComicInfo/>') },
      { name: 'thumbs.db', bytes: new Uint8Array([0]) },
    ]);
    const { ZipReader, BlobReader } = await import('@zip.js/zip.js');
    const reader = new ZipReader(new BlobReader(blob));
    const entries = await reader.getEntries();
    expect(entries.map((e) => e.filename)).toEqual(['01.png', '02.png', 'ComicInfo.xml']);
    await reader.close();
  });

  it('rejects an archive with no image pages', async () => {
    await expect(repackToCbz([{ name: 'readme.txt', bytes: new Uint8Array([1]) }])).rejects.toThrow(
      'no readable pages',
    );
  });
});
