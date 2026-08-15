import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { Book } from '@/types/book';
import type { EnvConfigType } from '@/services/environment';

const runFileBookDelete = vi.hoisted(() => vi.fn());

vi.mock('@/services/sync/file/runLibrarySync', () => ({ runFileBookDelete }));

import {
  applyPublishedFileCloudDeletion,
  executeBookDeletion,
  runCloudBookDelete,
  type CloudBookDeleteResult,
} from '@/services/sync/cloudBookDelete';

const envConfig: EnvConfigType = {
  getAppService: async () => {
    throw new Error('getAppService should not be called by this test');
  },
};
const makeBook = (overrides: Partial<Book> = {}): Book => ({
  hash: 'book-1',
  format: 'EPUB',
  title: 'Title',
  author: 'Author',
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const successfulFileDelete = {
  attempted: ['webdav'] as const,
  published: ['webdav'] as const,
  maxTombstoneAt: 20,
  succeeded: ['webdav'] as const,
  failed: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  runFileBookDelete.mockResolvedValue(successfulFileDelete);
});

describe('runCloudBookDelete', () => {
  test('deletes a third-party-only cloud copy', async () => {
    const queueNativeDelete = vi.fn(() => null);

    const result = await runCloudBookDelete(envConfig, makeBook(), false, queueNativeDelete);

    expect(queueNativeDelete).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.failedProviders).toEqual([]);
  });

  test('queues native deletion and deletes file backends when both are enabled', async () => {
    const queueNativeDelete = vi.fn(() => 'native-delete-1');

    const result = await runCloudBookDelete(envConfig, makeBook(), true, queueNativeDelete);

    expect(queueNativeDelete).toHaveBeenCalledWith(makeBook(), 1, true);
    expect(result.nativeQueued).toBe(true);
    expect(result.ok).toBe(true);
  });

  test('protects the local row when mixed-provider file tombstones publish', async () => {
    const book = makeBook({ uploadedAt: 10 });
    const result = await runCloudBookDelete(
      envConfig,
      book,
      true,
      vi.fn(() => 'native-1'),
    );
    const before = book.updatedAt;

    expect(applyPublishedFileCloudDeletion(book, result, true)).toBe(true);
    expect(book.uploadedAt).toBe(10);
    expect(book.updatedAt).toBeGreaterThan(before);
  });

  test('reports native queue failure as partial when file deletion succeeds', async () => {
    const result = await runCloudBookDelete(
      envConfig,
      makeBook(),
      true,
      vi.fn(() => null),
    );

    expect(result.ok).toBe(false);
    expect(result.partial).toBe(true);
    expect(result.failedProviders).toEqual(['readest']);
  });

  test('reports partial failure while retaining successful provider deletions', async () => {
    runFileBookDelete.mockResolvedValue({
      attempted: ['webdav', 'gdrive'],
      published: ['webdav', 'gdrive'],
      maxTombstoneAt: 20,
      succeeded: ['gdrive'],
      failed: [{ kind: 'webdav', reason: 'offline' }],
    });

    const result = await runCloudBookDelete(
      envConfig,
      makeBook(),
      false,
      vi.fn(() => null),
    );

    expect(result.ok).toBe(false);
    expect(result.file.succeeded).toEqual(['gdrive']);
    expect(result.failedProviders).toEqual(['webdav']);
  });

  test('clears third-party provenance only after all file deletions succeed', async () => {
    const book = makeBook({ uploadedAt: 10 });
    const result = await runCloudBookDelete(
      envConfig,
      book,
      false,
      vi.fn(() => null),
    );

    expect(applyPublishedFileCloudDeletion(book, result, false)).toBe(true);
    expect(book.uploadedAt).toBeNull();
    expect(book.updatedAt).toBe(21);
  });

  test('keeps provenance after a partial cloud deletion while preserving the local row', async () => {
    const book = makeBook({ uploadedAt: 10 });
    runFileBookDelete.mockResolvedValue({
      attempted: ['webdav', 'gdrive'],
      published: ['webdav', 'gdrive'],
      maxTombstoneAt: 20,
      succeeded: ['gdrive'],
      failed: [{ kind: 'webdav', reason: 'offline' }],
    });
    const result = await runCloudBookDelete(
      envConfig,
      book,
      false,
      vi.fn(() => null),
    );

    expect(applyPublishedFileCloudDeletion(book, result, false)).toBe(true);
    expect(book.uploadedAt).toBe(10);
    expect(book.updatedAt).toBe(21);
  });

  test('runs local deletion for both even when cloud deletion is partial', async () => {
    const deleteLocal = vi.fn(async () => {});
    const partialCloud: CloudBookDeleteResult = {
      nativeQueued: false,
      file: {
        attempted: ['webdav'],
        published: ['webdav'],
        maxTombstoneAt: 20,
        succeeded: [],
        failed: [{ kind: 'webdav', reason: 'offline' }],
      },
      failedProviders: ['webdav'],
      partial: true,
      ok: false,
    };

    const result = await executeBookDeletion('both', deleteLocal, async () => partialCloud);

    expect(deleteLocal).toHaveBeenCalledOnce();
    expect(result.ok).toBe(false);
  });

  test('does not report success when no provider is enabled', async () => {
    runFileBookDelete.mockResolvedValue({
      attempted: [],
      published: [],
      succeeded: [],
      failed: [],
    });

    const result = await runCloudBookDelete(
      envConfig,
      makeBook(),
      false,
      vi.fn(() => null),
    );

    expect(result.ok).toBe(false);
    expect(result.failedProviders).toEqual([]);
    expect(applyPublishedFileCloudDeletion(makeBook(), result, false)).toBe(false);
  });
});
