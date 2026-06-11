import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

vi.mock('@/utils/bridge', () => ({
  getEpdCapabilities: vi.fn(),
  doEpdRefresh: vi.fn(),
  setEpdMode: vi.fn(),
}));

import { getEpdCapabilities, doEpdRefresh, setEpdMode } from '@/utils/bridge';
import { useEpdPageRefresh } from '@/hooks/useEpdPageRefresh';

const mockedCaps = vi.mocked(getEpdCapabilities);
const mockedRefresh = vi.mocked(doEpdRefresh);
const mockedSetMode = vi.mocked(setEpdMode);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('useEpdPageRefresh', () => {
  test('queries capabilities and re-applies persisted EPD mode when enabled', async () => {
    mockedCaps.mockResolvedValue({ available: true, modes: ['AUTO', 'TEXT'] });
    mockedSetMode.mockResolvedValue(undefined);
    renderHook(() => useEpdPageRefresh({ enabled: true, epdMode: 'TEXT', refreshInterval: 5 }));
    await waitFor(() => expect(mockedSetMode).toHaveBeenCalledWith({ mode: 'TEXT' }));
  });

  test('does not re-apply the default AUTO mode', async () => {
    mockedCaps.mockResolvedValue({ available: true, modes: ['AUTO'] });
    renderHook(() => useEpdPageRefresh({ enabled: true, epdMode: 'AUTO', refreshInterval: 5 }));
    await waitFor(() => expect(mockedCaps).toHaveBeenCalled());
    expect(mockedSetMode).not.toHaveBeenCalled();
  });

  test('does not query capabilities when disabled', () => {
    renderHook(() => useEpdPageRefresh({ enabled: false, epdMode: 'TEXT', refreshInterval: 5 }));
    expect(mockedCaps).not.toHaveBeenCalled();
  });

  test('triggers a full refresh every N page turns and resets the counter', async () => {
    mockedCaps.mockResolvedValue({ available: true, modes: [] });
    mockedRefresh.mockResolvedValue(undefined);
    const { result } = renderHook(() => useEpdPageRefresh({ enabled: true, refreshInterval: 3 }));
    await waitFor(() => expect(mockedCaps).toHaveBeenCalled());

    act(() => {
      result.current.notifyPageChange();
      result.current.notifyPageChange();
    });
    expect(mockedRefresh).not.toHaveBeenCalled();

    act(() => {
      result.current.notifyPageChange();
    });
    expect(mockedRefresh).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.notifyPageChange();
      result.current.notifyPageChange();
    });
    expect(mockedRefresh).toHaveBeenCalledTimes(1);
  });

  test('never refreshes when EPD is unavailable', async () => {
    mockedCaps.mockResolvedValue({ available: false, modes: [] });
    const { result } = renderHook(() => useEpdPageRefresh({ enabled: true, refreshInterval: 1 }));
    await waitFor(() => expect(mockedCaps).toHaveBeenCalled());
    act(() => {
      result.current.notifyPageChange();
    });
    expect(mockedRefresh).not.toHaveBeenCalled();
  });

  test('refreshInterval of 0 disables the periodic refresh', async () => {
    mockedCaps.mockResolvedValue({ available: true, modes: [] });
    const { result } = renderHook(() => useEpdPageRefresh({ enabled: true, refreshInterval: 0 }));
    await waitFor(() => expect(mockedCaps).toHaveBeenCalled());
    act(() => {
      result.current.notifyPageChange();
      result.current.notifyPageChange();
    });
    expect(mockedRefresh).not.toHaveBeenCalled();
  });
});
