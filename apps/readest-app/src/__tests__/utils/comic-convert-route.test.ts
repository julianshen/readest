import { afterEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock('@/services/environment', () => ({
  isTauriAppPlatform: () => true,
  isWebAppPlatform: () => false,
}));
// Stub the web extractor so this test only exercises the Tauri branch.
vi.mock('@/utils/comicConvertWeb', () => ({ convertArchiveToCbzWeb: vi.fn() }));

import { convertArchiveToCbz } from '@/utils/comicConvert';

afterEach(() => {
  invokeMock.mockReset();
});

describe('convertArchiveToCbz (Tauri path)', () => {
  it('invokes convert_to_cbz with the source path and returns a .cbz File', async () => {
    invokeMock.mockResolvedValueOnce('/tmp/readest-x.cbz');
    const readPath = vi.fn(async (p: string) => new File([new Uint8Array([1, 2])], p));
    const input = new File([new Uint8Array([0x37, 0x7a, 0xbc, 0xaf])], 'book.cb7');
    const out = await convertArchiveToCbz(input, {
      srcPath: '/books/book.cb7',
      readPathAsFile: readPath,
    });
    expect(invokeMock).toHaveBeenCalledWith('convert_to_cbz', { srcPath: '/books/book.cb7' });
    expect(out.name.endsWith('.cbz')).toBe(true);
    expect(out.type).toBe('application/vnd.comicbook+zip');
  });
});
