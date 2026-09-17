import * as Duration from "effect/Duration";
import { SettingsRow, SettingsSection } from "./SettingsPage";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { Input } from "../ui/input";

// Upstream scheduling presets adapted to a Linux workspace; no host power probes.
export const BACKGROUND_INTERVAL_PRESETS = {
  performance: { git: 15, provider: 60 },
  balanced: { git: 30, provider: 300 },
  "battery-saver": { git: 0, provider: 900 },
} as const;
export function BackgroundActivitySettings() {
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed([
    "automaticGitFetchInterval",
    "providerHealthRefreshInterval",
  ]);
  const git = Duration.toMillis(settings.automaticGitFetchInterval) / 1000;
  const provider = Duration.toMillis(settings.providerHealthRefreshInterval) / 1000;
  const selected =
    Object.entries(BACKGROUND_INTERVAL_PRESETS).find(
      ([, value]) => value.git === git && value.provider === provider,
    )?.[0] ?? "custom";
  return (
    <SettingsSection
      title="Background activity"
      id="background-activity"
      description="Control scheduled Git refreshes and provider health checks in the selected workspaces."
    >
      <SettingsRow
        title="Scheduling profile"
        settingKeys={["automaticGitFetchInterval", "providerHealthRefreshInterval"]}
        description="Git refreshes run only for subscribed repositories. Provider health checks run while the helper is connected."
        control={
          <Select
            value={mixed ? null : selected}
            onValueChange={(value) => {
              const preset =
                BACKGROUND_INTERVAL_PRESETS[value as keyof typeof BACKGROUND_INTERVAL_PRESETS];
              if (preset)
                update({
                  automaticGitFetchInterval: Duration.seconds(preset.git),
                  providerHealthRefreshInterval: Duration.seconds(preset.provider),
                });
            }}
          >
            <SelectTrigger aria-label="Background activity profile">
              <SelectValue>
                {mixed
                  ? "Mixed"
                  : selected === "battery-saver"
                    ? "Battery saver"
                    : selected === "performance"
                      ? "Performance"
                      : selected === "balanced"
                        ? "Balanced"
                        : "Custom"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="performance">Performance</SelectItem>
              <SelectItem value="balanced">Balanced</SelectItem>
              <SelectItem value="battery-saver">Battery saver</SelectItem>
              <SelectItem value="custom" disabled>
                Custom
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        id="provider-health-check-interval"
        title="Provider health check interval"
        settingKeys={["providerHealthRefreshInterval"]}
        description="Seconds between provider health checks. Set to 0 to disable scheduled checks. Explicit refreshes still work."
        control={
          <Input
            type="number"
            min={0}
            max={86400}
            aria-label="Provider health check interval"
            value={provider}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (event.target.value && Number.isInteger(value) && value >= 0 && value <= 86400)
                update({ providerHealthRefreshInterval: Duration.seconds(value) });
            }}
          />
        }
      />
    </SettingsSection>
  );
}
