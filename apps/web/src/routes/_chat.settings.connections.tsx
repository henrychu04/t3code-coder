import { createFileRoute } from "@tanstack/react-router";

import { useCoder } from "../coder/CoderBootstrap";
import { CoderDeploymentSettings } from "../components/settings/CoderDeploymentSettings";
import { CoderWorkspaceSettings } from "../components/settings/CoderWorkspaceSettings";
import { PortForwardSettings } from "../components/settings/PortForwardSettings";
import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { useCoderSettingsConfig } from "../components/settings/useCoderSettingsConfig";
import { WorkspaceLinkSettings } from "../components/settings/WorkspaceLinkSettings";

/** Upstream's Connections page, where Coder connects deployments, workspaces, forwards, and links. */
function CoderConnectionsSettings() {
  const { config, saveConfig, workspaceRuntime } = useCoder();
  const updateConfig = useCoderSettingsConfig(config, saveConfig);
  return (
    <SettingsPageContainer>
      <CoderDeploymentSettings config={config} updateConfig={updateConfig} />
      <CoderWorkspaceSettings updateConfig={updateConfig} />
      <PortForwardSettings
        config={config}
        workspaceRuntime={workspaceRuntime}
        updateConfig={updateConfig}
      />
      <WorkspaceLinkSettings config={config} updateConfig={updateConfig} />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/_chat/settings/connections")({
  component: CoderConnectionsSettings,
});
