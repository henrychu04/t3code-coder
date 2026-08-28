import { describe, expect, it } from "@effect/vitest";

import { matchesFileMask, parseFileMask } from "./fileMask.ts";

describe("matchesFileMask", () => {
  it("supports IntelliJ filename wildcards", () => {
    expect(matchesFileMask("src/components/App.tsx", "*.tsx")).toBe(true);
    expect(matchesFileMask("src/testAB.js", "test??.*")).toBe(true);
    expect(matchesFileMask("src/testA.js", "test??.*")).toBe(false);
    expect(matchesFileMask("src/components/App.tsx", "src/**/*.tsx")).toBe(false);
  });

  it("accepts comma-separated masks and whole-pattern exclusions", () => {
    expect(matchesFileMask("src/App.tsx", "*.ts, *.tsx")).toBe(true);
    expect(matchesFileMask("src/App.test.tsx", "*.tsx,!*.test.tsx")).toBe(false);
    expect(matchesFileMask("src/App.tsx", "!*.test.tsx")).toBe(true);
    expect(parseFileMask("*.ts, *.tsx, !*.test.ts")).toEqual({
      includes: ["*.ts", "*.tsx"],
      excludes: ["*.test.ts"],
    });
  });

  it("treats a blank mask as unrestricted", () => {
    expect(matchesFileMask("src/App.tsx", "  ")).toBe(true);
  });
});
