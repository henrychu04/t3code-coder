// @vitest-environment happy-dom

import { describe, expect, it } from "vite-plus/test";

import { contextMenuFilePath } from "./FileBrowserPanel";

describe("contextMenuFilePath", () => {
  const entryKinds = new Map([
    ["docs", "directory"],
    ["docs/notes.txt", "file"],
  ] as const);

  it("returns only a loaded project-relative file path", () => {
    expect(contextMenuFilePath({ kind: "file", path: "docs/notes.txt" }, entryKinds)).toBe(
      "docs/notes.txt",
    );
  });

  it.each(["/etc/passwd", "../secret.txt", "docs\\notes.txt", "missing.txt", "docs"])(
    "rejects an unsafe or non-file path: %s",
    (path) => {
      expect(contextMenuFilePath({ kind: "file", path }, entryKinds)).toBeNull();
    },
  );

  it("rejects a directory item", () => {
    expect(contextMenuFilePath({ kind: "directory", path: "docs/" }, entryKinds)).toBeNull();
  });
});
