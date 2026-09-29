import { ENVIRONMENT_MACHINE_KINDS, type EnvironmentMachineKind } from "@t3tools/contracts";

import { EnvironmentMachineIcon, ENVIRONMENT_MACHINE_KIND_LABELS } from "../EnvironmentMachineIcon";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

/**
 * Upstream's environment icon choice for Coder workspaces. Coder does not detect a workspace's
 * hardware, so the selected workspace's saved icon, else the generic server, is what shows.
 */
export function EnvironmentIconPicker() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const kind = settings.environmentIcon ?? "server";
  return (
    <SettingsSection title="Workspace identity">
      <SettingsRow
        serverScoped
        settingKeys={["environmentIcon"]}
        {...searchableSetting("environment-icon")}
        description="The icon that stands for this workspace in the sidebar and pickers."
        control={
          <Select
            value={kind}
            onValueChange={(value) => {
              if (value && ENVIRONMENT_MACHINE_KINDS.includes(value as EnvironmentMachineKind))
                updateSettings({ environmentIcon: value as EnvironmentMachineKind });
            }}
          >
            <SelectTrigger size="sm" aria-label="Workspace icon">
              <EnvironmentMachineIcon className="size-4" kind={kind} />
              <SelectValue>{ENVIRONMENT_MACHINE_KIND_LABELS[kind]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {ENVIRONMENT_MACHINE_KINDS.map((option) => (
                <SelectItem key={option} value={option}>
                  {ENVIRONMENT_MACHINE_KIND_LABELS[option]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}
