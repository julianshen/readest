import { useCallback, useEffect, useRef } from 'react';
import { getEpdCapabilities, doEpdRefresh, setEpdMode } from '@/utils/bridge';

interface UseEpdPageRefreshOptions {
  /** Gate on the platform (e.g. appService?.isAndroidApp) — the EPD plugin only exists there. */
  enabled: boolean;
  /** Persisted EPD mode to re-apply on mount; the device resets to AUTO between app launches. */
  epdMode?: string;
  /** Trigger a full EPD refresh every N page turns; 0 disables. */
  refreshInterval?: number;
}

/**
 * Reader-side EPD integration for e-ink devices (Boox etc.).
 *
 * On mount, queries the eink plugin for EPD support and re-applies the
 * persisted EPD mode. Call `notifyPageChange()` on every page relocation to
 * get a full-screen (GC) refresh every `refreshInterval` page turns, clearing
 * accumulated ghosting.
 */
export const useEpdPageRefresh = ({
  enabled,
  epdMode,
  refreshInterval = 5,
}: UseEpdPageRefreshOptions) => {
  const pageCountRef = useRef(0);
  const isEpdAvailableRef = useRef(false);
  const modeAppliedRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    getEpdCapabilities()
      .then((cap) => {
        isEpdAvailableRef.current = cap.available;
      })
      .catch(() => {
        isEpdAvailableRef.current = false;
      });
  }, [enabled]);

  // Re-apply the persisted mode once per reader session; live changes are
  // applied by the settings panel. The plugin resolves harmlessly on devices
  // without an EPD controller. epdMode is a dep because view settings load
  // asynchronously after the first render.
  useEffect(() => {
    if (!enabled || modeAppliedRef.current || !epdMode || epdMode === 'AUTO') return;
    modeAppliedRef.current = true;
    setEpdMode({ mode: epdMode }).catch(() => {});
  }, [enabled, epdMode]);

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
