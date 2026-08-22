import {
  MAX_CODE_FONT_SIZE,
  MAX_GLASS_OPACITY,
  MAX_INTERFACE_FONT_SIZE,
  MAX_PROMPT_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
  MIN_GLASS_OPACITY,
  MIN_INTERFACE_FONT_SIZE,
  MIN_PROMPT_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  type EnvironmentIdentificationMode,
} from "@t3tools/contracts/settings";
import { createFileRoute } from "@tanstack/react-router";

import {
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from "../components/settings/SettingsPage";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { usePrimarySettings, useUpdatePrimarySettings } from "../hooks/useSettings";
import { useTheme } from "../hooks/useTheme";

function FontSizeInput({
  ariaLabel,
  max,
  min,
  onChange,
  value,
}: {
  readonly ariaLabel: string;
  readonly max: number;
  readonly min: number;
  readonly onChange: (value: number) => void;
  readonly value: number;
}) {
  return (
    <Input
      aria-label={ariaLabel}
      className="w-24"
      inputMode="numeric"
      max={max}
      min={min}
      type="number"
      value={String(value)}
      onValueChange={(nextValue) => {
        const parsed = Number(nextValue);
        if (Number.isInteger(parsed) && parsed >= min && parsed <= max) {
          onChange(parsed);
        }
      }}
    />
  );
}

function AppearanceSettingsView() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const { appearanceMode, setAppearanceMode } = useTheme();

  return (
    <SettingsPage>
      <SettingsSection title="Appearance">
        <SettingsRow
          title="Color mode"
          description="Follow the operating system or keep the interface light or dark."
          control={
            <SettingsSelect
              ariaLabel="Color mode"
              value={appearanceMode}
              onChange={(value) => {
                if (value === "system" || value === "light" || value === "dark") {
                  setAppearanceMode(value);
                }
              }}
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </SettingsSelect>
          }
        />
        <SettingsRow
          title="Glass opacity"
          description="Adjust the opacity of menus, dialogs, and the composer."
          control={
            <div className="flex w-full items-center gap-3 sm:w-64">
              <output className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs">
                {settings.glassOpacity}%
              </output>
              <input
                aria-label="Glass opacity"
                className="settings-slider min-w-0 flex-1"
                max={MAX_GLASS_OPACITY}
                min={MIN_GLASS_OPACITY}
                step={5}
                type="range"
                value={settings.glassOpacity}
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
              />
            </div>
          }
        />
        <SettingsRow
          title="Environment identification"
          description="Show environment artwork, a version pill, or no environment marker."
          control={
            <SettingsSelect
              ariaLabel="Environment identification"
              value={settings.environmentIdentificationMode}
              onChange={(value) => {
                if (value === "artwork" || value === "pill" || value === "none") {
                  updateSettings({
                    environmentIdentificationMode: value satisfies EnvironmentIdentificationMode,
                  });
                }
              }}
            >
              <option value="artwork">Artwork</option>
              <option value="pill">Version pill</option>
              <option value="none">None</option>
            </SettingsSelect>
          }
        />
        <SettingsRow
          title="Font smoothing"
          description="Use thinner grayscale font smoothing on macOS."
          control={
            <Switch
              aria-label="Font smoothing"
              checked={settings.fontSmoothing}
              onCheckedChange={(checked) => updateSettings({ fontSmoothing: Boolean(checked) })}
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        title="Typography"
        description="Use a font family name or a CSS fallback list. Leave blank for the app default."
      >
        <SettingsRow
          title="Interface font"
          control={
            <div className="flex w-full flex-col gap-2 sm:w-80 sm:flex-row">
              <Input
                aria-label="Interface font family"
                placeholder="System default"
                value={settings.fontFamilySans}
                onValueChange={(fontFamilySans) => updateSettings({ fontFamilySans })}
              />
              <FontSizeInput
                ariaLabel="Interface font size"
                max={MAX_INTERFACE_FONT_SIZE}
                min={MIN_INTERFACE_FONT_SIZE}
                value={settings.fontSizeInterface}
                onChange={(fontSizeInterface) => updateSettings({ fontSizeInterface })}
              />
            </div>
          }
        />
        <SettingsRow
          title="Prompt font"
          control={
            <div className="flex w-full flex-col gap-2 sm:w-80 sm:flex-row">
              <Input
                aria-label="Prompt font family"
                placeholder="Interface font"
                value={settings.fontFamilyComposer}
                onValueChange={(fontFamilyComposer) => updateSettings({ fontFamilyComposer })}
              />
              <FontSizeInput
                ariaLabel="Prompt font size"
                max={MAX_PROMPT_FONT_SIZE}
                min={MIN_PROMPT_FONT_SIZE}
                value={settings.fontSizePrompt}
                onChange={(fontSizePrompt) => updateSettings({ fontSizePrompt })}
              />
            </div>
          }
        />
        <SettingsRow
          title="Code font"
          control={
            <div className="flex w-full flex-col gap-2 sm:w-80 sm:flex-row">
              <Input
                aria-label="Code font family"
                placeholder="System monospace"
                value={settings.fontFamilyCode}
                onValueChange={(fontFamilyCode) => updateSettings({ fontFamilyCode })}
              />
              <FontSizeInput
                ariaLabel="Code font size"
                max={MAX_CODE_FONT_SIZE}
                min={MIN_CODE_FONT_SIZE}
                value={settings.fontSizeCode}
                onChange={(fontSizeCode) => updateSettings({ fontSizeCode })}
              />
            </div>
          }
        />
        <SettingsRow
          title="Terminal font"
          control={
            <div className="flex w-full flex-col gap-2 sm:w-80 sm:flex-row">
              <Input
                aria-label="Terminal font family"
                placeholder="Code font"
                value={settings.fontFamilyTerminal}
                onValueChange={(fontFamilyTerminal) => updateSettings({ fontFamilyTerminal })}
              />
              <FontSizeInput
                ariaLabel="Terminal font size"
                max={MAX_TERMINAL_FONT_SIZE}
                min={MIN_TERMINAL_FONT_SIZE}
                value={settings.fontSizeTerminal}
                onChange={(fontSizeTerminal) => updateSettings({ fontSizeTerminal })}
              />
            </div>
          }
        />
      </SettingsSection>
    </SettingsPage>
  );
}

export const Route = createFileRoute("/settings/appearance")({
  component: AppearanceSettingsView,
});
