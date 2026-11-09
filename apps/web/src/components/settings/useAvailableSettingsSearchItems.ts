import { useEnvironments } from "~/state/environments";
import {
  filterAvailableSettingsSearchItems,
  getThreadAutoSettlementSearchAvailability,
} from "./settingsSearch";

/**
 * Upstream's settings search availability for Coder: every environment is a remote workspace,
 * so there is no local backend, hosted cloud configuration, or WSL row to offer.
 */
export function useAvailableSettingsSearchItems() {
  const { environments } = useEnvironments();
  // Explicit booleans keep flags out of the filter cache so environment updates do not rebuild the list.
  const hasEnvironment =
    environments.some((environment) => environment.serverConfig !== null) === true;
  const hasProviderSettingsEnvironment =
    environments.some(
      (environment) =>
        environment.connection.phase === "connected" && environment.serverConfig !== null,
    ) === true;
  // Any machine that offers it; the row then shows for a settings scope where all selected ones do.
  const hasFastWorktreeCheckoutEnvironment =
    environments.some(
      (environment) =>
        environment.connection.phase === "connected" &&
        environment.serverConfig?.environment.capabilities.fastWorktreeCheckout === true,
    ) === true;
  const hasThreadAutoSettlement =
    getThreadAutoSettlementSearchAvailability(environments).eligibleEnvironmentIds.length > 0;

  return filterAvailableSettingsSearchItems({
    localEnvironmentDisabled: true,
    hasCloudPublicConfig: false,
    hasEnvironment,
    hasProviderSettingsEnvironment,
    canManageLocalBackend: false,
    isWslSettingsRowVisible: false,
    hasThreadAutoSettlement,
    // Coder: there is no T3 Connect managed tunnel.
    managedTunnelActive: false,
    hasFastWorktreeCheckoutEnvironment,
  });
}
