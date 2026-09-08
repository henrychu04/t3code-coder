import { describe, expect, it } from "vite-plus/test";
import * as Duration from "effect/Duration";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

import { createModelSelection } from "./model.ts";
import { resolveProjectScripts, projectScriptsInheritDefaults } from "./projectScripts.ts";
import {
  applyServerSettingsPatch,
  resolveCoderTextGenerationModelSelection,
  resolveSourceControlWriterModelSelection,
  resolveProjectAutoPull,
} from "./serverSettings.ts";

const providerSnapshot = (input: {
  readonly instanceId: "codex" | "claudeAgent";
  readonly status?: ServerProvider["status"];
  readonly models: ReadonlyArray<{ readonly slug: string; readonly isDefault?: boolean }>;
}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(input.instanceId),
  driver: ProviderDriverKind.make(input.instanceId),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: input.status ?? "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-02T00:00:00.000Z",
  models: input.models.map((model) => ({
    slug: model.slug,
    name: model.slug,
    isCustom: false,
    ...(model.isDefault ? { isDefault: true } : {}),
    capabilities: null,
  })),
  slashCommands: [],
  skills: [],
});

describe("source control server settings", () => {
  it("treats fetch durations as atomic values", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      automaticGitFetchInterval: Duration.seconds(45),
    });
    expect(Duration.toMillis(next.automaticGitFetchInterval)).toBe(45_000);
  });

  it("uses an enabled dedicated writer model and falls back when disabled", () => {
    const writerId = ProviderInstanceId.make("writer");
    const writerDriver = ProviderDriverKind.make("claudeAgent");
    const selection = createModelSelection(writerId, "claude-opus-4-1");
    const enabled = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [writerId]: { driver: writerDriver, enabled: true, config: {} },
      },
      sourceControlWriterModelSelection: selection,
    };
    expect(resolveSourceControlWriterModelSelection(enabled)).toBe(selection);
    expect(
      resolveSourceControlWriterModelSelection({
        ...enabled,
        providerInstances: {
          [writerId]: { driver: writerDriver, enabled: false, config: {} },
        },
      }),
    ).toBe(DEFAULT_SERVER_SETTINGS.textGenerationModelSelection);
  });
});

describe("generated-name model selection", () => {
  const codex = providerSnapshot({
    instanceId: "codex",
    models: [{ slug: "gpt-5.6-luna", isDefault: true }],
  });
  const claude = providerSnapshot({
    instanceId: "claudeAgent",
    models: [{ slug: "claude-sonnet-4-6", isDefault: true }],
  });

  it("keeps a selected live provider and model", () => {
    const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.6-luna", [
      { id: "reasoningEffort", value: "high" },
    ]);
    expect(resolveCoderTextGenerationModelSelection(selection, [codex, claude])).toBe(selection);
  });

  it("falls back to the first ready provider and its default model", () => {
    const unavailableClaude = { ...claude, status: "error" as const };
    expect(
      resolveCoderTextGenerationModelSelection(
        createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-sonnet-4-6"),
        [unavailableClaude, codex],
      ),
    ).toEqual(createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.6-luna"));
  });

  it("falls back to the selected provider's default when its model is stale", () => {
    expect(
      resolveCoderTextGenerationModelSelection(
        createModelSelection(ProviderInstanceId.make("codex"), "retired-model"),
        [codex, claude],
      ),
    ).toEqual(createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.6-luna"));
  });
});

describe("workspace project defaults", () => {
  const id = ProjectId.make("project-defaults");
  const script = {
    id: "setup",
    name: "Setup",
    command: "pnpm install",
    icon: "play" as const,
    runOnWorktreeCreate: true,
  };
  it("preserves explicit false and resets automatic pull to the workspace default", () => {
    const defaults = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      defaultAutoPull: true,
      projectAutoPullOverrides: { [id]: false },
    });
    expect(resolveProjectAutoPull(defaults, id, true)).toBe(false);
    const reset = applyServerSettingsPatch(defaults, { projectAutoPullOverrides: { [id]: null } });
    expect(reset.projectAutoPullOverrides[id]).toBeUndefined();
    expect(resolveProjectAutoPull(reset, id, false)).toBe(true);
  });
  it("preserves existing scripts and distinguishes empty overrides from inheritance", () => {
    const defaults = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      defaultProjectScripts: [script],
    });
    const existing = { id, scripts: [{ ...script, id: "existing", command: "custom" }] };
    expect(resolveProjectScripts(defaults, existing)).toEqual(existing.scripts);
    const cleared = applyServerSettingsPatch(defaults, { projectScriptOverrides: { [id]: [] } });
    expect(resolveProjectScripts(cleared, existing)).toEqual([]);
    expect(projectScriptsInheritDefaults(cleared, existing)).toBe(false);
    const reset = applyServerSettingsPatch(cleared, { projectScriptOverrides: { [id]: null } });
    expect(resolveProjectScripts(reset, existing)).toEqual([script]);
    expect(projectScriptsInheritDefaults(reset, existing)).toBe(true);
  });
  it("replaces default model options and preserves unrelated project overrides", () => {
    const initial = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      defaultModelSelection: createModelSelection(ProviderInstanceId.make("codex"), "first", [
        { id: "reasoningEffort", value: "high" },
      ]),
      projectAutoPullOverrides: { [id]: false },
    });
    const next = applyServerSettingsPatch(initial, {
      defaultModelSelection: createModelSelection(ProviderInstanceId.make("claudeAgent"), "second"),
    });
    expect(next.defaultModelSelection?.options).toBeUndefined();
    expect(next.projectAutoPullOverrides[id]).toBe(false);
  });
});
