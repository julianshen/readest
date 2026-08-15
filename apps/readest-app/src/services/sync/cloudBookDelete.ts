import type { Book } from '@/types/book';
import type { EnvConfigType } from '@/services/environment';
import type { CloudSyncProviderKind } from '@/services/sync/cloudSyncProvider';
import { runFileBookDelete, type FileBookDeleteResult } from '@/services/sync/file/runLibrarySync';

export interface CloudBookDeleteResult {
  nativeQueued: boolean;
  file: FileBookDeleteResult;
  failedProviders: CloudSyncProviderKind[];
  partial: boolean;
  ok: boolean;
}

type QueueNativeDelete = (book: Book, priority: number, isBackground: boolean) => string | null;

/**
 * Route one cloud-backup deletion to every selected provider. File backends
 * are attempted independently; native queue acceptance is immediate success,
 * while a later native queue failure remains visible in the transfer queue.
 */
export const runCloudBookDelete = async (
  envConfig: EnvConfigType,
  book: Book,
  readestEnabled: boolean,
  queueNativeDelete: QueueNativeDelete,
): Promise<CloudBookDeleteResult> => {
  const nativeQueued = readestEnabled ? !!queueNativeDelete(book, 1, true) : false;
  const file = await runFileBookDelete(envConfig, book);
  const failedProviders: CloudSyncProviderKind[] = [
    ...(readestEnabled && !nativeQueued ? (['readest'] as const) : []),
    ...file.failed.map(({ kind }) => kind),
  ];
  const attemptedProvider = nativeQueued || file.attempted.length > 0;
  const allFileDeletesSucceeded = file.failed.length === 0;
  const ok = attemptedProvider && allFileDeletesSucceeded && (!readestEnabled || nativeQueued);
  const successfulProvider = nativeQueued || file.succeeded.length > 0 || file.published.length > 0;
  const partial = successfulProvider && failedProviders.length > 0;

  return { nativeQueued, file, failedProviders, partial, ok };
};

/**
 * Keep a published file-backend cloud delete local. Bumping updatedAt is
 * intentional: the next sync treats the retained local row as an edit over the
 * remote tombstone and may re-upload it when file sync remains enabled. Only a
 * complete deletion clears uploadedAt; partial cleanup retains provenance.
 */
export type BookDeleteAction = 'cloud' | 'local' | 'both';

export interface BookDeleteExecutionResult {
  ok: boolean;
  cloud?: CloudBookDeleteResult;
}

/** Run local deletion before cloud deletion, preserving `both` semantics. */
export const executeBookDeletion = async (
  action: BookDeleteAction,
  deleteLocal: () => Promise<void>,
  deleteCloud: () => Promise<CloudBookDeleteResult>,
): Promise<BookDeleteExecutionResult> => {
  if (action === 'local' || action === 'both') await deleteLocal();
  if (action === 'cloud' || action === 'both') {
    const cloud = await deleteCloud();
    return { ok: cloud.ok, cloud };
  }
  return { ok: true };
};

export const applyPublishedFileCloudDeletion = (
  book: Book,
  deletion: CloudBookDeleteResult,
  readestEnabled: boolean,
): boolean => {
  const tombstoneAt = deletion.file.maxTombstoneAt;
  if (deletion.file.published.length === 0 || tombstoneAt === undefined) return false;
  if (!readestEnabled && deletion.ok) book.uploadedAt = null;
  book.updatedAt = Math.max(book.updatedAt ?? 0, tombstoneAt + 1);
  return true;
};
