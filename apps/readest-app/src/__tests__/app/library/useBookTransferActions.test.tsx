import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

import type { Book } from '@/types/book';
import type { EnvConfigType } from '@/services/environment';
import type { AppService } from '@/types/system';
import type { ProgressPayload } from '@/utils/transfer';

/**
 * Issue #5062 — cloud sync providers are independently selectable, so a
 * per-book Upload/Download must route to whichever of {Readest Cloud, a file
 * backend} the user has switched on, instead of assuming exactly one.
 *
 * `isReadestCloudEnabled` and `getActiveFileSyncBackends` are settable per
 * test (same pattern as useBooksSync-routing.test.tsx) so every routing
 * branch can be exercised directly, without rendering the whole library page.
 */

const routing = vi.hoisted(() => ({
  readestEnabled: true,
  backends: [] as ('webdav' | 'gdrive' | 's3' | 'onedrive')[],
}));

const runFileBookUpload = vi.hoisted(() => vi.fn(async () => true));
const runFileBookDownload = vi.hoisted(() => vi.fn(async () => true));
const queueUpload = vi.hoisted(() => vi.fn(() => 'transfer-1'));
const queueDownload = vi.hoisted(() => vi.fn(() => 'transfer-1'));
const downloadBook = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation:
    () =>
    (text: string, params?: Record<string, string | number>): string => {
      if (!params) return text;
      return Object.entries(params).reduce(
        (acc, [k, v]) => acc.replace(`{{${k}}}`, String(v)),
        text,
      );
    },
}));

vi.mock('@/services/sync/cloudSyncProvider', () => ({
  isReadestCloudEnabled: () => routing.readestEnabled,
  getActiveFileSyncBackends: () => routing.backends,
}));

vi.mock('@/services/sync/file/runLibrarySync', () => ({
  runFileBookUpload,
  runFileBookDownload,
}));

vi.mock('@/services/transferManager', () => ({
  transferManager: {
    queueUpload,
    queueDownload,
  },
}));

const { useBookTransferActions } = await import('@/app/library/hooks/useBookTransferActions');
const { eventDispatcher } = await import('@/utils/event');

const envConfig: EnvConfigType = { getAppService: async () => ({}) as AppService };

const makeBook = (over: Partial<Book> = {}): Book => ({
  hash: 'book-1',
  format: 'EPUB',
  title: 'Title',
  author: 'Author',
  createdAt: 1000,
  updatedAt: 1000,
  ...over,
});

const setup = (appService: AppService | null = null) => {
  const updateBook = vi.fn(async (_envConfig: EnvConfigType, _book: Book) => {});
  const updateBookTransferProgress = vi.fn((_bookHash: string, _progress: ProgressPayload) => {});
  const { result } = renderHook(() =>
    useBookTransferActions(envConfig, appService, updateBook, updateBookTransferProgress),
  );
  return { result, updateBook };
};

beforeEach(() => {
  vi.clearAllMocks();
  routing.readestEnabled = true;
  routing.backends = [];
});

describe('useBookTransferActions upload routing (issue #5062)', () => {
  it('reaches every enabled destination and persists file provenance', async () => {
    routing.readestEnabled = true;
    routing.backends = ['gdrive'];

    const { result, updateBook } = setup();
    const book = makeBook();
    const ok = await result.current.handleBookUpload(book);

    expect(runFileBookUpload).toHaveBeenCalledWith(envConfig, book);
    expect(queueUpload).toHaveBeenCalledWith(book, 1);
    expect(book.uploadedAt).toEqual(expect.any(Number));
    expect(updateBook).toHaveBeenCalledWith(envConfig, book);
    expect(ok).toBe(true);
  });

  it('persists provenance for a third-party-only explicit upload', async () => {
    routing.readestEnabled = false;
    routing.backends = ['gdrive'];

    const { result, updateBook } = setup();
    const book = makeBook();
    const ok = await result.current.handleBookUpload(book);

    expect(ok).toBe(true);
    expect(book.uploadedAt).toEqual(expect.any(Number));
    expect(updateBook).toHaveBeenCalledWith(envConfig, book);
  });

  it('toasts "turn on a provider" and returns false when nothing is enabled', async () => {
    routing.readestEnabled = false;
    routing.backends = [];
    const dispatchSpy = vi.spyOn(eventDispatcher, 'dispatch');

    const { result } = setup();
    const book = makeBook();
    const ok = await result.current.handleBookUpload(book);

    expect(runFileBookUpload).not.toHaveBeenCalled();
    expect(queueUpload).not.toHaveBeenCalled();
    expect(ok).toBe(false);
    const toastCalls = dispatchSpy.mock.calls.filter(([event]) => event === 'toast');
    expect(toastCalls).toHaveLength(1);
    expect(toastCalls[0]?.[1]).toMatchObject({
      type: 'info',
      message: 'Turn on a provider in Cloud Sync settings to upload this book',
    });
  });
});

describe('useBookTransferActions download routing (issue #5062)', () => {
  it('uses an enabled file backend before native storage because uploadedAt has shared provenance', async () => {
    routing.readestEnabled = true;
    routing.backends = ['webdav'];

    const { result, updateBook } = setup();
    const book = makeBook({ uploadedAt: 12345 });
    const ok = await result.current.handleBookDownload(book, { queued: true });

    expect(runFileBookDownload).toHaveBeenCalledWith(envConfig, book);
    expect(queueDownload).not.toHaveBeenCalled();
    expect(updateBook).toHaveBeenCalledWith(envConfig, book);
    expect(ok).toBe(true);
  });

  it('queues native download after enabled file backends miss', async () => {
    routing.readestEnabled = true;
    routing.backends = ['webdav'];
    runFileBookDownload.mockResolvedValueOnce(false);
    const { result } = setup();
    const book = makeBook({ uploadedAt: 12345 });

    const ok = await result.current.handleBookDownload(book, { queued: true, silent: true });

    expect(runFileBookDownload).toHaveBeenCalledWith(envConfig, book);
    expect(queueDownload).toHaveBeenCalledWith(book, 1);
    expect(ok).toBe(true);
  });

  it('uses native immediate download after enabled file backends miss', async () => {
    routing.readestEnabled = true;
    routing.backends = ['webdav'];
    runFileBookDownload.mockResolvedValueOnce(false);
    const appService = { downloadBook } as unknown as AppService;
    const { result } = setup(appService);
    const book = makeBook({ uploadedAt: 12345 });

    const ok = await result.current.handleBookDownload(book, { queued: false, silent: true });

    expect(runFileBookDownload).toHaveBeenCalledWith(envConfig, book);
    expect(downloadBook).toHaveBeenCalled();
    expect(ok).toBe(true);
  });

  it('falls back to a file backend when the book is not in Readest Cloud storage', async () => {
    routing.readestEnabled = true;
    routing.backends = ['webdav'];

    const { result, updateBook } = setup();
    const book = makeBook({ uploadedAt: null });
    const ok = await result.current.handleBookDownload(book, { queued: true });

    expect(runFileBookDownload).toHaveBeenCalledWith(envConfig, book);
    expect(queueDownload).not.toHaveBeenCalled();
    expect(updateBook).toHaveBeenCalledWith(envConfig, book);
    expect(ok).toBe(true);
  });
});

/**
 * Finding 3744450943 — with Readest Cloud disabled the bookshelf "cloud
 * download" used to call only `appService.downloadBook` (the native Readest
 * Cloud path), so a book that exists solely on a third-party backend could
 * never be restored from the UI. The download must route to
 * `runFileBookDownload` instead, and the native paths must stay untouched.
 */
describe('useBookTransferActions third-party-only restore (finding 3744450943)', () => {
  it('routes the download to the file backends when Readest Cloud is disabled', async () => {
    routing.readestEnabled = false;
    routing.backends = ['webdav'];
    const appService = { downloadBook } as unknown as AppService;

    const { result, updateBook } = setup(appService);
    const book = makeBook({ uploadedAt: 12345 });
    const ok = await result.current.handleBookDownload(book, { queued: true });

    expect(runFileBookDownload).toHaveBeenCalledWith(envConfig, book);
    expect(downloadBook).not.toHaveBeenCalled();
    expect(queueDownload).not.toHaveBeenCalled();
    expect(updateBook).toHaveBeenCalledWith(envConfig, book);
    expect(ok).toBe(true);
  });

  it('keeps the native immediate path when Readest Cloud is the only provider', async () => {
    routing.readestEnabled = true;
    routing.backends = [];
    const appService = { downloadBook } as unknown as AppService;

    const { result, updateBook } = setup(appService);
    const book = makeBook({ uploadedAt: 12345 });
    const ok = await result.current.handleBookDownload(book, { queued: false });

    expect(runFileBookDownload).not.toHaveBeenCalled();
    expect(downloadBook).toHaveBeenCalledWith(book, false, false, expect.any(Function));
    expect(updateBook).toHaveBeenCalledWith(envConfig, book);
    expect(ok).toBe(true);
  });

  it('does not touch the library row and reports failure when the file backend has no copy', async () => {
    routing.readestEnabled = false;
    routing.backends = ['webdav'];
    runFileBookDownload.mockResolvedValueOnce(false);
    const dispatchSpy = vi.spyOn(eventDispatcher, 'dispatch');

    const { result, updateBook } = setup();
    const book = makeBook({ uploadedAt: 12345 });
    const ok = await result.current.handleBookDownload(book, { queued: true });

    expect(runFileBookDownload).toHaveBeenCalledWith(envConfig, book);
    expect(updateBook).not.toHaveBeenCalled();
    expect(ok).toBe(false);
    const toastCalls = dispatchSpy.mock.calls.filter(([event]) => event === 'toast');
    expect(toastCalls).toHaveLength(1);
    expect(toastCalls[0]?.[1]).toMatchObject({
      type: 'error',
      message: 'Failed to download book: Title',
    });
  });

  it('falls back to a file backend when native immediate download throws', async () => {
    routing.readestEnabled = true;
    routing.backends = ['webdav'];
    runFileBookDownload.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    downloadBook.mockRejectedValueOnce(new Error('network down'));
    const appService = { downloadBook } as unknown as AppService;

    const { result, updateBook } = setup(appService);
    const book = makeBook({ uploadedAt: 12345 });
    const ok = await result.current.handleBookDownload(book, { queued: false, silent: true });

    expect(downloadBook).toHaveBeenCalled();
    expect(runFileBookDownload).toHaveBeenCalledTimes(2);
    expect(updateBook).toHaveBeenCalledWith(envConfig, book);
    expect(ok).toBe(true);
  });

  it('reports no-provider downloads as a failure without queueing native work', async () => {
    routing.readestEnabled = false;
    routing.backends = [];
    const dispatchSpy = vi.spyOn(eventDispatcher, 'dispatch');

    const { result } = setup();
    const ok = await result.current.handleBookDownload(makeBook(), { queued: true });

    expect(queueDownload).not.toHaveBeenCalled();
    expect(ok).toBe(false);
    expect(dispatchSpy).toHaveBeenCalledWith('toast', expect.objectContaining({ type: 'info' }));
  });
});
