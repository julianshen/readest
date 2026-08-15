import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  envConfig: {} as never,
  syncBooks: vi.fn(),
  runFileLibrarySyncPass: vi.fn(),
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: h.user }),
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: h.envConfig, appService: null }),
}));

vi.mock('@/hooks/useSync', () => ({
  useSync: () => ({
    useSyncInited: false,
    syncedBooks: null,
    syncBooks: h.syncBooks,
    lastSyncedAtBooks: 1,
  }),
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string) => key,
}));

vi.mock('@/services/sync/file/runLibrarySync', () => ({
  runFileLibrarySyncPass: (...args: unknown[]) => h.runFileLibrarySyncPass(...args),
}));

vi.mock('@/utils/throttle', () => ({
  throttle: <T extends (...args: never[]) => unknown>(fn: T) => fn,
}));

import { useBooksSync } from '@/app/library/hooks/useBooksSync';

describe('useBooksSync auto-sync', () => {
  beforeEach(() => {
    h.user = null;
    h.syncBooks.mockReset().mockResolvedValue(0);
    h.runFileLibrarySyncPass.mockReset().mockResolvedValue(null);
    useSettingsStore.setState((state) => ({
      settings: { ...state.settings, readestCloud: { enabled: true } },
    }));
    useLibraryStore.setState({
      library: [
        {
          hash: 'book-1',
          format: 'EPUB',
          title: 'Book',
          sourceTitle: 'Book',
          author: 'Author',
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      libraryLoaded: true,
      isSyncing: false,
    });
  });

  afterEach(() => {
    cleanup();
  });

  test('runs the file pass without native sync when logged out', async () => {
    renderHook(() => useBooksSync());

    await waitFor(() =>
      expect(h.runFileLibrarySyncPass).toHaveBeenCalledWith(h.envConfig, expect.any(Function)),
    );
    expect(h.syncBooks).not.toHaveBeenCalled();
  });

  test('keeps third-party file sync independent when signed in with Readest Cloud disabled', async () => {
    h.user = { id: 'user-1' };
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        readestCloud: { enabled: false },
        webdav: { ...state.settings.webdav, enabled: true },
      },
    }));

    const { result } = renderHook(() => useBooksSync());

    await waitFor(() => expect(h.runFileLibrarySyncPass).toHaveBeenCalledTimes(1));
    await result.current.pullLibrary();
    await result.current.pushLibrary();

    expect(h.syncBooks).not.toHaveBeenCalled();
  });

  test('continues the file pass when native sync fails', async () => {
    h.user = { id: 'user-1' };
    const events: string[] = [];
    h.syncBooks.mockRejectedValueOnce(new Error('native offline'));
    h.runFileLibrarySyncPass.mockImplementation(async () => {
      events.push('file');
      return null;
    });

    renderHook(() => useBooksSync());

    await waitFor(() => expect(h.runFileLibrarySyncPass).toHaveBeenCalledTimes(1));
    expect(events).toEqual(['file']);
  });

  test('awaits native sync before the file pass for logged-in changes', async () => {
    h.user = { id: 'user-1' };
    const events: string[] = [];
    h.syncBooks.mockImplementation(async () => {
      events.push('native-start');
      await Promise.resolve();
      events.push('native-end');
      return 1;
    });
    h.runFileLibrarySyncPass.mockImplementation(async () => {
      events.push('file-start');
      return null;
    });

    renderHook(() => useBooksSync());

    await waitFor(() => expect(h.runFileLibrarySyncPass).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(h.syncBooks).toHaveBeenCalledWith(expect.any(Array), 'both');
    expect(events).toEqual(['native-start', 'native-end', 'file-start']);
  });
});
