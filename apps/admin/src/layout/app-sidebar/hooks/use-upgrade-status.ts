export interface UpgradeStatus {
  showUpgradeBanner: boolean;
  trialDaysRemaining: number;
}

// The trial state came from Ember's billing app, which this admin no longer loads.
export function useUpgradeStatus(): UpgradeStatus {
  return {
    showUpgradeBanner: false,
    trialDaysRemaining: 0,
  };
}
