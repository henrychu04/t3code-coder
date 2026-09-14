import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { foldLegacyProjectSettings } from "./serverSettings.ts";
import { projectSettingsCommandPatch } from "./projectSettingsCommand.ts";

const id = ProjectId.make("migration-project");
const model = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4");
const scripts = [
  {
    id: "setup",
    name: "Setup",
    command: "pnpm install",
    icon: "play" as const,
    runOnWorktreeCreate: true,
  },
];
const row = {
  projectId: id,
  defaultModelSelection: JSON.stringify(model),
  defaultThreadEnvMode: "worktree",
  autoPull: 1,
  scripts: JSON.stringify(scripts),
};

describe("Coder project settings migration", () => {
  it("folds existing project values once, preserving explicit false and empty overrides", () => {
    const folded = foldLegacyProjectSettings(
      {
        ...DEFAULT_SERVER_SETTINGS,
        projectAutoPullOverrides: { [id]: false },
        projectScriptOverrides: { [id]: [] },
      },
      [row],
    );
    expect(folded.projectSettingsFolded).toBe(true);
    expect(folded.projectSettingsOverrides[id]).toEqual({
      defaultModelSelection: model,
      defaultThreadEnvMode: "worktree",
      defaultAutoPull: false,
      defaultProjectScripts: [],
    });
    const reset = applyServerSettingsPatch(folded, { projectSettingsOverrides: { [id]: null } });
    const reloaded = foldLegacyProjectSettings(reset, [row]);
    expect(reloaded.projectSettingsOverrides).toEqual({});
    expect(
      resolveProjectSettings(reloaded, id, {
        defaultModelSelection: model,
        defaultThreadEnvMode: "worktree",
      }).settings.defaultModelSelection,
    ).toBe(DEFAULT_SERVER_SETTINGS.defaultModelSelection);
  });
  it("preserves legacy script resets and explicit canonical values", () => {
    const folded = foldLegacyProjectSettings(
      {
        ...DEFAULT_SERVER_SETTINGS,
        projectScriptOverrides: { [id]: null },
        projectSettingsOverrides: { [id]: { defaultThreadEnvMode: "local" } },
      },
      [row],
    );
    expect(folded.projectSettingsOverrides[id]?.defaultProjectScripts).toBeUndefined();
    expect(folded.projectSettingsOverrides[id]?.defaultThreadEnvMode).toBe("local");
  });
  it("marks a fresh workspace folded before projects can acquire and reset overrides", () => {
    expect(foldLegacyProjectSettings(DEFAULT_SERVER_SETTINGS, []).projectSettingsFolded).toBe(true);
  });
  it("keeps retained project edits compatible without pinning unrelated settings", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [id]: { responseStreamingMode: "token" as const, defaultModelSelection: model },
      },
    };
    const command = {
      type: "project.meta.update" as const,
      projectId: id,
      commandId: CommandId.make("edit-project"),
    };
    expect(projectSettingsCommandPatch(settings, { ...command, title: "Renamed" })).toBeNull();
    const patch = projectSettingsCommandPatch(settings, {
      ...command,
      defaultModelSelection: null,
      scripts: [],
    });
    expect(patch).toEqual({
      projectSettingsOverrides: {
        [id]: { responseStreamingMode: "token", defaultProjectScripts: [] },
      },
    });
  });
});
