import { describe, expect, it } from 'vitest';

import { DocumentLoader } from '@/libs/document';
import { makeCbzFixture } from '../fixtures/cbz';

const openCbz = async (comicInfo?: string) => {
  const file = await makeCbzFixture({ comicInfo, imageCount: 3 });
  const result = await new DocumentLoader(file).open();
  expect(result.format).toBe('CBZ');
  return result.book;
};

describe('ComicInfo.xml Manga element sets book.dir', () => {
  it('sets dir to rtl for Manga=YesAndRightToLeft', async () => {
    const book = await openCbz(
      '<?xml version="1.0"?><ComicInfo><Title>T</Title><Manga>YesAndRightToLeft</Manga></ComicInfo>',
    );
    expect(book.dir).toBe('rtl');
  });

  it('leaves dir unset for Manga=Yes (manga, but not right-to-left)', async () => {
    const book = await openCbz(
      '<?xml version="1.0"?><ComicInfo><Title>T</Title><Manga>Yes</Manga></ComicInfo>',
    );
    expect(book.dir).toBeUndefined();
  });

  it('leaves dir unset when ComicInfo.xml is absent', async () => {
    const book = await openCbz();
    expect(book.dir).toBeUndefined();
  });

  it('leaves dir unset when ComicInfo.xml is malformed', async () => {
    const book = await openCbz('<ComicInfo><Manga>YesAndRightToLeft');
    expect(book.dir).toBeUndefined();
  });
});
