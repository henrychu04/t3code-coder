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

it("uses repository defaults between explicit overrides and workspace defaults", () => {
  expect(
    resolveDefaultThreadEnvMode({
      projectSetting: undefined,
      repositoryDefault: "worktree",
      globalDefault: "local",
    }),
  ).toBe("worktree");
  expect(
    resolveDefaultThreadEnvMode({
      projectSetting: "local",
      repositoryDefault: "worktree",
      globalDefault: "worktree",
    }),
  ).toBe("local");
  expect(
    resolveDefaultThreadEnvMode({
      projectSetting: undefined,
      repositoryDefault: undefined,
      globalDefault: "local",
    }),
  ).toBe("local");
});
