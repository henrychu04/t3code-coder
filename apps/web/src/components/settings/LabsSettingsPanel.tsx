import { SettingsPageContainer } from "./settingsLayout";
import { LegacyFeaturesSection } from "./SettingsPanels";

/** Features still settling in, and legacy behavior kept for people who rely on it. */
export function LabsSettingsPanel() {
  return (
    <SettingsPageContainer>
      {/* Coder: no Beta section. Guest links need T3 Connect, and linked environments pair
          servers over /mcp; neither is carried. */}
      <LegacyFeaturesSection />
    </SettingsPageContainer>
  );
}
