import * as Duration from "effect/Duration";
import { describe, expect, it } from "vite-plus/test";

import { deepMerge } from "./Struct.ts";

describe("deepMerge", () => {
  it("recursively merges plain records", () => {
    expect(deepMerge({ nested: { first: 1, second: 2 } }, { nested: { second: 3 } })).toEqual({
      nested: { first: 1, second: 3 },
    });
  });

  it("replaces Duration values atomically", () => {
    const merged = deepMerge({ interval: Duration.seconds(30) }, { interval: Duration.seconds(5) });

    expect(Duration.toMillis(merged.interval)).toBe(5_000);
  });
});
