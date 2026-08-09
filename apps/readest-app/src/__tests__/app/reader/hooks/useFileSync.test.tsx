import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { BookConfig, BookNote } from '@/types/book';
import type { PullResult } from '@/services/sync/file/engine';

const h = vi.hoisted(() => {
  const makeStore = <T,>(state: T) => {
    const store = <R,>(selector?: (value: T) => R) => (selector ? selector(state) : state) as R | T;
    (store as unknown as { getState: () => T }).getState = () => state;
    return store as {
      (): T;
      <R>(selector: (value: T) => R): R;
      getState: () => T;
    };
  };

  const listeners = new Map<string, Set<(event: CustomEvent) => void>>();
  const state: { config: BookConfig } = {
    config: { location: 'epubcfi(/6/2)', booknotes: [], updatedAt: 1 },
  };
  const book = { hash: 'book-1', title: 'Book', format: 'EPUB', updatedAt: 1 };
  const view = { addAnnotation: vi.fn() };
  const removeBookNoteOverlays = vi.fn();
  const engine = () => ({
    pullBookConfig: vi.fn<() => Promise<PullResult>>().mockResolvedValue({
      applied: true,
      mergedConfig: state.config,
    }),
    pushBookConfig: vi.fn(async () => {}),
    pushBookFile: vi.fn(async () => ({ uploaded: false, reason: 'remote-matches' })),
    pushBookCover: vi.fn(async () => ({ uploaded: false, reason: 'remote-matches' })),
  });

  return {
    makeStore,
    listeners,
    envConfig: {},
    appService: {},
    state,
    book,
    view,
    removeBookNoteOverlays,
    progress: null as { location: string } | null,
    webdav: engine(),
    gdrive: engine(),
    buildEngine: vi.fn(),
    setConfig: vi.fn((_bookKey: string, config: typeof state.config) => {
      state.config = config;
    }),
    saveConfig: vi.fn(async () => {}),
    saveSettings: vi.fn(async () => {}),
  };
});

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: h.envConfig, appService: h.appService }),
}));

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (key: string) => key }));
vi.mock('@/hooks/useQuotaStats', () => ({ useQuotaStats: () => ({ userProfilePlan: 'free' }) }));
vi.mock('@/store/readerProgressStore', () => ({ useBookProgress: () => h.progress }));
vi.mock('@/store/bookDataStore', () => ({
  useBookDataStore: h.makeStore({
    getConfig: () => h.state.config,
    setConfig: h.setConfig,
    getBookData: () => ({ book: h.book }),
    saveConfig: h.saveConfig,
  }),
}));
vi.mock('@/store/readerStore', () => ({
  useReaderStore: h.makeStore({
    getView: () => h.view,
    getViewsById: () => [h.view],
    getViewState: () => ({ previewMode: false }),
  }),
}));
vi.mock('@/store/settingsStore', () => {
  const settings = {
    webdav: { enabled: true, serverUrl: 'https://dav.test', username: 'reader', syncBooks: true },
    googleDrive: { enabled: true, syncBooks: true },
  };
  const state = {
    settings,
    setSettings: vi.fn(),
    saveSettings: h.saveSettings,
  };
  return { useSettingsStore: h.makeStore(state) };
});
vi.mock('@/services/sync/file/runLibrarySync', () => ({
  getReadyFileSyncBackends: () => ['webdav', 'gdrive'],
  buildFileSyncEngine: h.buildEngine,
}));
vi.mock('@/utils/event', () => ({
  eventDispatcher: {
    on: (name: string, callback: (event: CustomEvent) => void) => {
      const callbacks = h.listeners.get(name) ?? new Set();
      callbacks.add(callback);
      h.listeners.set(name, callbacks);
    },
    off: (name: string, callback: (event: CustomEvent) => void) => {
      h.listeners.get(name)?.delete(callback);
    },
    dispatch: async (name: string, detail?: unknown) => {
      const event = new CustomEvent(name, { detail });
      for (const callback of h.listeners.get(name) ?? []) callback(event);
    },
  },
}));
vi.mock('@/app/reader/hooks/useWindowActiveChanged', () => ({ useWindowActiveChanged: () => {} }));
vi.mock('@/app/reader/utils/annotatorUtil', () => ({
  removeBookNoteOverlays: h.removeBookNoteOverlays,
}));

import { useFileSync } from '@/app/reader/hooks/useFileSync';
import { eventDispatcher } from '@/utils/event';

const flushMicrotasks = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  h.listeners.clear();
  h.progress = null;
  h.state.config = { location: 'epubcfi(/6/2)', booknotes: [], updatedAt: 1 };
  h.setConfig.mockClear();
  h.saveConfig.mockClear();
  h.removeBookNoteOverlays.mockClear();
  h.view.addAnnotation.mockClear();
  h.webdav.pullBookConfig.mockReset();
  h.webdav.pullBookConfig.mockResolvedValue({ applied: true, mergedConfig: h.state.config });
  h.webdav.pushBookConfig.mockClear();
  h.webdav.pushBookFile.mockClear();
  h.webdav.pushBookCover.mockClear();
  h.gdrive.pullBookConfig.mockReset();
  h.gdrive.pullBookConfig.mockResolvedValue({ applied: true, mergedConfig: h.state.config });
  h.gdrive.pushBookConfig.mockClear();
  h.gdrive.pushBookFile.mockClear();
  h.gdrive.pushBookCover.mockClear();
  h.buildEngine.mockClear();
  h.buildEngine.mockImplementation(async (_envConfig: unknown, kind: string) =>
    kind === 'webdav' ? h.webdav : h.gdrive,
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const mountReadyHook = async () => {
  const hook = renderHook(() => useFileSync('book-1-view-1'));
  await act(async () => {
    await flushMicrotasks();
  });
  expect(h.buildEngine).toHaveBeenCalledTimes(2);
  return hook;
};

describe('useFileSync', () => {
  test('routes generic pushes to every ready provider but legacy WebDAV events only to WebDAV', async () => {
    const { result } = await mountReadyHook();

    await act(async () => {
      await result.current.pushNow();
    });
    expect(h.webdav.pushBookConfig).toHaveBeenCalledTimes(1);
    expect(h.gdrive.pushBookConfig).toHaveBeenCalledTimes(1);

    await act(async () => {
      await eventDispatcher.dispatch('push-webdav-sync', { bookKey: 'another-book' });
      await flushMicrotasks();
    });
    expect(h.webdav.pushBookConfig).toHaveBeenCalledTimes(1);
    expect(h.gdrive.pushBookConfig).toHaveBeenCalledTimes(1);

    await act(async () => {
      await eventDispatcher.dispatch('push-webdav-sync', { bookKey: 'book-1-view-1' });
      await flushMicrotasks();
    });
    expect(h.webdav.pushBookConfig).toHaveBeenCalledTimes(2);
    expect(h.gdrive.pushBookConfig).toHaveBeenCalledTimes(1);

    await act(async () => {
      await eventDispatcher.dispatch('pull-webdav-sync', { bookKey: 'another-book' });
      await flushMicrotasks();
    });
    expect(h.webdav.pullBookConfig).not.toHaveBeenCalled();
    expect(h.gdrive.pullBookConfig).not.toHaveBeenCalled();

    await act(async () => {
      await eventDispatcher.dispatch('pull-webdav-sync', { bookKey: 'book-1-view-1' });
      await flushMicrotasks();
    });
    expect(h.webdav.pullBookConfig).toHaveBeenCalledTimes(1);
    expect(h.gdrive.pullBookConfig).not.toHaveBeenCalled();
  });

  test('flush-webdav-sync pushes WebDAV now without cancelling another provider debounce', async () => {
    const { rerender } = await mountReadyHook();
    h.progress = { location: 'epubcfi(/6/4)' };
    await act(async () => {
      rerender();
      await flushMicrotasks();
    });

    expect(h.webdav.pushBookConfig).not.toHaveBeenCalled();
    expect(h.gdrive.pushBookConfig).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(14_999);
      await flushMicrotasks();
    });
    expect(h.webdav.pushBookConfig).not.toHaveBeenCalled();
    expect(h.gdrive.pushBookConfig).not.toHaveBeenCalled();

    await act(async () => {
      await eventDispatcher.dispatch('flush-webdav-sync', { bookKey: 'another-book' });
      await flushMicrotasks();
    });
    expect(h.webdav.pushBookConfig).not.toHaveBeenCalled();
    expect(h.gdrive.pushBookConfig).not.toHaveBeenCalled();

    await act(async () => {
      await eventDispatcher.dispatch('flush-webdav-sync', { bookKey: 'book-1-view-1' });
      await flushMicrotasks();
    });
    expect(h.webdav.pushBookConfig).toHaveBeenCalledTimes(1);
    expect(h.gdrive.pushBookConfig).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await flushMicrotasks();
    });
    expect(h.webdav.pushBookConfig).toHaveBeenCalledTimes(1);
    expect(h.gdrive.pushBookConfig).toHaveBeenCalledTimes(1);
  });

  test('bootstraps only an empty provider while checking files and covers independently', async () => {
    h.progress = { location: 'epubcfi(/6/4)' };
    h.gdrive.pullBookConfig.mockResolvedValue({ applied: false });
    await mountReadyHook();

    await act(async () => {
      await flushMicrotasks();
    });
    expect(h.webdav.pushBookConfig).not.toHaveBeenCalled();
    expect(h.gdrive.pushBookConfig).toHaveBeenCalledTimes(1);
    expect(h.webdav.pushBookFile).toHaveBeenCalledTimes(1);
    expect(h.gdrive.pushBookFile).toHaveBeenCalledTimes(1);
    expect(h.webdav.pushBookCover).toHaveBeenCalledTimes(1);
    expect(h.gdrive.pushBookCover).toHaveBeenCalledTimes(1);
  });

  test('applies pulled config and live annotation changes before persisting', async () => {
    const deletedNote: BookNote = {
      id: 'deleted',
      type: 'annotation',
      cfi: 'epubcfi(/6/2)',
      note: '',
      createdAt: 1,
      updatedAt: 10,
      deletedAt: 10,
    };
    const addedNote: BookNote = {
      id: 'added',
      type: 'annotation',
      cfi: 'epubcfi(/6/4)',
      note: '',
      createdAt: 11,
      updatedAt: 11,
    };
    h.state.config = {
      location: 'local',
      booknotes: [{ ...deletedNote, updatedAt: 1, deletedAt: undefined }],
      updatedAt: 1,
    };
    const mergedConfig: BookConfig = {
      ...h.state.config,
      location: 'remote',
      booknotes: [deletedNote, addedNote],
    };
    h.webdav.pullBookConfig.mockResolvedValue({
      applied: true,
      mergedConfig,
      mergedNotes: [deletedNote, addedNote],
    });
    h.gdrive.pullBookConfig.mockResolvedValue({ applied: false });
    const { result } = await mountReadyHook();

    await act(async () => {
      await result.current.pullNow();
    });
    expect(h.setConfig).toHaveBeenCalledWith('book-1-view-1', mergedConfig);
    expect(h.saveConfig).toHaveBeenCalledWith(
      expect.anything(),
      'book-1-view-1',
      mergedConfig,
      expect.anything(),
    );
    expect(h.removeBookNoteOverlays).toHaveBeenCalledWith(h.view, deletedNote);
    expect(h.view.addAnnotation).toHaveBeenCalledWith(addedNote);
  });
});
