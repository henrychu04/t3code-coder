import { describe, expect, it } from "vite-plus/test";
import * as Duration from "effect/Duration";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";

import { createModelSelection } from "./model.ts";
import {
  applyServerSettingsPatch,
  resolveSourceControlWriterModelSelection,
} from "./serverSettings.ts";

describe("source control server settings", () => {
  it("treats fetch durations as atomic values", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      automaticGitFetchInterval: Duration.seconds(45),
    });
    expect(Duration.toMillis(next.automaticGitFetchInterval)).toBe(45_000);
  });

  it("uses an enabled dedicated writer model and falls back when disabled", () => {
    const selection = createModelSelection(ProviderInstanceId.make("writer"), "claude-opus-4-1");
    const enabled = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        writer: { driver: "claudeAgent", enabled: true, config: {} },
      },
      sourceControlWriterModelSelection: selection,
    };
    expect(resolveSourceControlWriterModelSelection(enabled)).toBe(selection);
    expect(
      resolveSourceControlWriterModelSelection({
        ...enabled,
        providerInstances: {
          writer: { driver: "claudeAgent", enabled: false, config: {} },
        },
      }),
    ).toBe(DEFAULT_SERVER_SETTINGS.textGenerationModelSelection);
  });
});
