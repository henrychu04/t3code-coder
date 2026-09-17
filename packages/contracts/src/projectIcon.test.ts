import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ProjectIconOverride } from "./orchestration.ts";
const decode = Schema.decodeUnknownSync(ProjectIconOverride);
it("accepts upstream Lucide names, expanded colors and emoji", () => {
  expect(decode({ kind: "lucide", name: "rocket", color: "fuchsia" })).toEqual({
    kind: "lucide",
    name: "rocket",
    color: "fuchsia",
  });
  expect(decode({ kind: "emoji", emoji: "🚀" })).toEqual({ kind: "emoji", emoji: "🚀" });
});
it("rejects paths, URLs, arbitrary colors and oversized values", () => {
  for (const name of ["../icon", "/tmp/icon", "https://example.com/icon", "a".repeat(65)]) {
    expect(() => decode({ kind: "lucide", name, color: "blue" })).toThrow();
  }
  expect(() => decode({ kind: "lucide", name: "rocket", color: "url(remote)" })).toThrow();
  expect(() => decode({ kind: "emoji", emoji: "a".repeat(33) })).toThrow();
});
