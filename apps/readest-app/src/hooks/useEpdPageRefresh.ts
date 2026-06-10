import { useCallback, useEffect, useRef } from 'react';
import { getEpdCapabilities, doEpdRefresh } from '@/utils/bridge';

/**
 * Hook that triggers an EPD full-screen refresh every N page turns.
 * Only activates on E-Ink devices with EPD support.
 *
 * Usage: call `notifyPageChange()` from the reader component whenever
 * the user navigates to a new page.
 */
export const useEpdPageRefresh = (refreshInterval: number = 5) => {
  const pageCountRef = useRef(0);
  const isEpdAvailableRef = useRef(false);

  useEffect(() => {
    if (typeof window !== 'undefined' && '.__TAURI__' in window) {
      getEpdCapabilities()
        .then(cap => { isEpdAvailableRef.current = cap.available; })
        .catch(() => { isEpdAvailableRef.current = false; });
    }
  }, []);

  const notifyPageChange = useCallback(() => {
    if (!isEpdAvailableRef.current || refreshInterval <= 0) return;
    pageCountRef.current += 1;
    if (pageCountRef.current >= refreshInterval) {
      pageCountRef.current = 0;
      doEpdRefresh().catch(() => {});
    }
  }, [refreshInterval]);

  return { notifyPageChange };
};
