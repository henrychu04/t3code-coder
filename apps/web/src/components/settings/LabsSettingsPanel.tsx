import { Link } from "@tanstack/react-router";

import { Switch } from "../ui/switch";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { LegacyFeaturesSection } from "./SettingsPanels";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

/** Features still settling in, and legacy behavior kept for people who rely on it. */
export function LabsSettingsPanel() {
  return (
    <SettingsPageContainer>
      <SettingsSection id="beta" title="Beta">
        <BoringSidebarRow />
        {/* Coder: no guest links row; guest links need T3 Connect, which is not carried. */}
        <LinkedEnvironmentsRow />
      </SettingsSection>
      <LegacyFeaturesSection />
    </SettingsPageContainer>
  );
}

function BoringSidebarRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("boring-sidebar")}
      description="Group sidebar threads into project folders. Pinned threads stay on top, and Snoozed and Settled stay below the folders."
      control={
        <Switch
          checked={settings.boringSidebarEnabled || settings.legacySidebarEnabled}
          // Turning it off also clears the opt-in of the removed legacy sidebar.
          onCheckedChange={(checked) =>
            updateSettings({ boringSidebarEnabled: Boolean(checked), legacySidebarEnabled: false })
          }
          aria-label="Boring sidebar (group by project)"
        />
      }
    />
  );
}

function LinkedEnvironmentsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("linked-environments-beta")}
      settingKeys={["linkedEnvironmentsEnabled"]}
      description={
        <>
          Let agents here work on your other machines, and theirs here. Turn it on for each machine,
          then link them in{" "}
          <Link to="/settings/connections" className="underline underline-offset-2">
            Connections
          </Link>
          . While it is off, nothing new starts over a link; tasks already running finish.
        </>
      }
      control={
        <ScopedSwitch
          settingKeys={["linkedEnvironmentsEnabled"]}
          checked={settings.linkedEnvironmentsEnabled}
          onCheckedChange={(checked) =>
            updateSettings({ linkedEnvironmentsEnabled: Boolean(checked) })
          }
          aria-label="Linked environments"
        />
      }
    />
  );
}
