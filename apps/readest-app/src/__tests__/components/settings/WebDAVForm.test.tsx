import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SystemSettings } from '@/types/settings';
import WebDAVForm from '@/components/settings/integrations/WebDAVForm';
import { useSettingsStore } from '@/store/settingsStore';
import { useLibraryStore } from '@/store/libraryStore';

const runFileLibrarySyncPassMock = vi.hoisted(() => vi.fn());
const checkConnectionMock = vi.hoisted(() => vi.fn());
const saveSettingsMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const appService = vi.hoisted(() => ({
  saveSettings: vi.fn().mockResolvedValue(undefined),
}));
const envConfig = vi.hoisted(() => ({
  getAppService: vi.fn().mockResolvedValue(appService),
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

vi.mock('@/services/webdav/WebDAVClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/webdav/WebDAVClient')>()),
  checkConnection: checkConnectionMock,
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
    version: 1,
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
  checkConnectionMock.mockReset();
  checkConnectionMock.mockResolvedValue({ success: true });
  saveSettingsMock.mockClear();
  appService.saveSettings.mockClear();
  setConfiguredSettings();
  useLibraryStore.setState({ library: [], libraryLoaded: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('WebDAVForm connection', () => {
  test('activates book sync and persists once after a successful connection', async () => {
    const now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    setConfiguredSettings(false);

    render(<WebDAVForm onBack={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Server URL'), {
      target: { value: 'https://dav.example.test' },
    });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.change(screen.getByLabelText('Root Directory'), { target: { value: '/books/' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() =>
      expect(useSettingsStore.getState().settings.webdav).toMatchObject({
        enabled: true,
        syncBooks: true,
        providerSelectedAt: now,
      }),
    );

    expect(checkConnectionMock).toHaveBeenCalledWith(
      {
        serverUrl: 'https://dav.example.test',
        username: 'alice',
        password: 'secret',
      },
      '/books',
    );
    expect(appService.saveSettings).toHaveBeenCalledTimes(1);
    expect(appService.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        webdav: expect.objectContaining({
          enabled: true,
          syncBooks: true,
          providerSelectedAt: now,
        }),
      }),
    );
    expect(saveSettingsMock).not.toHaveBeenCalled();
  });
});

describe('WebDAVForm manual sync', () => {
  test('uses the provider runner and records a successful manual history entry', async () => {
    runFileLibrarySyncPassMock.mockResolvedValue(successfulResult);

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
