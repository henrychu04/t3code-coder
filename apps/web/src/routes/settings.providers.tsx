import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { WorkspaceProviderSettings } from "../components/settings/WorkspaceProviderSettings";

function ProviderSettingsView() {
  return (
    <SettingsPageContainer>
      <WorkspaceProviderSettings />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/providers")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...(typeof raw.environmentId === "string"
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(typeof raw.instanceId === "string"
      ? { instanceId: ProviderInstanceId.make(raw.instanceId) }
      : {}),
  }),
  component: ProviderSettingsView,
});
