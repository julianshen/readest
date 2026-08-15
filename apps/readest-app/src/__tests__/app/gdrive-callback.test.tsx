import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { loadWebDriveToken } from '@/services/sync/providers/gdrive/auth/webTokenStore';

const { replaceMock, toastMock, accountLabelMock, appService, envConfig, settingsState } =
  vi.hoisted(() => {
    const settingsState = { settings: {} as Record<string, unknown>, setSettings: vi.fn() };
    const appService = {
      loadSettings: vi.fn(),
      saveSettings: vi.fn().mockResolvedValue(undefined),
    };
    return {
      replaceMock: vi.fn(),
      toastMock: vi.fn(),
      accountLabelMock: vi.fn().mockResolvedValue('reader@example.com'),
      appService,
      envConfig: { getAppService: vi.fn().mockResolvedValue(appService) },
      settingsState,
    };
  });

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: replaceMock }) }));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ envConfig }) }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (key: string) => key }));
vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: Object.assign(
    (selector: (state: typeof settingsState) => unknown) => selector(settingsState),
    { getState: () => settingsState },
  ),
}));
vi.mock('@/utils/event', () => ({ eventDispatcher: { dispatch: toastMock } }));
vi.mock('@/utils/settingsSync', () => ({ broadcastGlobalSettings: vi.fn() }));
vi.mock('@/services/sync/providers/gdrive/WebDriveAuth', () => ({
  WebDriveAuth: class {
    accountLabel = accountLabelMock;
  },
}));

import GDriveCallback from '@/app/gdrive-callback/page';

describe('GDriveCallback', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/gdrive-callback');
    settingsState.settings = { version: 1, googleDrive: { enabled: false } };
    settingsState.setSettings.mockClear();
    appService.loadSettings.mockClear();
    appService.saveSettings.mockClear();
    envConfig.getAppService.mockClear();
    replaceMock.mockReset();
    toastMock.mockClear();
    accountLabelMock.mockClear();
  });

  afterEach(cleanup);

  test('stores a valid OAuth token, activates Google Drive, and returns to the initiating page', async () => {
    window.sessionStorage.setItem('gdrive_web_oauth_state', 'expected-state');
    window.sessionStorage.setItem('gdrive_web_oauth_return', '/library');
    window.history.replaceState(
      null,
      '',
      '/gdrive-callback#access_token=access-token&expires_in=3600&state=expected-state',
    );

    render(<GDriveCallback />);

    await waitFor(() => {
      expect(appService.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          googleDrive: expect.objectContaining({
            enabled: true,
            accountLabel: 'reader@example.com',
          }),
        }),
      );
      expect(replaceMock).toHaveBeenCalledWith('/library');
    });

    expect(loadWebDriveToken()).toMatchObject({ accessToken: 'access-token' });
    expect(window.sessionStorage.getItem('gdrive_web_oauth_state')).toBeNull();
    expect(window.sessionStorage.getItem('gdrive_web_oauth_return')).toBeNull();
    expect(toastMock).toHaveBeenCalledWith('toast', { type: 'info', message: 'Connected' });
  });

  test('cleans pending redirect state and displays an error when the returned state is invalid', async () => {
    window.sessionStorage.setItem('gdrive_web_oauth_state', 'expected-state');
    window.sessionStorage.setItem('gdrive_web_oauth_return', '/settings');
    window.history.replaceState(
      null,
      '',
      '/gdrive-callback#access_token=access-token&expires_in=3600&state=unexpected-state',
    );

    render(<GDriveCallback />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/settings');
    });

    expect(loadWebDriveToken()).toBeNull();
    expect(appService.saveSettings).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem('gdrive_web_oauth_state')).toBeNull();
    expect(window.sessionStorage.getItem('gdrive_web_oauth_return')).toBeNull();
    expect(toastMock).toHaveBeenCalledWith('toast', {
      type: 'error',
      message: 'Failed to connect',
    });
  });

  test('cleans pending redirect state and displays an error when OAuth is cancelled', async () => {
    window.sessionStorage.setItem('gdrive_web_oauth_state', 'expected-state');
    window.sessionStorage.setItem('gdrive_web_oauth_return', '/settings');
    window.history.replaceState(
      null,
      '',
      '/gdrive-callback#error=access_denied&state=expected-state',
    );

    render(<GDriveCallback />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/settings');
    });

    expect(loadWebDriveToken()).toBeNull();
    expect(appService.saveSettings).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem('gdrive_web_oauth_state')).toBeNull();
    expect(window.sessionStorage.getItem('gdrive_web_oauth_return')).toBeNull();
    expect(toastMock).toHaveBeenCalledWith('toast', {
      type: 'error',
      message: 'Failed to connect',
    });
  });
});
