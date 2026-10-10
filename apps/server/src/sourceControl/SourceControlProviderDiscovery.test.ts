import { describe, expect, it } from "vite-plus/test";

import { firstSafeAuthLine } from "@t3tools/source-control-core/server/discovery";

describe("firstSafeAuthLine", () => {
  it("drops credential labels and GitLab token values anywhere in a line", () => {
    expect(firstSafeAuthLine("warning: token: glpat-secretvalue123\nsafe detail")).toBe(
      "safe detail",
    );
    expect(firstSafeAuthLine("warning included glpat-secretvalue123\nsafe detail")).toBe(
      "safe detail",
    );
  });
});
