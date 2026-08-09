import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { SystemSettings } from '@/types/settings';
import { hasAnyThirdPartyEnabled } from '@/services/sync/cloudSyncProvider';
import { createLibraryRefreshHandler } from '@/app/library/refreshLibrarySync';

const h = vi.hoisted(() => ({
  runFileLibrarySyncPass: vi.fn(),
  navigateToLogin: vi.fn(),
  checkOPDSSubscriptions: vi.fn(),
  pullLibrary: vi.fn(),
  envConfig: {} as never,
  router: {} as never,
  translate: (key: string) => key,
}));

const webdavSettings = {
  version: 1,
  webdav: { enabled: true },
} as SystemSettings;

const noThirdPartySettings = { version: 1 } as SystemSettings;

describe('library pull-to-refresh sync', () => {
  beforeEach(() => {
    h.runFileLibrarySyncPass.mockReset().mockResolvedValue(null);
    h.navigateToLogin.mockReset();
    h.checkOPDSSubscriptions.mockReset().mockResolvedValue(undefined);
    h.pullLibrary.mockReset().mockResolvedValue(undefined);
  });

  test.each([
    false,
    true,
  ])('logged-out WebDAV refresh runs the file pass without native sync or redirect (fullRefresh=%s)', async (fullRefresh) => {
    const refresh = createLibraryRefreshHandler({
      user: null,
      settings: webdavSettings,
      envConfig: h.envConfig,
      translate: h.translate,
      router: h.router,
      pullLibrary: h.pullLibrary,
      checkOPDSSubscriptions: h.checkOPDSSubscriptions,
      fullRefresh,
      hasAnyThirdPartyEnabled,
      runFileLibrarySyncPass: h.runFileLibrarySyncPass,
      navigateToLogin: h.navigateToLogin,
    });

    await refresh();

    expect(h.runFileLibrarySyncPass).toHaveBeenCalledWith(h.envConfig, h.translate);
    expect(h.pullLibrary).not.toHaveBeenCalled();
    expect(h.navigateToLogin).not.toHaveBeenCalled();
    expect(h.checkOPDSSubscriptions).toHaveBeenCalledWith(true);
  });

  test.each([
    false,
    true,
  ])('logged-out refresh without a third-party backend redirects instead of syncing (fullRefresh=%s)', async (fullRefresh) => {
    const refresh = createLibraryRefreshHandler({
      user: null,
      settings: noThirdPartySettings,
      envConfig: h.envConfig,
      translate: h.translate,
      router: h.router,
      pullLibrary: h.pullLibrary,
      checkOPDSSubscriptions: h.checkOPDSSubscriptions,
      fullRefresh,
      hasAnyThirdPartyEnabled,
      runFileLibrarySyncPass: h.runFileLibrarySyncPass,
      navigateToLogin: h.navigateToLogin,
    });

    await refresh();

    expect(h.navigateToLogin).toHaveBeenCalledWith(h.router);
    expect(h.runFileLibrarySyncPass).not.toHaveBeenCalled();
    expect(h.pullLibrary).not.toHaveBeenCalled();
    expect(h.checkOPDSSubscriptions).not.toHaveBeenCalled();
  });

  test.each([
    false,
    true,
  ])('runs file sync, native pull, and OPDS refresh sequentially for a logged-in user (fullRefresh=%s)', async (fullRefresh) => {
    const events: string[] = [];
    h.runFileLibrarySyncPass.mockImplementation(async () => {
      events.push('file');
      return null;
    });
    h.pullLibrary.mockImplementation(async () => {
      events.push('native');
    });
    h.checkOPDSSubscriptions.mockImplementation(async () => {
      events.push('opds');
    });
    const refresh = createLibraryRefreshHandler({
      user: { id: 'user-1' },
      settings: noThirdPartySettings,
      envConfig: h.envConfig,
      translate: h.translate,
      router: h.router,
      pullLibrary: h.pullLibrary,
      checkOPDSSubscriptions: h.checkOPDSSubscriptions,
      fullRefresh,
      hasAnyThirdPartyEnabled,
      runFileLibrarySyncPass: h.runFileLibrarySyncPass,
      navigateToLogin: h.navigateToLogin,
    });

    await refresh();

    expect(h.pullLibrary).toHaveBeenCalledWith(fullRefresh, true);
    expect(events).toEqual(['file', 'native', 'opds']);
  });
});
