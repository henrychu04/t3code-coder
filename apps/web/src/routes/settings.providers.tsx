import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { SettingsPage } from "../components/settings/SettingsPage";
import { WorkspaceProviderSettings } from "../components/settings/WorkspaceProviderSettings";

function ProviderSettingsView() {
  return (
    <SettingsPage>
      <WorkspaceProviderSettings />
    </SettingsPage>
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
