import { createFileRoute } from "@tanstack/react-router";

import { useCoder } from "../coder/CoderBootstrap";
import { CoderDeploymentSettings } from "../components/settings/CoderDeploymentSettings";
import { CoderWorkspaceSettings } from "../components/settings/CoderWorkspaceSettings";
import { EnvironmentIconPicker } from "../components/settings/EnvironmentIconPicker";
import { PortForwardSettings } from "../components/settings/PortForwardSettings";
import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { useCoderSettingsConfig } from "../components/settings/useCoderSettingsConfig";

/** Upstream's Connections page, where Coder connects deployments, workspaces, and forwards. */
function CoderConnectionsSettings() {
  const { config, saveConfig, workspaceRuntime } = useCoder();
  const updateConfig = useCoderSettingsConfig(config, saveConfig);
  return (
    <SettingsPageContainer>
      <CoderDeploymentSettings config={config} updateConfig={updateConfig} />
      <CoderWorkspaceSettings updateConfig={updateConfig} />
      <EnvironmentIconPicker />
      <PortForwardSettings
        config={config}
        workspaceRuntime={workspaceRuntime}
        updateConfig={updateConfig}
      />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/connections")({
  component: CoderConnectionsSettings,
});
