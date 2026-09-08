import { BundledThemeSettings } from "../components/settings/BundledThemeSettings";
import { PanelAnimationsPreview } from "../components/settings/PanelAnimationsPreview";
import {
  MIN_PANEL_ANIMATION_DURATION_MS,
  MAX_PANEL_ANIMATION_DURATION_MS,
} from "@t3tools/contracts/settings";
import {
  DEFAULT_CLIENT_SETTINGS,
  MAX_APPEARANCE_CONTRAST,
  MAX_GLASS_OPACITY,
  MIN_APPEARANCE_CONTRAST,
  MIN_GLASS_OPACITY,
  type EnvironmentIdentificationMode,
} from "@t3tools/contracts/settings";
import { createFileRoute } from "@tanstack/react-router";

import {
  SettingResetButton,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from "../components/settings/SettingsPage";
import { TypographySection } from "../components/settings/TypographySection";
import type { CSSProperties } from "react";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "../components/ui/select";
import { useClientSettings, useUpdateClientSettings } from "../hooks/useSettings";
import { useTheme } from "../hooks/useTheme";

const ENVIRONMENT_IDENTIFICATION_LABELS: Record<EnvironmentIdentificationMode, string> = {
  artwork: "Artwork",
  pill: "Version pill",
  none: "None",
};

function AppearanceSettingsView() {
  const settings = useClientSettings();
  const updateSettings = useUpdateClientSettings();
  const { appearanceMode, setAppearanceMode } = useTheme();

  const glassOpacityRatio =
    (settings.glassOpacity - MIN_GLASS_OPACITY) / (MAX_GLASS_OPACITY - MIN_GLASS_OPACITY);
  const glassOpacitySliderStyle = {
    "--settings-slider-progress": `${glassOpacityRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - glassOpacityRatio}rem`,
  } as CSSProperties;
  const appearanceContrastRatio =
    (settings.appearanceContrast - MIN_APPEARANCE_CONTRAST) /
    (MAX_APPEARANCE_CONTRAST - MIN_APPEARANCE_CONTRAST);
  const appearanceContrastSliderStyle = {
    "--settings-slider-progress": `${appearanceContrastRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - appearanceContrastRatio}rem`,
  } as CSSProperties;

  const panelAnimationDurationRatio =
    (settings.panelAnimationDurationMs - MIN_PANEL_ANIMATION_DURATION_MS) /
    (MAX_PANEL_ANIMATION_DURATION_MS - MIN_PANEL_ANIMATION_DURATION_MS);
  const panelAnimationDurationSliderStyle = {
    "--settings-slider-progress": `${panelAnimationDurationRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - panelAnimationDurationRatio}rem`,
  } as CSSProperties;
  return (
    <SettingsPage>
      <SettingsSection title="Appearance">
        <SettingsRow
          id="color-mode"
          title="Color mode"
          description="Follow the operating system or keep the interface light or dark."
          resetAction={
            appearanceMode !== "system" ? (
              <SettingResetButton label="color mode" onClick={() => setAppearanceMode("system")} />
            ) : null
          }
          control={
            <Select
              value={appearanceMode}
              onValueChange={(value) => {
                if (value === "system" || value === "light" || value === "dark") {
                  setAppearanceMode(value);
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Color mode">
                <SelectValue>
                  {{ system: "System", light: "Light", dark: "Dark" }[appearanceMode]}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="system">
                  System
                </SelectItem>
                <SelectItem hideIndicator value="light">
                  Light
                </SelectItem>
                <SelectItem hideIndicator value="dark">
                  Dark
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          id="appearance-contrast"
          title="Contrast"
          description="Adjust the contrast of colors and borders across the interface."
          resetAction={
            settings.appearanceContrast !== DEFAULT_CLIENT_SETTINGS.appearanceContrast ? (
              <SettingResetButton
                label="contrast"
                onClick={() =>
                  updateSettings({
                    appearanceContrast: DEFAULT_CLIENT_SETTINGS.appearanceContrast,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-3 sm:w-52">
              <output
                className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                htmlFor="appearance-contrast-input"
              >
                {settings.appearanceContrast}%
              </output>
              <input
                aria-label="Contrast"
                className="settings-slider min-w-0 flex-1"
                id="appearance-contrast-input"
                max={MAX_APPEARANCE_CONTRAST}
                min={MIN_APPEARANCE_CONTRAST}
                onChange={(event) => {
                  const appearanceContrast = Number(event.currentTarget.value);
                  if (
                    Number.isInteger(appearanceContrast) &&
                    appearanceContrast >= MIN_APPEARANCE_CONTRAST &&
                    appearanceContrast <= MAX_APPEARANCE_CONTRAST
                  ) {
                    updateSettings({ appearanceContrast });
                  }
                }}
                step={5}
                style={appearanceContrastSliderStyle}
                type="range"
                value={settings.appearanceContrast}
              />
            </div>
          }
        />
        <SettingsRow
          id="glass-opacity"
          title="Glass opacity"
          description="Higher values make menus, dialogs, and the composer more solid."
          resetAction={
            settings.glassOpacity !== DEFAULT_CLIENT_SETTINGS.glassOpacity ? (
              <SettingResetButton
                label="glass opacity"
                onClick={() =>
                  updateSettings({ glassOpacity: DEFAULT_CLIENT_SETTINGS.glassOpacity })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-3 sm:w-52">
              <output
                className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                htmlFor="glass-opacity-input"
              >
                {settings.glassOpacity}%
              </output>
              <input
                aria-label="Glass opacity"
                className="settings-slider min-w-0 flex-1"
                id="glass-opacity-input"
                max={MAX_GLASS_OPACITY}
                min={MIN_GLASS_OPACITY}
                onChange={(event) => {
                  const glassOpacity = Number(event.currentTarget.value);
                  if (
                    Number.isInteger(glassOpacity) &&
                    glassOpacity >= MIN_GLASS_OPACITY &&
                    glassOpacity <= MAX_GLASS_OPACITY
                  ) {
                    updateSettings({ glassOpacity });
                  }
                }}
                step={5}
                style={glassOpacitySliderStyle}
                type="range"
                value={settings.glassOpacity}
              />
            </div>
          }
        />
        <SettingsRow
          id="environment-identification"
          title="Environment identification"
          description="Show environment artwork, a version pill, or no environment marker."
          resetAction={
            settings.environmentIdentificationMode !==
            DEFAULT_CLIENT_SETTINGS.environmentIdentificationMode ? (
              <SettingResetButton
                label="environment identification"
                onClick={() =>
                  updateSettings({
                    environmentIdentificationMode:
                      DEFAULT_CLIENT_SETTINGS.environmentIdentificationMode,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.environmentIdentificationMode}
              onValueChange={(value) => {
                if (value === "artwork" || value === "pill" || value === "none") {
                  updateSettings({ environmentIdentificationMode: value });
                }
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-40"
                aria-label="Environment identification"
              >
                <SelectValue>
                  {ENVIRONMENT_IDENTIFICATION_LABELS[settings.environmentIdentificationMode]}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {Object.entries(ENVIRONMENT_IDENTIFICATION_LABELS).map(([value, label]) => (
                  <SelectItem hideIndicator key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>

      <SettingsSection title="Motion">
        {" "}
        <SettingsRow
          id="panel-animations"
          title="Panel animations"
          description="Set how fast panels open and close."
          control={
            <div className="grid w-full grid-cols-[5rem_minmax(0,1fr)] items-center gap-3 sm:w-auto sm:grid-cols-[7rem_13rem] sm:gap-4">
              <PanelAnimationsPreview durationMs={settings.panelAnimationDurationMs} />
              <div className="flex w-full items-center gap-3">
                <output
                  className="min-w-16 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                  htmlFor="panel-animation-duration"
                >
                  {settings.panelAnimationDurationMs} ms
                </output>
                <input
                  aria-label="Panel animation duration"
                  className="settings-slider min-w-0 flex-1"
                  id="panel-animation-duration"
                  max={MAX_PANEL_ANIMATION_DURATION_MS}
                  min={MIN_PANEL_ANIMATION_DURATION_MS}
                  onChange={(event) => {
                    const panelAnimationDurationMs = Number(event.currentTarget.value);
                    if (
                      Number.isInteger(panelAnimationDurationMs) &&
                      panelAnimationDurationMs >= MIN_PANEL_ANIMATION_DURATION_MS &&
                      panelAnimationDurationMs <= MAX_PANEL_ANIMATION_DURATION_MS
                    ) {
                      updateSettings({ panelAnimationDurationMs });
                    }
                  }}
                  step={25}
                  style={panelAnimationDurationSliderStyle}
                  type="range"
                  value={settings.panelAnimationDurationMs}
                />
              </div>
            </div>
          }
          resetAction={
            settings.panelAnimationDurationMs !==
            DEFAULT_CLIENT_SETTINGS.panelAnimationDurationMs ? (
              <SettingResetButton
                label="panel animations"
                onClick={() =>
                  updateSettings({
                    panelAnimationDurationMs: DEFAULT_CLIENT_SETTINGS.panelAnimationDurationMs,
                  })
                }
              />
            ) : null
          }
        />
      </SettingsSection>
      <BundledThemeSettings />
      <TypographySection />
    </SettingsPage>
  );
}

export const Route = createFileRoute("/settings/appearance")({
  component: AppearanceSettingsView,
});
