import type { EnvConfigType } from '@/services/environment';
import type { TranslationFunc } from '@/hooks/useTranslation';
import type { SystemSettings } from '@/types/settings';
import { isReadestCloudEnabled } from '@/services/sync/cloudSyncProvider';

type RunFileLibrarySyncPass =
  typeof import('@/services/sync/file/runLibrarySync').runFileLibrarySyncPass;
type HasAnyThirdPartyEnabled =
  typeof import('@/services/sync/cloudSyncProvider').hasAnyThirdPartyEnabled;
type NavigateToLogin = typeof import('@/utils/nav').navigateToLogin;

interface LibraryRefreshHandlerOptions {
  user: unknown;
  settings: SystemSettings;
  envConfig: EnvConfigType;
  translate: TranslationFunc;
  router: Parameters<NavigateToLogin>[0];
  pullLibrary: (fullRefresh?: boolean, verbose?: boolean) => Promise<void>;
  checkOPDSSubscriptions: (verbose?: boolean) => Promise<void>;
  fullRefresh: boolean;
  hasAnyThirdPartyEnabled: HasAnyThirdPartyEnabled;
  runFileLibrarySyncPass: RunFileLibrarySyncPass;
  navigateToLogin: NavigateToLogin;
}

export const createLibraryRefreshHandler = ({
  user,
  settings,
  envConfig,
  translate,
  router,
  pullLibrary,
  checkOPDSSubscriptions,
  fullRefresh,
  hasAnyThirdPartyEnabled,
  runFileLibrarySyncPass,
  navigateToLogin,
}: LibraryRefreshHandlerOptions) => {
  return async () => {
    if (!user && !hasAnyThirdPartyEnabled(settings)) {
      navigateToLogin(router);
      return;
    }

    await runFileLibrarySyncPass(envConfig, translate);
    if (user && isReadestCloudEnabled(settings)) {
      await pullLibrary(fullRefresh, true);
    }
    await checkOPDSSubscriptions(true);
  };
};
