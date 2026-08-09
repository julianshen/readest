import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SystemSettings } from '@/types/settings';
import WebDAVForm from '@/components/settings/integrations/WebDAVForm';
import { useSettingsStore } from '@/store/settingsStore';
import { useLibraryStore } from '@/store/libraryStore';
import { useWebDAVSyncStore } from '@/store/webdavSyncStore';

const runFileLibrarySyncPassMock = vi.hoisted(() => vi.fn());
const legacySyncLibraryMock = vi.hoisted(() => vi.fn());
const saveSettingsMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const envConfig = vi.hoisted(() => ({
  getAppService: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string) => key,
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig }),
}));

vi.mock('@/services/environment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/environment')>()),
  isTauriAppPlatform: () => false,
}));

vi.mock('@/services/sync/file/runLibrarySync', () => ({
  runFileLibrarySyncPass: runFileLibrarySyncPassMock,
}));

vi.mock('@/services/webdav/WebDAVSync', () => ({
  syncLibrary: legacySyncLibraryMock,
}));

vi.mock('@/utils/event', () => ({
  eventDispatcher: { dispatch: vi.fn() },
}));

vi.mock('@/components/settings/integrations/WebDAVBrowsePane', () => ({
  default: () => null,
}));

vi.mock('@/components/settings/integrations/SyncHistoryPanel', () => ({
  default: ({ entries }: { entries: Array<{ status: string }> }) => (
    <div data-testid='sync-history'>{entries.map((entry) => entry.status).join(',')}</div>
  ),
}));

const successfulResult = {
  totalBooks: 0,
  booksSynced: 0,
  booksDownloaded: 0,
  configsUploaded: 1,
  configsDownloaded: 0,
  filesUploaded: 0,
  filesAlreadyInSync: 0,
  coversUploaded: 0,
  failures: 0,
  failedBooks: [],
};

const setConfiguredSettings = (enabled = true) => {
  const settings = {
    webdav: {
      enabled,
      serverUrl: enabled ? 'https://dav.example.test' : '',
      username: 'alice',
      password: 'secret',
      rootPath: '/',
      strategy: 'silent',
      syncBooks: false,
      deviceId: 'device-1',
      syncLog: [],
    },
  } as unknown as SystemSettings;
  useSettingsStore.setState({
    settings,
    setSettings: (next: SystemSettings) => useSettingsStore.setState({ settings: next }),
    saveSettings: saveSettingsMock,
  } as unknown as ReturnType<typeof useSettingsStore.getState>);
};

beforeEach(() => {
  runFileLibrarySyncPassMock.mockReset();
  legacySyncLibraryMock.mockReset();
  saveSettingsMock.mockClear();
  setConfiguredSettings();
  useLibraryStore.setState({ library: [], libraryLoaded: true });
  useWebDAVSyncStore.setState({ isSyncing: false, progressLabel: null, startedAt: null });
});

afterEach(cleanup);

describe('WebDAVForm manual sync', () => {
  test('uses the provider runner and records a successful manual history entry', async () => {
    runFileLibrarySyncPassMock.mockResolvedValue(successfulResult);
    legacySyncLibraryMock.mockResolvedValue(successfulResult);

    render(<WebDAVForm onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));

    await waitFor(() =>
      expect(runFileLibrarySyncPassMock).toHaveBeenCalledWith(
        envConfig,
        expect.any(Function),
        expect.objectContaining({ backends: ['webdav'], concurrency: 1 }),
      ),
    );

    expect(useSettingsStore.getState().settings.webdav?.syncLog?.[0]).toMatchObject({
      status: 'success',
      trigger: 'manual',
      configsUploaded: 1,
    });
  });

  test('records a failed manual run in WebDAV history', async () => {
    runFileLibrarySyncPassMock.mockRejectedValue(new Error('network down'));
    legacySyncLibraryMock.mockRejectedValue(new Error('network down'));

    render(<WebDAVForm onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));

    await waitFor(() =>
      expect(runFileLibrarySyncPassMock).toHaveBeenCalledWith(
        envConfig,
        expect.any(Function),
        expect.objectContaining({ backends: ['webdav'], concurrency: 1 }),
      ),
    );

    expect(useSettingsStore.getState().settings.webdav?.syncLog?.[0]).toMatchObject({
      status: 'failure',
      trigger: 'manual',
      errorMessage: 'network down',
    });
  });

  test('does not expose Sync now for disconnected settings', () => {
    setConfiguredSettings(false);

    render(<WebDAVForm onBack={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
    expect(runFileLibrarySyncPassMock).not.toHaveBeenCalled();
  });
});
