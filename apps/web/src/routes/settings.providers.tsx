import { NativeUsageOverview } from "../components/settings/NativeUsageOverview";
import { createFileRoute } from "@tanstack/react-router";

import { SettingsPage } from "../components/settings/SettingsPage";
import { WorkspaceProviderSettings } from "../components/settings/WorkspaceProviderSettings";

function ProviderSettingsView() {
  return (
    <SettingsPage>
      <WorkspaceProviderSettings />
      <NativeUsageOverview />
    </SettingsPage>
  );
}

export const Route = createFileRoute("/settings/providers")({
  component: ProviderSettingsView,
});
