import { useEffect } from 'react';
import { useSettingsStore } from '@/store/settingsStore';
import type { AppService } from '@/types/system';
import {
  mergeSyncedGlobalSettings,
  subscribeSettingsSync,
  type PersistedProviderSettings,
} from '@/utils/settingsSync';

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
export const useSettingsSync = (appService: Pick<AppService, 'loadSettings'> | null) => {
  useEffect(() => {
    let mounted = true;
    let generation = 0;

    const unlistenPromise = subscribeSettingsSync((payload) => {
      const eventGeneration = ++generation;
      const apply = (persistedProviderSettings?: PersistedProviderSettings) => {
        if (!mounted || eventGeneration !== generation) return;

        const { settings, setSettings } = useSettingsStore.getState();
        // Settings may not be loaded yet on this window; skip until they are.
        if (!settings.globalViewSettings) return;
        setSettings(mergeSyncedGlobalSettings(settings, payload, persistedProviderSettings));
      };

      // Routine global-setting broadcasts carry no provider changes. Reloading
      // the whole provider slices for those events could replace live cursors
      // and device state with an older disk snapshot. Only provider-switch
      // broadcasts need the persisted credential/configuration merge.
      if (!appService || !payload.cloudSyncProviders) {
        apply();
        return;
      }

      try {
        void appService.loadSettings().then(apply, () => apply());
      } catch {
        apply();
      }
    });
    return () => {
      mounted = false;
      generation += 1;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [appService]);
};
