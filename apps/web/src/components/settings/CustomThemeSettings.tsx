import { useSyncExternalStore } from "react";
import { useTheme } from "../../hooks/useTheme";
import { getCustomThemes, subscribeToCustomThemes, type ThemeDefinition } from "../../themePalette";
import { ThemeLibrary } from "./ThemeSettings";

const EMPTY_THEMES: readonly ThemeDefinition[] = [];
function readCustomThemes() {
  const themes = getCustomThemes();
  return themes.length ? themes : EMPTY_THEMES;
}

export function CustomThemeSettings() {
  const customThemes = useSyncExternalStore(
    subscribeToCustomThemes,
    readCustomThemes,
    readCustomThemes,
  );
  const {
    theme,
    resolvedTheme,
    themeHalves,
    setTheme,
    setThemeHalf,
    appearanceMode,
    setAppearanceMode,
  } = useTheme();
  return (
    <div id="color-mode">
      <div id="theme">
        <div id="custom-themes">
          <ThemeLibrary
            theme={theme}
            setTheme={setTheme}
            themeHalves={themeHalves}
            setThemeHalf={setThemeHalf}
            appearanceMode={appearanceMode}
            setAppearanceMode={setAppearanceMode}
            customThemes={customThemes}
            initialAppearance={resolvedTheme}
          />
        </div>
      </div>
    </div>
  );
}
