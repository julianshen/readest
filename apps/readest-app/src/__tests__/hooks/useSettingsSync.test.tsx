import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

import type { SystemSettings } from '@/types/settings';
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

const makePayload = (overrides: Partial<SettingsSyncPayload> = {}): SettingsSyncPayload =>
  ({
    sourceLabel: 'library',
    globalViewSettings: { uiLanguage: 'zh' },
    globalReadSettings: { ...DEFAULT_READSETTINGS },
    ...overrides,
  }) as unknown as SettingsSyncPayload;

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
    renderHook(() => useSettingsSync());
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

  test('preserves window-local fields and credentials on the receiving window', async () => {
    renderHook(() => useSettingsSync());
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

  test('does not save back to disk or rebroadcast after applying a remote update', async () => {
    const saveSettingsSpy = vi.fn();
    useSettingsStore.setState({
      settings: makeSettings(),
      saveSettings: saveSettingsSpy,
    });

    renderHook(() => useSettingsSync());
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
    renderHook(() => useSettingsSync());
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

    renderHook(() => useSettingsSync());
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
    const { unmount } = renderHook(() => useSettingsSync());
    await flushSubscription();

    unmount();

    await vi.waitFor(() => {
      expect(unlistenSpy).toHaveBeenCalledTimes(1);
    });
  });
});
