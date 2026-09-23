import { useBrowseConfig } from '@tryghost/admin-x-framework/api/config';

/**
 * Whether the site is in force upgrade mode (requires billing action), from
 * the server config's hostSettings.forceUpgrade. Undefined while config loads.
 */
export function useForceUpgrade(): boolean | undefined {
  const { data: config, isLoading } = useBrowseConfig();

  if (isLoading) {
    return undefined;
  }

  return Boolean(config?.config?.hostSettings?.forceUpgrade);
}
