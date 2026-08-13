import { useCallback } from 'react';
import type { Book } from '@/types/book';
import type { EnvConfigType } from '@/services/environment';
import type { AppService } from '@/types/system';
import type { ProgressPayload } from '@/utils/transfer';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { eventDispatcher } from '@/utils/event';
import { transferManager } from '@/services/transferManager';
import {
  getActiveFileSyncBackends,
  isReadestCloudEnabled,
} from '@/services/sync/cloudSyncProvider';
import { runFileBookDownload, runFileBookUpload } from '@/services/sync/file/runLibrarySync';

interface BookDownloadOptions {
  redownload?: boolean;
  queued?: boolean;
  // Bulk callers (the select-mode Download action) report one summary toast
  // for the whole batch instead of one per book — a group can hold hundreds.
  silent?: boolean;
}

/**
 * Explicit per-book Upload/Download routing (#5062) — cloud sync providers are
 * independently selectable, so a book's destinations depend on which of
 * {Readest Cloud, a file backend} are switched on. Extracted out of the
 * library page component so this routing can be exercised directly with
 * `renderHook`, the same pattern already used for {@link useBooksSync}.
 */
export const useBookTransferActions = (
  envConfig: EnvConfigType,
  appService: AppService | null,
  updateBook: (envConfig: EnvConfigType, book: Book) => Promise<void>,
  updateBookTransferProgress: (bookHash: string, progress: ProgressPayload) => void,
) => {
  const _ = useTranslation();

  const handleBookUpload = useCallback(
    async (book: Book, _syncBooks = true) => {
      const settingsNow = useSettingsStore.getState().settings;
      const backends = getActiveFileSyncBackends(settingsNow);
      const readest = isReadestCloudEnabled(settingsNow);

      // An explicit Upload must reach EVERY destination the user selected,
      // not just the first one.
      const pushed = backends.length > 0 ? await runFileBookUpload(envConfig, book) : false;
      // Readest Cloud uploads go through the transfer queue (resumable, with its
      // own progress panel), so it reports "queued", not "uploaded".
      const queued = readest ? !!transferManager.queueUpload(book, 1) : false;

      if (queued) {
        eventDispatcher.dispatch('toast', {
          type: 'info',
          timeout: 2000,
          message: _('Upload queued: {{title}}', { title: book.title }),
        });
        return true;
      }
      if (pushed) {
        eventDispatcher.dispatch('toast', {
          type: 'info',
          timeout: 2000,
          message: _('Book uploaded: {{title}}', { title: book.title }),
        });
        return true;
      }
      // An explicit Upload action must never silently no-op.
      eventDispatcher.dispatch('toast', {
        type: backends.length > 0 || readest ? 'error' : 'info',
        timeout: 5000,
        message:
          backends.length > 0 || readest
            ? _('Failed to upload book: {{title}}', { title: book.title })
            : _('Turn on a provider in Cloud Sync settings to upload this book'),
      });
      return false;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const handleBookDownload = useCallback(
    async (book: Book, downloadOptions: BookDownloadOptions = {}) => {
      const { redownload = false, queued = false, silent = false } = downloadOptions;
      const settingsNow = useSettingsStore.getState().settings;
      const backends = getActiveFileSyncBackends(settingsNow);
      const readest = isReadestCloudEnabled(settingsNow);
      if (!readest && backends.length === 0) {
        if (!silent) {
          eventDispatcher.dispatch('toast', {
            type: 'info',
            timeout: 5000,
            message: _('Turn on a provider in Cloud Sync settings to download this book'),
          });
        }
        return false;
      }

      const downloadFromFileBackend = async (notify = !silent): Promise<boolean> => {
        try {
          const ok = await runFileBookDownload(envConfig, book);
          if (ok) await updateBook(envConfig, book);
          if (notify && !silent) {
            eventDispatcher.dispatch('toast', {
              type: ok ? 'info' : 'error',
              timeout: 2000,
              message: ok
                ? _('Book downloaded: {{title}}', { title: book.title })
                : _('Failed to download book: {{title}}', { title: book.title }),
            });
          }
          return ok;
        } catch {
          if (notify && !silent) {
            eventDispatcher.dispatch('toast', {
              type: 'error',
              timeout: 2000,
              message: _('Failed to download book: {{title}}', { title: book.title }),
            });
          }
          return false;
        }
      };

      // `uploadedAt` is shared by native and file sync, so it cannot identify
      // which provider owns the remote copy. Probe enabled file mirrors first;
      // only fall back to native Readest Cloud when no mirror has the book.
      if (backends.length > 0) {
        const fileOk = await downloadFromFileBackend(false);
        if (fileOk) {
          if (!silent) {
            eventDispatcher.dispatch('toast', {
              type: 'info',
              timeout: 2000,
              message: _('Book downloaded: {{title}}', { title: book.title }),
            });
          }
          return true;
        }
        if (!readest) {
          if (!silent) {
            eventDispatcher.dispatch('toast', {
              type: 'error',
              timeout: 2000,
              message: _('Failed to download book: {{title}}', { title: book.title }),
            });
          }
          return false;
        }
      }

      if (redownload || !queued) {
        try {
          await appService?.downloadBook(book, false, redownload, (progress) => {
            updateBookTransferProgress(book.hash, progress);
          });
          await updateBook(envConfig, book);
          if (!silent) {
            eventDispatcher.dispatch('toast', {
              type: 'info',
              timeout: 2000,
              message: _('Book downloaded: {{title}}', {
                title: book.title,
              }),
            });
          }
          return true;
        } catch {
          if (backends.length > 0) return downloadFromFileBackend();
          if (!silent) {
            eventDispatcher.dispatch('toast', {
              message: _('Failed to download book: {{title}}', {
                title: book.title,
              }),
              type: 'error',
            });
          }
          return false;
        }
      }

      // Use transfer queue for normal downloads - priority 1 for manual downloads
      const transferId = transferManager.queueDownload(book, 1);
      if (!transferId && backends.length > 0) return downloadFromFileBackend();
      if (transferId) {
        if (!silent) {
          eventDispatcher.dispatch('toast', {
            type: 'info',
            timeout: 2000,
            message: _('Download queued: {{title}}', {
              title: book.title,
            }),
          });
        }
        return true;
      }
      return false;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [appService],
  );

  return { handleBookUpload, handleBookDownload };
};
