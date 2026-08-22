import { describe, expect, it } from "vite-plus/test";

import { resolveDefaultThreadEnvMode } from "./threadEnvMode.ts";

describe("resolveDefaultThreadEnvMode", () => {
  it("prefers the project setting over the global default", () => {
    expect(
      resolveDefaultThreadEnvMode({
        projectSetting: "local",
        globalDefault: "worktree",
      }),
    ).toBe("local");
    expect(
      resolveDefaultThreadEnvMode({
        projectSetting: null,
        globalDefault: "worktree",
      }),
    ).toBe("worktree");
  });
});
