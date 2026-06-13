import { describe, expect, it } from 'vitest';

import { detectArchiveFormat } from '@/utils/comicArchive';

const fileWith = (bytes: number[], name = 'x') => new File([new Uint8Array(bytes)], name);

describe('detectArchiveFormat', () => {
  it('detects RAR4 magic (Rar!\\x1A\\x07\\x00)', async () => {
    expect(await detectArchiveFormat(fileWith([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]))).toBe(
      'CBR',
    );
  });

  it('detects RAR5 magic (Rar!\\x1A\\x07\\x01\\x00)', async () => {
    expect(
      await detectArchiveFormat(fileWith([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00])),
    ).toBe('CBR');
  });

  it('detects 7z magic (7z\\xBC\\xAF\\x27\\x1C)', async () => {
    expect(await detectArchiveFormat(fileWith([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))).toBe('CB7');
  });

  it('returns null for a ZIP (CBZ) file', async () => {
    expect(await detectArchiveFormat(fileWith([0x50, 0x4b, 0x03, 0x04]))).toBeNull();
  });

  it('returns null for a too-short file', async () => {
    expect(await detectArchiveFormat(fileWith([0x52, 0x61]))).toBeNull();
  });
});
