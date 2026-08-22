// @effect-diagnostics nodeBuiltinImport:off
import { strictEqual } from "node:assert";
import { describe, it } from "node:test";

import { resolveCoderConfigPath } from "./configPath.ts";

describe("Coder profile config path", () => {
  it("uses Application Support on macOS", () => {
    strictEqual(
      resolveCoderConfigPath({
        platform: "darwin",
        homeDirectory: "/Users/henry",
      }),
      "/Users/henry/Library/Application Support/t3-coder/config.json",
    );
  });

  it("uses APPDATA on Windows 11", () => {
    strictEqual(
      resolveCoderConfigPath({
        platform: "win32",
        homeDirectory: String.raw`C:\Users\henry`,
        environment: { APPDATA: String.raw`C:\Users\henry\AppData\Roaming` },
      }),
      String.raw`C:\Users\henry\AppData\Roaming\t3-coder\config.json`,
    );
  });

  it("falls back to the Windows roaming profile path", () => {
    strictEqual(
      resolveCoderConfigPath({
        platform: "win32",
        homeDirectory: String.raw`C:\Users\henry`,
      }),
      String.raw`C:\Users\henry\AppData\Roaming\t3-coder\config.json`,
    );
  });
});
