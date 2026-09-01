import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ClaudeSettings,
  ClientSettingsSchema,
  ClientSettingsPatch,
  ServerSettingsPatch,
} from "./settings.ts";

const decodeClaudeSettings = Schema.decodeUnknownSync(ClaudeSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);

describe("Client settings", () => {
  it("keeps unpin confirmation opt-in and patchable", () => {
    expect(decodeClientSettings({}).confirmThreadUnpin).toBe(false);
    expect(decodeClientSettingsPatch({ confirmThreadUnpin: true }).confirmThreadUnpin).toBe(true);
    expect(() => decodeClientSettingsPatch({ confirmThreadUnpin: "yes" })).toThrow();
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
