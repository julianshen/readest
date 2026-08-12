import { useEffect } from 'react';
import { useSettingsStore } from '@/store/settingsStore';
import { mergeSyncedGlobalSettings, subscribeSettingsSync } from '@/utils/settingsSync';

/**
 * Adopt global settings broadcast by other app windows. Without this, a
 * window that loaded before another window changed a global setting (or
 * switched the cloud-sync provider) would keep its stale in-memory copy and
 * clobber that change the next time it saves the whole settings object.
 *
 * Loop safety: the merged result is written with `setSettings` (in-memory
 * only) — never `saveSettings` and never a re-broadcast — and
 * `subscribeSettingsSync` already drops this window's own echo via
 * `sourceLabel`, so applying a remote update can never trigger another
 * save → broadcast → apply cycle.
 */
export const useSettingsSync = () => {
  useEffect(() => {
    const unlistenPromise = subscribeSettingsSync((payload) => {
      const { settings, setSettings } = useSettingsStore.getState();
      // Settings may not be loaded yet on this window; skip until they are.
      if (!settings.globalViewSettings) return;
      setSettings(mergeSyncedGlobalSettings(settings, payload));
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);
};
