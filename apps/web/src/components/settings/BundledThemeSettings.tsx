import { MoonIcon, SunIcon } from "lucide-react";
import { useState, type ReactElement } from "react";
import { cn } from "../../lib/utils";
import { useTheme, readThemeHalves } from "../../hooks/useTheme";
import {
  getThemeDefinition,
  T3_CHAT_THEME,
  GROVE_THEME,
  OCEAN_THEME,
  EMBER_THEME,
  IRIS_THEME,
  type ThemeAppearance,
} from "../../themePalette";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  STANDARD_THEME_CARDS,
  getThemeCardDefinition,
  previewColorsOf,
  ThemePreviewCircle,
  ThemePreviewCircles,
  type ThemeCardDefinition,
  type ThemeMode,
} from "./ThemePreviewCircles";
import { ThemeWireframe } from "./ThemeWireframe";
import { SettingsSection } from "./SettingsPage";

function ThemeVariantTooltip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

function ThemeLibraryCard({
  theme,
  isActive,
  onUse,
  onUseMode,
  activeModes,
  variantNavigation,
}: {
  theme: ThemeCardDefinition;
  isActive: boolean;
  onUse: () => void;
  onUseMode: (mode: ThemeMode) => void;
  activeModes: ReadonlyArray<ThemeMode>;
  variantNavigation?: {
    collectionLabel: string;
    options: ReadonlyArray<{
      themeIndex: number;
      label: string;
      activeModes: ReadonlyArray<ThemeMode>;
      preview: ThemeCardDefinition["previews"][number];
    }>;
    onSelectAndUse: (themeIndex: number, mode: ThemeAppearance) => void;
  };
}) {
  // A one-appearance theme can only take its own side of the mix, so the card
  // tooltip promises exactly what clicking it does.
  const cardModes = theme.previews.map((preview) => preview.mode);
  const [radialModeOpen, setRadialModeOpen] = useState<ThemeAppearance | null>(null);
  const radialModeGroups = (["light", "dark"] as const).map((mode) => {
    const options =
      variantNavigation?.options.flatMap((option) => {
        const preview = option.preview;
        return preview.mode === mode ? [{ option, preview }] : [];
      }) ?? [];
    return {
      mode,
      options,
      selected: options.find(({ option }) => option.activeModes.includes(mode)) ?? options[0],
    };
  });
  return (
    // The card surface stays a plain div (buttons cannot nest inside a button
    // role); the title button and mode circles carry the accessible actions,
    // while the card click is a pointer-only convenience.
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className={cn(
              "cursor-pointer overflow-hidden rounded-xl border border-border/70 bg-card/60 transition-colors hover:bg-accent/10",
              isActive && "bg-accent/30",
            )}
            data-theme-library-card={theme.id}
            onClick={onUse}
            style={isActive ? { boxShadow: "inset 0 0 0 1px var(--ring)" } : undefined}
          >
            <div className="relative">
              {variantNavigation ? (
                <div
                  aria-label="Light and dark theme variants"
                  className="relative h-20"
                  role="group"
                  onBlurCapture={(event) => {
                    const nextTarget = event.relatedTarget;
                    if (
                      !(nextTarget instanceof Node) ||
                      !event.currentTarget.contains(nextTarget)
                    ) {
                      setRadialModeOpen(null);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setRadialModeOpen(null);
                  }}
                  onMouseLeave={() => setRadialModeOpen(null)}
                >
                  {radialModeGroups.map(({ mode, options, selected }) => {
                    if (!selected) return null;
                    const rootOffsetX = mode === "light" ? -52 : 52;
                    const isOpen = radialModeOpen === mode;
                    const isActive = selected.option.activeModes.includes(mode);
                    const modeLabel = mode === "light" ? "Light" : "Dark";
                    return (
                      <div className="contents" key={mode}>
                        <ThemeVariantTooltip label={`${modeLabel}: ${selected.option.label}`}>
                          <button
                            aria-label={
                              options.length > 1
                                ? `Choose ${mode} variant, ${options.length} options, currently ${selected.option.label}`
                                : `Use ${mode} variant, currently ${selected.option.label}`
                            }
                            aria-pressed={isActive}
                            className="absolute left-1/2 top-2 z-20 flex size-14 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            style={{
                              transform: `translateX(calc(-50% + ${rootOffsetX}px))`,
                            }}
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              variantNavigation.onSelectAndUse(selected.option.themeIndex, mode);
                            }}
                            onFocus={() => setRadialModeOpen(mode)}
                            onMouseEnter={() => setRadialModeOpen(mode)}
                          >
                            <ThemePreviewCircle
                              colors={selected.preview.colors}
                              mode={selected.preview.mode}
                            />
                            {isActive ? (
                              <span
                                aria-hidden
                                className="pointer-events-none absolute inset-0 rounded-full ring-2 ring-ring"
                              />
                            ) : null}
                            {isActive ? (
                              <span className="pointer-events-none absolute -bottom-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full border border-border/70 bg-background text-foreground shadow-sm">
                                {mode === "light" ? (
                                  <SunIcon className="size-2.5" />
                                ) : (
                                  <MoonIcon className="size-2.5" />
                                )}
                              </span>
                            ) : null}
                          </button>
                        </ThemeVariantTooltip>
                        <span
                          className="pointer-events-none absolute bottom-0 left-1/2 inline-flex max-w-24 -translate-x-1/2 items-center gap-1 text-[11px] font-medium text-foreground"
                          style={{ marginLeft: rootOffsetX }}
                        >
                          <span className="truncate">{selected.option.label}</span>
                          {options.length > 1 ? (
                            <span className="shrink-0 rounded-full bg-muted px-1 text-[9px] text-muted-foreground">
                              +{options.length - 1}
                            </span>
                          ) : null}
                        </span>
                        {options.length > 1
                          ? options.map(({ option, preview }, optionIndex) => {
                              const progress = optionIndex / (options.length - 1) - 0.5;
                              const childOffsetX = rootOffsetX + progress * 68;
                              const childOffsetY = Math.abs(progress) * 10;
                              const optionIsActive = option.activeModes.includes(mode);
                              return (
                                <ThemeVariantTooltip
                                  key={option.label}
                                  label={`Use ${option.label} for ${mode} mode`}
                                >
                                  <button
                                    aria-label={`Use ${option.label} for ${mode} mode${optionIsActive ? ", currently active" : ""}`}
                                    aria-pressed={optionIsActive}
                                    className={cn(
                                      "absolute left-1/2 top-1 z-30 flex size-7 items-center justify-center rounded-full bg-background shadow-sm outline-none transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none focus-visible:ring-2 focus-visible:ring-ring",
                                      optionIsActive ? "ring-2 ring-ring" : "ring-1 ring-border/70",
                                    )}
                                    style={{
                                      opacity: isOpen ? 1 : 0,
                                      pointerEvents: isOpen ? "auto" : "none",
                                      transform: `translate(calc(-50% + ${isOpen ? childOffsetX : rootOffsetX}px), ${isOpen ? childOffsetY : 28}px) scale(${isOpen ? 1 : 0.55})`,
                                      transitionDelay: isOpen ? `${optionIndex * 35}ms` : "0ms",
                                    }}
                                    type="button"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      variantNavigation.onSelectAndUse(option.themeIndex, mode);
                                    }}
                                    onFocus={() => setRadialModeOpen(mode)}
                                    onMouseEnter={() => setRadialModeOpen(mode)}
                                  >
                                    <span className="pointer-events-none scale-[0.43]">
                                      <ThemePreviewCircle
                                        colors={preview.colors}
                                        mode={preview.mode}
                                      />
                                    </span>
                                  </button>
                                </ThemeVariantTooltip>
                              );
                            })
                          : null}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <ThemePreviewCircles
                  label={theme.label}
                  activeModes={activeModes}
                  onSelectMode={onUseMode}
                  previews={theme.previews}
                />
              )}
            </div>
            <div className="flex items-center gap-2 px-3 pb-3 pt-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <button
                    aria-label={`Use ${variantNavigation ? `${variantNavigation.collectionLabel}, ${theme.label} variant` : `${theme.label} theme`}${isActive ? ", currently active" : ""}`}
                    aria-pressed={isActive}
                    className="min-w-0 cursor-pointer truncate rounded-sm text-left text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onUse();
                    }}
                  >
                    {variantNavigation?.collectionLabel ?? theme.label}
                  </button>
                </div>
              </div>
            </div>
          </div>
        }
      />
      <TooltipPopup>
        {variantNavigation
          ? "Use the first variants for light and dark"
          : cardModes.length > 1
            ? "Use for both light and dark"
            : `Use for ${cardModes[0]} mode only`}
      </TooltipPopup>
    </Tooltip>
  );
}

const BUNDLED_THEME_CARDS = [
  ...STANDARD_THEME_CARDS,
  ...[T3_CHAT_THEME, GROVE_THEME, OCEAN_THEME, EMBER_THEME, IRIS_THEME].map(getThemeCardDefinition),
];

export function BundledThemeSettings() {
  const { theme, themeHalves, appearanceMode, setTheme, setThemeHalf } = useTheme();
  const [error, setError] = useState<string | null>(null);
  const save = (operation: () => boolean) => {
    setError(operation() ? null : "Could not save theme selection. Try again.");
  };
  const baseCardId = getThemeDefinition(theme)?.id ?? null;
  const lightOwner = themeHalves?.light ?? baseCardId;
  const darkOwner = themeHalves?.dark ?? baseCardId;
  const assignHalf = (appearance: ThemeAppearance, cardId: string | null): boolean => {
    const otherAppearance = appearance === "light" ? "dark" : "light";
    if (cardId === null && baseCardId !== null) {
      const previousHalves = readThemeHalves();
      const otherOwner = previousHalves?.[otherAppearance] ?? baseCardId;
      if (!setTheme(appearanceMode === "system" ? "system" : appearanceMode)) return false;
      if (!setThemeHalf(otherAppearance, otherOwner)) {
        setTheme(theme);
        if (previousHalves?.light) setThemeHalf("light", previousHalves.light);
        if (previousHalves?.dark) setThemeHalf("dark", previousHalves.dark);
        return false;
      }
      return true;
    }
    return setThemeHalf(appearance, cardId);
  };
  return (
    <SettingsSection
      id="theme"
      title="Themes"
      description="Choose a bundled theme, or assign separate light and dark variants."
    >
      <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
        {BUNDLED_THEME_CARDS.map((card) => {
          const cardId = card.id === "default" ? null : card.id;
          const activeModes: ThemeMode[] = [];
          if (lightOwner === cardId) activeModes.push("light");
          if (darkOwner === cardId) activeModes.push("dark");
          return (
            <ThemeLibraryCard
              key={card.id}
              theme={card}
              isActive={activeModes.length > 0}
              activeModes={activeModes}
              onUse={() =>
                save(() =>
                  setTheme(cardId ?? (appearanceMode === "system" ? "system" : appearanceMode)),
                )
              }
              onUseMode={(mode) => mode !== "system" && save(() => assignHalf(mode, cardId))}
            />
          );
        })}
      </div>
      {error ? (
        <p role="alert" className="px-4 pb-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </SettingsSection>
  );
}
