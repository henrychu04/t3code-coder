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
  // The filtered list must be cached on boolean flags so it stays stable for the search and
  // the command palette while environments update. The compiler cannot tell that `.some()`
  // and other plain calls return primitives, so `=== true` marks each flag as one; without
  // it the flags join the filter's cache scope and the list is rebuilt every render.
  const hasEnvironment =
    environments.some((environment) => environment.serverConfig !== null) === true;
  const hasProviderSettingsEnvironment =
    environments.some(
      (environment) =>
        environment.connection.phase === "connected" && environment.serverConfig !== null,
    ) === true;
  const hasThreadAutoSettlement =
    getThreadAutoSettlementSearchAvailability(environments).eligibleEnvironmentIds.length > 0;

  return filterAvailableSettingsSearchItems({
    localEnvironmentDisabled: true,
    hasCloudPublicConfig: false,
    hasEnvironment,
    hasProviderSettingsEnvironment,
    hasMacProviderSettingsEnvironment: false,
    canManageLocalBackend: false,
    isWslSettingsRowVisible: false,
    hasThreadAutoSettlement,
    // Coder: there is no T3 Connect managed tunnel.
    managedTunnelActive: false,
  });
}
