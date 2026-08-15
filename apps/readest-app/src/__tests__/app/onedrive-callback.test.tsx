import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { loadWebOneDriveToken } from '@/services/sync/providers/onedrive/webAuthCodeFlow';

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
vi.mock('@/services/sync/providers/onedrive/onedriveAuth', () => ({
  resolveOneDriveAccountLabel: accountLabelMock,
}));

import OneDriveCallback from '@/app/onedrive-callback/page';

const originalFetch = globalThis.fetch;

describe('OneDriveCallback', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/onedrive-callback');
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
      }),
    }) as typeof fetch;
    settingsState.settings = { version: 1, onedrive: { enabled: false } };
    settingsState.setSettings.mockClear();
    appService.loadSettings.mockClear();
    appService.saveSettings.mockClear();
    envConfig.getAppService.mockClear();
    replaceMock.mockReset();
    toastMock.mockClear();
    accountLabelMock.mockClear();
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('exchanges a state-validated PKCE code, persists the tokens, activates OneDrive, and returns', async () => {
    window.sessionStorage.setItem('onedrive_web_oauth_state', 'expected-state');
    window.sessionStorage.setItem('onedrive_web_oauth_verifier', 'pkce-verifier');
    window.sessionStorage.setItem('onedrive_web_oauth_return', '/library');
    window.history.replaceState(null, '', '/onedrive-callback?code=auth-code&state=expected-state');

    render(<OneDriveCallback />);

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://login.microsoftonline.com/common/oauth2/v2.0/token',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(appService.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          onedrive: expect.objectContaining({
            enabled: true,
            accountLabel: 'reader@example.com',
          }),
        }),
      );
      expect(replaceMock).toHaveBeenCalledWith('/library');
    });

    expect(loadWebOneDriveToken()).toMatchObject({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });
    expect(window.sessionStorage.getItem('onedrive_web_oauth_state')).toBeNull();
    expect(window.sessionStorage.getItem('onedrive_web_oauth_verifier')).toBeNull();
    expect(window.sessionStorage.getItem('onedrive_web_oauth_return')).toBeNull();
    expect(toastMock).toHaveBeenCalledWith('toast', { type: 'info', message: 'Connected' });
  });

  test('cleans state and verifier and displays an error when the returned state is invalid', async () => {
    window.sessionStorage.setItem('onedrive_web_oauth_state', 'expected-state');
    window.sessionStorage.setItem('onedrive_web_oauth_verifier', 'pkce-verifier');
    window.sessionStorage.setItem('onedrive_web_oauth_return', '/settings');
    window.history.replaceState(
      null,
      '',
      '/onedrive-callback?code=auth-code&state=unexpected-state',
    );

    render(<OneDriveCallback />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/settings');
    });

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(loadWebOneDriveToken()).toBeNull();
    expect(appService.saveSettings).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem('onedrive_web_oauth_state')).toBeNull();
    expect(window.sessionStorage.getItem('onedrive_web_oauth_verifier')).toBeNull();
    expect(window.sessionStorage.getItem('onedrive_web_oauth_return')).toBeNull();
    expect(toastMock).toHaveBeenCalledWith('toast', {
      type: 'error',
      message: 'Failed to connect',
    });
  });

  test('cleans state and verifier and displays an error when OAuth is cancelled', async () => {
    window.sessionStorage.setItem('onedrive_web_oauth_state', 'expected-state');
    window.sessionStorage.setItem('onedrive_web_oauth_verifier', 'pkce-verifier');
    window.sessionStorage.setItem('onedrive_web_oauth_return', '/settings');
    window.history.replaceState(
      null,
      '',
      '/onedrive-callback?error=access_denied&state=expected-state',
    );

    render(<OneDriveCallback />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/settings');
    });

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(loadWebOneDriveToken()).toBeNull();
    expect(appService.saveSettings).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem('onedrive_web_oauth_state')).toBeNull();
    expect(window.sessionStorage.getItem('onedrive_web_oauth_verifier')).toBeNull();
    expect(window.sessionStorage.getItem('onedrive_web_oauth_return')).toBeNull();
    expect(toastMock).toHaveBeenCalledWith('toast', {
      type: 'error',
      message: 'Failed to connect',
    });
  });
});
