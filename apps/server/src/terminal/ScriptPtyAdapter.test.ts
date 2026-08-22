import { describe, expect, it } from "vite-plus/test";

import { buildScriptCommand } from "./ScriptPtyAdapter.ts";

describe("ScriptPtyAdapter", () => {
  it("separates terminal sizing from the shell exec command", () => {
    expect(
      buildScriptCommand({
        shell: "/bin/bash",
        args: ["-l", "it's-safe"],
        cols: 120,
        rows: 40,
      }),
    ).toBe(`stty cols 120 rows 40; exec '/bin/bash' '-l' 'it'"'"'s-safe'`);
  });
});
