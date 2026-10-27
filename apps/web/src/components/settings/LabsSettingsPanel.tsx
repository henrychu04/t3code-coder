import { SettingsPageContainer } from "./settingsLayout";
import { LegacyFeaturesSection } from "./SettingsPanels";

/** Features still settling in, and legacy behavior kept for people who rely on it. */
export function LabsSettingsPanel() {
  return (
    <SettingsPageContainer>
      {/* Coder: no guest links, the Beta section's only row; guest sharing needs T3 Connect. */}
      <LegacyFeaturesSection />
    </SettingsPageContainer>
  );
}
