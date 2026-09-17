import { createFileRoute } from "@tanstack/react-router";
import { useCoder } from "../coder/CoderBootstrap";
import { CoderDeploymentSettings } from "../components/settings/CoderDeploymentSettings";
import { CoderWorkspaceSettings } from "../components/settings/CoderWorkspaceSettings";
import { PortForwardSettings } from "../components/settings/PortForwardSettings";
import { SettingsPage } from "../components/settings/SettingsPage";
import { useCoderSettingsConfig } from "../components/settings/useCoderSettingsConfig";

function CoderSettingsView() {
  const { config, saveConfig, workspaceRuntime } = useCoder();
  const updateConfig = useCoderSettingsConfig(config, saveConfig);
  return (
    <SettingsPage>
      <CoderDeploymentSettings config={config} updateConfig={updateConfig} />
      <CoderWorkspaceSettings updateConfig={updateConfig} />
      <PortForwardSettings
        config={config}
        workspaceRuntime={workspaceRuntime}
        updateConfig={updateConfig}
      />
    </SettingsPage>
  );
}
export const Route = createFileRoute("/settings/general")({ component: CoderSettingsView });
