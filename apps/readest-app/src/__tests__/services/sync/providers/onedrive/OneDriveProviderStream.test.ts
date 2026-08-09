import { beforeEach, describe, expect, test, vi } from 'vitest';

// Streaming is Tauri-only (it shells the bytes through the native transfer
// plugin off the disk); force the platform probe on so the provider attaches
// the streaming methods, and stub the native transfer + fs plugins.
vi.mock('@/services/environment', () => ({ isTauriAppPlatform: () => true }));
vi.mock('@/utils/transfer', () => ({
  tauriUpload: vi.fn(),
  tauriDownload: vi.fn(async () => ({})),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  stat: vi.fn(async () => ({ size: 42 })),
}));

import {
  createOneDriveProvider,
  type OneDriveAuth,
  type FetchFn,
} from '@/services/sync/providers/onedrive/OneDriveProvider';
import { tauriUpload, tauriDownload } from '@/utils/transfer';
import { stat } from '@tauri-apps/plugin-fs';

const auth: OneDriveAuth = { getAccessToken: async () => 'TOKEN' };
const noSleep = () => Promise.resolve();

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface Harness {
  provider: ReturnType<typeof createOneDriveProvider>;
  fetchMock: ReturnType<typeof vi.fn>;
  url: (n: number) => string;
  method: (n: number) => string | undefined;
  body: (n: number) => unknown;
}

const makeOneDrive = (): Harness => {
  const fetchMock = vi.fn();
  const provider = createOneDriveProvider(auth, fetchMock as unknown as FetchFn, {
    sleep: noSleep,
  });
  return {
    provider,
    fetchMock,
    url: (n) => fetchMock.mock.calls[n]?.[0] as string,
    method: (n) => (fetchMock.mock.calls[n]?.[1] as RequestInit | undefined)?.method,
    body: (n) => {
      const raw = (fetchMock.mock.calls[n]?.[1] as RequestInit | undefined)?.body;
      return typeof raw === 'string' ? JSON.parse(raw) : undefined;
    },
  };
};

const BOOK = '/Readest/books/h/book.epub';

describe('OneDriveProvider — streaming', () => {
  beforeEach(() => {
    vi.mocked(tauriUpload).mockReset();
    vi.mocked(tauriUpload).mockImplementation(
      async (_url, _filePath, _method, _progressHandler, headers) => {
        const range = headers?.['Content-Range'];
        const match = range && /^bytes \d+-(\d+)\/(\d+)$/.exec(range);
        return {
          status: match && Number(match[1]) + 1 === Number(match[2]) ? 201 : 202,
          body: '',
        };
      },
    );
    vi.mocked(tauriDownload).mockClear();
    vi.mocked(stat).mockClear();
  });

  test('exposes uploadStream/downloadStream on Tauri', () => {
    const h = makeOneDrive();
    expect(typeof h.provider.uploadStream).toBe('function');
    expect(typeof h.provider.downloadStream).toBe('function');
  });

  test('uploadStream POSTs createUploadSession and streams the bytes to the returned uploadUrl', async () => {
    const h = makeOneDrive();
    h.fetchMock.mockResolvedValueOnce(json({ uploadUrl: 'https://upload.example/session/abc' }));

    const ok = await h.provider.uploadStream!(BOOK, '/disk/book.epub');
    expect(ok).toBe(true);

    expect(h.method(0)).toBe('POST');
    expect(h.url(0)).toContain('createUploadSession');
    expect(h.body(0)).toEqual({ item: { '@microsoft.graph.conflictBehavior': 'replace' } });

    expect(tauriUpload).toHaveBeenCalledTimes(1);
    const call = vi.mocked(tauriUpload).mock.calls[0]!;
    expect(call[0]).toBe('https://upload.example/session/abc');
    expect(call[1]).toBe('/disk/book.epub');
    expect(call[2]).toBe('PUT');
    const headers = call[4] as unknown as Record<string, string>;
    expect(headers['Content-Range']).toBe('bytes 0-41/42');
    expect(call[5]).toBe(0);
    expect(call[6]).toBe(42);
  });

  test('uploadStream splits files larger than 60 MiB into sequential 10 MiB Graph fragments', async () => {
    const h = makeOneDrive();
    const chunkSize = 10 * 1024 * 1024;
    const size = 65 * 1024 * 1024 + 123;
    vi.mocked(stat).mockResolvedValueOnce({ size } as Awaited<ReturnType<typeof stat>>);
    h.fetchMock.mockResolvedValueOnce(json({ uploadUrl: 'https://upload.example/session/abc' }));

    const ok = await h.provider.uploadStream!(BOOK, '/disk/large-book.epub');

    expect(ok).toBe(true);
    expect(tauriUpload).toHaveBeenCalledTimes(7);
    for (const [index, call] of vi.mocked(tauriUpload).mock.calls.entries()) {
      const offset = index * chunkSize;
      const length = Math.min(chunkSize, size - offset);
      const headers = call[4] as unknown as Record<string, string>;
      expect(call[0]).toBe('https://upload.example/session/abc');
      expect(call[1]).toBe('/disk/large-book.epub');
      expect(call[2]).toBe('PUT');
      expect(call[5]).toBe(offset);
      expect(call[6]).toBe(length);
      expect(headers['Content-Range']).toBe(`bytes ${offset}-${offset + length - 1}/${size}`);
      if (index < 6) {
        expect(length).toBeLessThan(60 * 1024 * 1024);
        expect(length % (320 * 1024)).toBe(0);
      }
    }
  });

  test('uploadStream retries a rejected fragment before continuing to the next range', async () => {
    const h = makeOneDrive();
    const size = 10 * 1024 * 1024 + 1;
    vi.mocked(stat).mockResolvedValueOnce({ size } as Awaited<ReturnType<typeof stat>>);
    h.fetchMock.mockResolvedValueOnce(json({ uploadUrl: 'https://upload.example/session/abc' }));
    vi.mocked(tauriUpload).mockRejectedValueOnce(new Error('connection reset'));

    const ok = await h.provider.uploadStream!(BOOK, '/disk/retry.epub');

    expect(ok).toBe(true);
    expect(tauriUpload).toHaveBeenCalledTimes(3);
    expect(vi.mocked(tauriUpload).mock.calls.map((call) => [call[5], call[6]])).toEqual([
      [0, 10 * 1024 * 1024],
      [0, 10 * 1024 * 1024],
      [10 * 1024 * 1024, 1],
    ]);
  });

  test('uploadStream returns false after the final fragment exhausts its retries', async () => {
    const h = makeOneDrive();
    vi.mocked(stat).mockResolvedValueOnce({ size: 1 } as Awaited<ReturnType<typeof stat>>);
    h.fetchMock.mockResolvedValueOnce(json({ uploadUrl: 'https://upload.example/session/abc' }));
    vi.mocked(tauriUpload).mockRejectedValue(new Error('connection reset'));

    await expect(h.provider.uploadStream!(BOOK, '/disk/final.epub')).resolves.toBe(false);
    expect(tauriUpload).toHaveBeenCalledTimes(5);
  });

  test('uploadStream rejects a 202 response for its final fragment', async () => {
    const h = makeOneDrive();
    vi.mocked(stat).mockResolvedValueOnce({ size: 1 } as Awaited<ReturnType<typeof stat>>);
    h.fetchMock.mockResolvedValueOnce(json({ uploadUrl: 'https://upload.example/session/abc' }));
    vi.mocked(tauriUpload).mockResolvedValue({ status: 202, body: '' } as never);

    await expect(h.provider.uploadStream!(BOOK, '/disk/final-status.epub')).resolves.toBe(false);
    expect(tauriUpload).toHaveBeenCalledTimes(1);
  });

  test('uploadStream writes a zero-byte file directly instead of constructing an invalid range', async () => {
    const h = makeOneDrive();
    vi.mocked(stat).mockResolvedValueOnce({ size: 0 } as Awaited<ReturnType<typeof stat>>);
    h.fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));

    await expect(h.provider.uploadStream!(BOOK, '/disk/empty.epub')).resolves.toBe(true);
    expect(tauriUpload).not.toHaveBeenCalled();
    expect(h.method(0)).toBe('PUT');
    expect(h.url(0)).toContain('/approot:/Readest/books/h/book.epub:/content');
    expect((h.fetchMock.mock.calls[0]?.[1] as RequestInit).body).toBeInstanceOf(ArrayBuffer);
  });

  test('uploadStream returns false (no throw) when the session response has no uploadUrl', async () => {
    const h = makeOneDrive();
    h.fetchMock.mockResolvedValueOnce(json({}));

    const ok = await h.provider.uploadStream!(BOOK, '/disk/book.epub');
    expect(ok).toBe(false);
    expect(tauriUpload).not.toHaveBeenCalled();
  });

  test('uploadStream returns false when the transport throws', async () => {
    const h = makeOneDrive();
    h.fetchMock.mockRejectedValueOnce(new Error('network down'));

    const ok = await h.provider.uploadStream!(BOOK, '/disk/book.epub');
    expect(ok).toBe(false);
  });

  test('downloadStream GETs the content URL and streams to disk with a bearer token', async () => {
    const h = makeOneDrive();

    const ok = await h.provider.downloadStream!(BOOK, '/disk/dst.epub');
    expect(ok).toBe(true);
    expect(tauriDownload).toHaveBeenCalledTimes(1);
    const call = vi.mocked(tauriDownload).mock.calls[0]!;
    expect(call[0]).toContain('/approot:/Readest/books/h/book.epub:/content');
    expect(call[1]).toBe('/disk/dst.epub');
    expect(call[3]).toEqual({ Authorization: 'Bearer TOKEN' });
  });

  test('downloadStream returns false when the transport throws', async () => {
    const h = makeOneDrive();
    vi.mocked(tauriDownload).mockRejectedValueOnce(new Error('network down'));

    const ok = await h.provider.downloadStream!(BOOK, '/disk/dst.epub');
    expect(ok).toBe(false);
  });
});
