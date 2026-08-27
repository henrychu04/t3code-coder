import { describe, expect, it } from "@effect/vitest";

import { matchesFileMask } from "./fileMask.ts";

describe("matchesFileMask", () => {
  it("supports filename and project-relative glob masks", () => {
    expect(matchesFileMask("src/components/App.tsx", "*.tsx")).toBe(true);
    expect(matchesFileMask("src/components/App.tsx", "src/**/*.tsx")).toBe(true);
    expect(matchesFileMask("test/App.tsx", "src/**/*.tsx")).toBe(false);
  });

  it("accepts comma- or semicolon-separated masks", () => {
    expect(matchesFileMask("src/App.tsx", "*.ts, *.tsx")).toBe(true);
    expect(matchesFileMask("README.md", "*.ts;*.tsx")).toBe(false);
  });

  it("treats a blank mask as unrestricted", () => {
    expect(matchesFileMask("src/App.tsx", "  ")).toBe(true);
  });
});
