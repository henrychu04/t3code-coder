import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment } from "../../state/server";
import { useEffect, useRef, useState } from "react";
import * as Equal from "effect/Equal";
import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  type ClientSettings,
  type ServerSettings,
  type UnifiedSettings,
  type EnvironmentId,
} from "@t3tools/contracts";
import { ensureLocalApi } from "../../localApi";
import { getClientSettings, useClientSettings, saveClientSettings } from "../../hooks/useSettings";
import {
  useTheme,
  readThemePreference,
  readThemeHalves,
  readAppearanceModePreference,
} from "../../hooks/useTheme";
import { Button } from "../ui/button";
import { SettingsRow } from "./SettingsPage";

export const CLIENT_RESET_LABELS = {
  appearanceContrast: "Contrast",
  glassOpacity: "Glass opacity",
  environmentIdentificationMode: "Environment identification",
  timestampFormat: "Time format",
  diffLayout: "Diff layout",
  diffIgnoreWhitespace: "Diff whitespace changes",
  wordWrap: "Word wrap",
  proactivePanelsEnabled: "Proactive panels",
  showSkillsInSlashMenu: "Skills in slash menu",
  panelAnimationDurationMs: "Panel animations",
  sidebarProjectGroupingMode: "Project grouping",
  sidebarProjectSortOrder: "Project order",
  sidebarThreadSortOrder: "Thread order",
  sidebarThreadPreviewCount: "Visible threads",
  composerCollapseOnBlur: "Collapse composer when unfocused",
  composerCollapseOnScroll: "Collapse composer on scroll",
  confirmThreadUnpin: "Unpin confirmation",
  confirmThreadArchive: "Archive confirmation",
  confirmThreadDelete: "Delete confirmation",
  fontFamilySans: "Interface font",
  fontSizeInterface: "Interface font size",
  fontFamilyComposer: "Prompt font",
  fontSizePrompt: "Prompt font size",
  fontFamilyCode: "Code font",
  fontSizeCode: "Code font size",
  fontFamilyTerminal: "Terminal font",
  fontSizeTerminal: "Terminal font size",
  fontSmoothing: "Font smoothing",
} satisfies Partial<Record<keyof ClientSettings, string>>;
export const WORKSPACE_RESET_LABELS = {
  defaultThreadEnvMode: "Default checkout mode",
  newWorktreesStartFromOrigin: "Start worktrees from origin",
  sidebarAutoSettleAfterDays: "Auto-settle inactive threads",
  sidebarAutoSettleOnMerge: "Auto-settle merged threads",
  textGenerationModelSelection: "Text generation model",
  automaticGitFetchInterval: "Git fetch interval",
  sourceControlWritingStyle: "Source control writing style",
  sourceControlWriterModelSelection: "Source control writer model",
} satisfies Partial<Record<keyof ServerSettings, string>>;

export function changedSettings<T extends object>(
  current: T,
  defaults: T,
  labels: Partial<Record<keyof T, string>>,
) {
  return (Object.keys(labels) as Array<keyof T>).filter(
    (key) => !Equal.equals(current[key], defaults[key]),
  );
}

export function RestoreClientSettings() {
  const settings = useClientSettings();
  const {
    theme,
    themeHalves,
    appearanceMode,
    setTheme,
    setAppearanceMode,
    setThemeHalf,
    clearThemeHalves,
  } = useTheme();
  const [error, setError] = useState<string | null>(null);
  const keys = changedSettings(settings, DEFAULT_CLIENT_SETTINGS, CLIENT_RESET_LABELS);
  const themeChanged = theme !== "system" || themeHalves !== null || appearanceMode !== "system";
  return (
    <SettingsRow
      id="restore-client-defaults"
      title="Restore browser preferences"
      description="Reset appearance and interface preferences for this browser."
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={!keys.length && !themeChanged}
          onClick={async () => {
            const names = keys.map(
              (key) => CLIENT_RESET_LABELS[key as keyof typeof CLIENT_RESET_LABELS],
            );
            if (themeChanged) names.push("Theme");
            if (
              !(await ensureLocalApi().dialogs.confirm(
                `Restore default settings?\nThis will reset: ${names.join(", ")}.`,
                { variant: "destructive" },
              ))
            )
              return;
            setError(null);
            // Re-read after confirmation so rollback preserves the current theme and mix.
            let previousTheme = theme;
            try {
              previousTheme = readThemePreference();
            } catch {
              /* Use the rendered fallback. */
            }
            const previousHalves = readThemeHalves();
            const previousMode = readAppearanceModePreference(previousTheme);
            const needsThemeReset = previousTheme !== "system";
            const needsMixReset = previousHalves !== null;
            const needsModeReset = previousMode !== "system";
            const rollbackTheme = () => {
              if (needsThemeReset) setTheme(previousTheme);
              if (previousHalves?.light) setThemeHalf("light", previousHalves.light);
              if (previousHalves?.dark) setThemeHalf("dark", previousHalves.dark);
            };
            if (themeChanged) {
              if (needsThemeReset && !setTheme("system")) {
                setError("Could not restore theme settings. Try again.");
                return;
              }
              if (
                (needsMixReset && !clearThemeHalves()) ||
                (needsModeReset && !setAppearanceMode("system"))
              ) {
                rollbackTheme();
                setError("Could not restore theme settings. Try again.");
                return;
              }
            }
            // Only reset the fields listed in this confirmation; unrelated edits made meanwhile survive.
            const live = getClientSettings();
            const patch = Object.fromEntries(
              keys
                .filter((key) => !Equal.equals(live[key], DEFAULT_CLIENT_SETTINGS[key]))
                .map((key) => [key, DEFAULT_CLIENT_SETTINGS[key]]),
            );
            try {
              await saveClientSettings({ ...live, ...patch });
            } catch {
              setError("Could not save restored preferences. Try again.");
              return;
            }
          }}
        >
          Restore defaults
        </Button>
      }
    >
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </SettingsRow>
  );
}

export function RestoreWorkspaceSettings({
  environmentId,
  settings,
}: {
  environmentId: EnvironmentId;
  settings: UnifiedSettings;
}) {
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const keys = changedSettings<ServerSettings>(
    settings,
    DEFAULT_SERVER_SETTINGS,
    WORKSPACE_RESET_LABELS,
  );
  return (
    <SettingsRow
      id="restore-workspace-defaults"
      title="Restore workspace preferences"
      description="Reset general and source control preferences in the selected Coder workspace."
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={!keys.length}
          onClick={async () => {
            const names = keys.map(
              (key) => WORKSPACE_RESET_LABELS[key as keyof typeof WORKSPACE_RESET_LABELS],
            );
            if (
              !(await ensureLocalApi().dialogs.confirm(
                `Restore this workspace's default settings?\nThis will reset: ${names.join(", ")}.`,
                { variant: "destructive" },
              )) ||
              !mounted.current
            )
              return;
            const result = await update({
              environmentId,
              input: {
                patch: Object.fromEntries(keys.map((key) => [key, DEFAULT_SERVER_SETTINGS[key]])),
              },
            });
            if (mounted.current)
              setError(
                result._tag === "Failure"
                  ? "Could not restore workspace preferences. Try again."
                  : null,
              );
          }}
        >
          Restore defaults
        </Button>
      }
    >
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </SettingsRow>
  );
}
