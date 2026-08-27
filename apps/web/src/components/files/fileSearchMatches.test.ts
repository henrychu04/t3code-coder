import { expect, it } from "vite-plus/test";

import { getFileSearchMatches } from "./fileSearchMatches";

it("preserves index ordering and computes fuzzy highlight positions", () => {
  expect(
    getFileSearchMatches(
      [
        { kind: "file", path: "src/TestFlags.tsx" },
        { kind: "file", path: "src/SubtestFlow.tsx" },
      ],
      "tsfl",
    ),
  ).toEqual([
    {
      name: "TestFlags.tsx",
      nameMatchIndices: [0, 2, 4, 5],
      path: "src/TestFlags.tsx",
      pathMatchIndices: [4, 6, 8, 9],
    },
    {
      name: "SubtestFlow.tsx",
      nameMatchIndices: [3, 5, 7, 8],
      path: "src/SubtestFlow.tsx",
      pathMatchIndices: [7, 9, 11, 12],
    },
  ]);
});
