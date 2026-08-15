import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

import type { SystemSettings } from '@/types/settings';
import type { AppService } from '@/types/system';
import type { SettingsSyncPayload } from '@/utils/settingsSync';

vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
  listen: vi.fn(),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({ label: 'reader-1' })),
}));

vi.mock('@/services/environment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/environment')>();
  return {
    ...actual,
    isTauriAppPlatform: vi.fn(() => true),
  };
});

import { emit, listen } from '@tauri-apps/api/event';
import { useSettingsStore } from '@/store/settingsStore';
import { DEFAULT_READSETTINGS, DEFAULT_SYSTEM_SETTINGS } from '@/services/constants';
import { SETTINGS_SYNC_EVENT } from '@/utils/settingsSync';
import { useSettingsSync } from '@/hooks/useSettingsSync';

type ListenHandler = (event: { payload: SettingsSyncPayload }) => void;

const CURRENT_LABEL = 'reader-1';

let capturedHandler: ListenHandler | null;
let unlistenSpy: Mock<() => void>;

const makeSettings = (overrides: Partial<SystemSettings> = {}): SystemSettings =>
  ({
    ...DEFAULT_SYSTEM_SETTINGS,
    version: 1,
    localBooksDir: '/books',
    lastOpenBooks: ['book-a'],
    globalViewSettings: { uiLanguage: 'en' },
    globalReadSettings: { ...DEFAULT_READSETTINGS },
    webdav: {
      ...DEFAULT_SYSTEM_SETTINGS.webdav!,
      enabled: false,
      password: 'secret-credential',
    },
    googleDrive: { ...DEFAULT_SYSTEM_SETTINGS.googleDrive!, enabled: false },
    ...overrides,
  }) as unknown as SystemSettings;

const makeGlobalViewSettings = (uiLanguage: string): SystemSettings['globalViewSettings'] => ({
  ...makeSettings().globalViewSettings,
  uiLanguage,
});

const makePayload = (overrides: Partial<SettingsSyncPayload> = {}): SettingsSyncPayload =>
  ({
    sourceLabel: 'library',
    globalViewSettings: { uiLanguage: 'zh' },
    globalReadSettings: { ...DEFAULT_READSETTINGS },
    ...overrides,
  }) as unknown as SettingsSyncPayload;

type SettingsLoader = Pick<AppService, 'loadSettings'>;

const makeAppService = () => ({
  loadSettings: vi.fn<SettingsLoader['loadSettings']>(),
});

const createDeferred = <T,>() => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
};

/** Flush pending microtasks so the async subscription in the effect resolves. */
const flushSubscription = async () => {
  await vi.waitFor(() => {
    expect(listen).toHaveBeenCalledWith(SETTINGS_SYNC_EVENT, expect.any(Function));
    expect(capturedHandler).not.toBeNull();
  });
};

const receiveFromRemote = (payload: SettingsSyncPayload) => {
  act(() => {
    capturedHandler!({ payload });
  });
};

beforeEach(() => {
  capturedHandler = null;
  unlistenSpy = vi.fn();
  vi.mocked(listen).mockImplementation(async (_event, handler) => {
    capturedHandler = handler as ListenHandler;
    return unlistenSpy;
  });
  vi.mocked(emit).mockClear();
  useSettingsStore.setState({ settings: makeSettings() });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useSettingsSync', () => {
  test('applies cloud-sync provider flags broadcast by another window', async () => {
    renderHook(() => useSettingsSync(null));
    await flushSubscription();

    receiveFromRemote(
      makePayload({
        cloudSyncProviders: {
          webdav: { enabled: true, providerSelectedAt: 1234567890 },
          googleDrive: { enabled: false },
        },
      }),
    );

    const { settings } = useSettingsStore.getState();
    expect(settings.webdav.enabled).toBe(true);
    expect(settings.webdav.providerSelectedAt).toBe(1234567890);
    // The synced global blobs are adopted wholesale.
    expect(settings.globalViewSettings).toEqual({ uiLanguage: 'zh' });
  });

  test('uses persisted provider credentials while payload flags remain authoritative', async () => {
    const appService = makeAppService();
    const persisted = makeSettings({
      webdav: {
        ...DEFAULT_SYSTEM_SETTINGS.webdav!,
        enabled: false,
        serverUrl: 'https://persisted.example.com',
        username: 'persisted-user',
        password: 'persisted-password',
        providerSelectedAt: 11,
      },
    });
    appService.loadSettings.mockResolvedValue(persisted);

    renderHook(() => useSettingsSync(appService));
    await flushSubscription();

    receiveFromRemote(
      makePayload({
        cloudSyncProviders: {
          webdav: { enabled: true, providerSelectedAt: 22 },
          googleDrive: { enabled: false },
        },
      }),
    );

    await vi.waitFor(() => {
      expect(useSettingsStore.getState().settings.webdav.password).toBe('persisted-password');
    });

    const { settings } = useSettingsStore.getState();
    expect(settings.webdav.serverUrl).toBe('https://persisted.example.com');
    expect(settings.webdav.username).toBe('persisted-user');
    expect(settings.webdav.enabled).toBe(true);
    expect(settings.webdav.providerSelectedAt).toBe(22);
  });

  test('falls back to the live settings when persisted settings cannot be loaded', async () => {
    const appService = makeAppService();
    appService.loadSettings.mockRejectedValue(new Error('disk unavailable'));

    renderHook(() => useSettingsSync(appService));
    await flushSubscription();

    receiveFromRemote(
      makePayload({
        cloudSyncProviders: {
          webdav: { enabled: true, providerSelectedAt: 23 },
          googleDrive: { enabled: false },
        },
      }),
    );

    await vi.waitFor(() => {
      expect(useSettingsStore.getState().settings.webdav.enabled).toBe(true);
    });

    const { settings } = useSettingsStore.getState();
    expect(settings.globalViewSettings).toEqual({ uiLanguage: 'zh' });
    expect(settings.webdav.password).toBe('secret-credential');
    expect(settings.webdav.providerSelectedAt).toBe(23);
  });

  test('preserves window-local fields and credentials on the receiving window', async () => {
    renderHook(() => useSettingsSync(null));
    await flushSubscription();

    receiveFromRemote(
      makePayload({
        cloudSyncProviders: {
          webdav: { enabled: true, providerSelectedAt: 42 },
          googleDrive: { enabled: true, providerSelectedAt: 43 },
        },
      }),
    );

    const { settings } = useSettingsStore.getState();
    // Device/window-local fields must survive the merge.
    expect(settings.localBooksDir).toBe('/books');
    expect(settings.lastOpenBooks).toEqual(['book-a']);
    // Credentials never ride the wire; the local copy is preserved.
    expect(settings.webdav.password).toBe('secret-credential');
    // Fields the payload did not mention keep their local values.
    expect(settings.webdav.serverUrl).toBe(DEFAULT_SYSTEM_SETTINGS.webdav!.serverUrl);
    expect(settings.googleDrive.enabled).toBe(true);
  });

  test('does not let an earlier disk load overwrite a newer event', async () => {
    const appService = makeAppService();
    const firstLoad = createDeferred<SystemSettings>();
    const secondLoad = createDeferred<SystemSettings>();
    appService.loadSettings
      .mockImplementationOnce(() => firstLoad.promise)
      .mockImplementationOnce(() => secondLoad.promise);
    const firstSettings = makeSettings({
      webdav: { ...DEFAULT_SYSTEM_SETTINGS.webdav!, password: 'first-password' },
    });
    const secondSettings = makeSettings({
      webdav: { ...DEFAULT_SYSTEM_SETTINGS.webdav!, password: 'second-password' },
    });

    renderHook(() => useSettingsSync(appService));
    await flushSubscription();

    receiveFromRemote(
      makePayload({
        globalViewSettings: makeGlobalViewSettings('first'),
        cloudSyncProviders: {
          webdav: { enabled: true, providerSelectedAt: 1 },
          googleDrive: { enabled: false },
        },
      }),
    );
    receiveFromRemote(
      makePayload({
        globalViewSettings: makeGlobalViewSettings('second'),
        cloudSyncProviders: {
          webdav: { enabled: false, providerSelectedAt: 2 },
          googleDrive: { enabled: false },
        },
      }),
    );

    await act(async () => {
      secondLoad.resolve(secondSettings);
      await secondLoad.promise;
    });
    await act(async () => {
      firstLoad.resolve(firstSettings);
      await firstLoad.promise;
    });

    const { settings } = useSettingsStore.getState();
    expect(settings.globalViewSettings).toEqual({ uiLanguage: 'second' });
    expect(settings.webdav.password).toBe('second-password');
    expect(settings.webdav.enabled).toBe(false);
    expect(settings.webdav.providerSelectedAt).toBe(2);
  });

  test('does not apply a disk load that resolves after unmount', async () => {
    const appService = makeAppService();
    const pendingLoad = createDeferred<SystemSettings>();
    appService.loadSettings.mockReturnValue(pendingLoad.promise);

    const { unmount } = renderHook(() => useSettingsSync(appService));
    await flushSubscription();

    receiveFromRemote(
      makePayload({
        cloudSyncProviders: {
          webdav: { enabled: true, providerSelectedAt: 7 },
          googleDrive: { enabled: false },
        },
      }),
    );
    const beforeUnmount = useSettingsStore.getState().settings;
    unmount();

    await act(async () => {
      pendingLoad.resolve(
        makeSettings({ webdav: { ...DEFAULT_SYSTEM_SETTINGS.webdav!, enabled: true } }),
      );
      await pendingLoad.promise;
    });

    expect(useSettingsStore.getState().settings).toBe(beforeUnmount);
  });

  test('does not save back to disk or rebroadcast after applying a remote update', async () => {
    const saveSettingsSpy = vi.fn();
    useSettingsStore.setState({
      settings: makeSettings(),
      saveSettings: saveSettingsSpy,
    });

    renderHook(() => useSettingsSync(null));
    await flushSubscription();

    receiveFromRemote(
      makePayload({
        cloudSyncProviders: {
          webdav: { enabled: true, providerSelectedAt: 7 },
          googleDrive: { enabled: false },
        },
      }),
    );

    // The merge landed in the store...
    expect(useSettingsStore.getState().settings.webdav.enabled).toBe(true);
    // ...but nothing was written back or re-emitted (no sync loop).
    expect(saveSettingsSpy).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  test('ignores an echo of this window’s own broadcast', async () => {
    renderHook(() => useSettingsSync(null));
    await flushSubscription();

    const before = useSettingsStore.getState().settings;
    receiveFromRemote(
      makePayload({
        sourceLabel: CURRENT_LABEL,
        cloudSyncProviders: {
          webdav: { enabled: true, providerSelectedAt: 999 },
          googleDrive: { enabled: true, providerSelectedAt: 999 },
        },
      }),
    );

    const after = useSettingsStore.getState().settings;
    expect(after).toBe(before);
    expect(after.webdav.enabled).toBe(false);
  });

  test('skips the update when this window has not loaded settings yet', async () => {
    const unloaded = {} as SystemSettings;
    useSettingsStore.setState({ settings: unloaded });

    renderHook(() => useSettingsSync(null));
    await flushSubscription();

    receiveFromRemote(
      makePayload({
        cloudSyncProviders: {
          webdav: { enabled: true, providerSelectedAt: 1 },
          googleDrive: { enabled: false },
        },
      }),
    );

    // Store identity is untouched — no partial merge onto an unloaded window.
    expect(useSettingsStore.getState().settings).toBe(unloaded);
  });

  test('unsubscribes from the Tauri event on unmount', async () => {
    const { unmount } = renderHook(() => useSettingsSync(null));
    await flushSubscription();

    unmount();

    await vi.waitFor(() => {
      expect(unlistenSpy).toHaveBeenCalledTimes(1);
    });
  });
});
