import { useMemo } from "react";
import { useEnvironments } from "../../state/environments";
import { filterAvailableSettingsSearchItems } from "./settingsSearch";
export function useAvailableSettingsSearchItems() {
  const { environments } = useEnvironments();
  const hasThreadAutoSettlement = environments.some(
    (environment) =>
      environment.connection.phase === "connected" &&
      environment.serverConfig?.environment.capabilities.threadAutoSettlement === true,
  );
  const hasEnvironment = environments.some(
    (environment) =>
      environment.connection.phase === "connected" && environment.serverConfig !== null,
  );
  return useMemo(
    () => filterAvailableSettingsSearchItems({ hasThreadAutoSettlement, hasEnvironment }),
    [hasThreadAutoSettlement, hasEnvironment],
  );
}
