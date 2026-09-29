import { useMemo } from "react";

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

  return useMemo(
    () =>
      filterAvailableSettingsSearchItems({
        localEnvironmentDisabled: true,
        hasCloudPublicConfig: false,
        hasEnvironment: environments.some((environment) => environment.serverConfig !== null),
        hasProviderSettingsEnvironment: environments.some(
          (environment) =>
            environment.connection.phase === "connected" && environment.serverConfig !== null,
        ),
        canManageLocalBackend: false,
        isWslSettingsRowVisible: false,
        hasThreadAutoSettlement:
          getThreadAutoSettlementSearchAvailability(environments).eligibleEnvironmentIds.length > 0,
      }),
    [environments],
  );
}
