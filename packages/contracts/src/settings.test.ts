import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ClaudeSettings,
  ClientSettingsSchema,
  ClientSettingsPatch,
  CodexSettings,
  DEFAULT_SERVER_SETTINGS,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";

const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);

describe("Client settings", () => {
  it("keeps unpin confirmation opt-in and patchable", () => {
    expect(decodeClientSettings({}).confirmThreadUnpin).toBe(false);
    expect(decodeClientSettingsPatch({ confirmThreadUnpin: true }).confirmThreadUnpin).toBe(true);
    expect(() => decodeClientSettingsPatch({ confirmThreadUnpin: "yes" })).toThrow();
  });

  it("defaults workspace provider preferences and decodes scoped values", () => {
    expect(decodeClientSettings({}).providerPreferencesByEnvironment).toEqual({});

    const providerPreferencesByEnvironment = {
      "workspace-a": {
        favorites: [{ provider: "codex", model: "gpt-5.6-sol" }],
        providerModelPreferences: {
          codex: { hiddenModels: ["gpt-5.4"], modelOrder: ["gpt-5.6-sol"] },
        },
      },
    };
    expect(
      decodeClientSettings({ providerPreferencesByEnvironment }).providerPreferencesByEnvironment,
    ).toEqual(providerPreferencesByEnvironment);
    expect(
      decodeClientSettingsPatch({ providerPreferencesByEnvironment })
        .providerPreferencesByEnvironment,
    ).toEqual(providerPreferencesByEnvironment);
  });
});

describe("Codex settings", () => {
  it("uses Codex for title and branch generation by default", () => {
    expect(DEFAULT_SERVER_SETTINGS.textGenerationModelSelection).toEqual({
      instanceId: "codex",
      model: "gpt-5.6-luna",
      options: [{ id: "reasoningEffort", value: "low" }],
    });
  });

  it("defaults to the workspace Codex executable", () => {
    expect(decodeCodexSettings({})).toEqual({
      enabled: true,
      binaryPath: "codex",
      homePath: "",
      shadowHomePath: "",
      launchArgs: "",
      customModels: [],
    });
  });

  it("accepts workspace paths and launch arguments in settings patches", () => {
    const patch = decodeServerSettingsPatch({
      providers: {
        codex: {
          binaryPath: "/opt/codex/bin/codex",
          homePath: "~/.codex",
          shadowHomePath: "~/.codex-t3/work",
          launchArgs: "--config model_reasoning_effort=high",
        },
      },
    });

    expect(patch.providers?.codex).toEqual({
      binaryPath: "/opt/codex/bin/codex",
      homePath: "~/.codex",
      shadowHomePath: "~/.codex-t3/work",
      launchArgs: "--config model_reasoning_effort=high",
    });
  });
});

describe("ServerSettings thread settlement", () => {
  it("defaults merge settlement on and inactivity settlement to three days", () => {
    const settings = decodeServerSettings({});
    expect(settings.sidebarAutoSettleAfterDays).toBe(3);
    expect(settings.sidebarAutoSettleOnMerge).toBe(true);
  });

  it("allows both automatic rules to be disabled", () => {
    expect(
      decodeServerSettings({
        sidebarAutoSettleAfterDays: null,
        sidebarAutoSettleOnMerge: false,
      }),
    ).toMatchObject({ sidebarAutoSettleAfterDays: null, sidebarAutoSettleOnMerge: false });
    expect(
      decodeServerSettingsPatch({
        sidebarAutoSettleAfterDays: null,
        sidebarAutoSettleOnMerge: false,
      }),
    ).toMatchObject({ sidebarAutoSettleAfterDays: null, sidebarAutoSettleOnMerge: false });
  });

  it.each([-1, 0, 91])("rejects an auto-settle threshold outside 1..90: %s", (value) => {
    expect(() => decodeServerSettings({ sidebarAutoSettleAfterDays: value })).toThrow();
    expect(() => decodeServerSettingsPatch({ sidebarAutoSettleAfterDays: value })).toThrow();
  });
});

describe("source control settings", () => {
  it("defaults legacy settings and accepts partial writing-style patches", () => {
    const settings = decodeServerSettings({});
    expect(settings.sourceControlWritingStyle).toEqual({
      mode: "repo_conventions",
      customInstructions: "",
      followChangeRequestTemplates: true,
    });
    expect(settings.sourceControlWriterModelSelection).toBeNull();

    expect(
      decodeServerSettingsPatch({
        sourceControlWritingStyle: {
          mode: "custom",
          customInstructions: "  Prefer concise wording.  ",
        },
      }).sourceControlWritingStyle,
    ).toEqual({ mode: "custom", customInstructions: "Prefer concise wording." });
  });
});

describe("Claude auto-compaction settings", () => {
  it("accepts disabled, lower-bound, and upper-bound values", () => {
    expect(decodeClaudeSettings({}).autoCompactWindow).toBe("");
    expect(decodeClaudeSettings({ autoCompactWindow: "100000" }).autoCompactWindow).toBe("100000");
    expect(decodeClaudeSettings({ autoCompactWindow: "1000000" }).autoCompactWindow).toBe(
      "1000000",
    );
    expect(
      decodeServerSettingsPatch({
        providers: { claudeAgent: { autoCompactWindow: "160000" } },
      }).providers?.claudeAgent?.autoCompactWindow,
    ).toBe("160000");
  });

  it.each(["99999", "1000001", "0160000", "160000.5", "-160000", "abc"])(
    "rejects invalid value %s",
    (autoCompactWindow) => {
      expect(() => decodeClaudeSettings({ autoCompactWindow })).toThrow();
      expect(() =>
        decodeServerSettingsPatch({
          providers: { claudeAgent: { autoCompactWindow } },
        }),
      ).toThrow();
    },
  );
});
