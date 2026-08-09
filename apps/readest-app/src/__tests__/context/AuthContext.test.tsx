import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useSettingsStore } from '@/store/settingsStore';
import { CLOUD_SYNC_REQUIRES_PREMIUM } from '@/utils/access';
import { getActiveFileSyncBackends, setCachedUserPlan } from '@/services/sync/cloudSyncProvider';

const h = vi.hoisted(() => ({
  getUserProfilePlan: vi.fn(),
  refreshSession: vi.fn(),
  signOut: vi.fn(),
  unsubscribe: vi.fn(),
}));

vi.mock('@/utils/supabase', () => ({
  supabase: {
    auth: {
      refreshSession: h.refreshSession,
      signOut: h.signOut,
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: h.unsubscribe } },
      })),
    },
  },
}));

vi.mock('posthog-js', () => ({ default: { identify: vi.fn() } }));

vi.mock('@/utils/access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/access')>();
  return { ...actual, getUserProfilePlan: h.getUserProfilePlan };
});

import { AuthProvider, useAuth } from '@/context/AuthContext';

const storage = new Map<string, string>();

const installLocalStorage = () => {
  vi.stubGlobal('localStorage', {
    clear: () => storage.clear(),
    getItem: (key: string) => storage.get(key) ?? null,
    removeItem: (key: string) => storage.delete(key),
    setItem: (key: string, value: string) => storage.set(key, value),
  });
};

describe('AuthProvider cloud-sync entitlement lifecycle', () => {
  beforeEach(() => {
    installLocalStorage();
    localStorage.clear();
    localStorage.setItem('token', 'paid-token');
    localStorage.setItem('user', JSON.stringify({ id: 'user-1' }));
    h.getUserProfilePlan.mockReset().mockReturnValue('pro');
    h.refreshSession.mockReset().mockResolvedValue(undefined);
    h.signOut.mockReset().mockResolvedValue(undefined);
    h.unsubscribe.mockReset();
    setCachedUserPlan('free');
    useSettingsStore.setState((state) => ({
      settings: {
        ...state.settings,
        webdav: { ...state.settings.webdav, enabled: true },
      },
    }));
  });

  afterEach(() => {
    localStorage.clear();
    setCachedUserPlan('free');
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  test('activates paid third-party backends from the stored auth token and resets on logout', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AuthProvider>{children}</AuthProvider>
    );
    expect(CLOUD_SYNC_REQUIRES_PREMIUM).toBe(true);
    expect(getActiveFileSyncBackends(useSettingsStore.getState().settings)).toEqual([]);

    const { result } = renderHook(() => useAuth(), { wrapper });

    expect(h.getUserProfilePlan).toHaveBeenCalledWith('paid-token');
    expect(getActiveFileSyncBackends(useSettingsStore.getState().settings)).toEqual(['webdav']);

    await act(async () => {
      await result.current.logout();
    });

    await waitFor(() => expect(result.current.user).toBeNull());
    expect(getActiveFileSyncBackends(useSettingsStore.getState().settings)).toEqual([]);
  });
});
