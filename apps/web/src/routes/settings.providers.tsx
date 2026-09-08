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
  component: ProviderSettingsView,
});
