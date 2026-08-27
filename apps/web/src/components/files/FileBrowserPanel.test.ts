// @vitest-environment happy-dom

import { describe, expect, it } from "vite-plus/test";

import { filePathFromTreeContextMenu } from "./FileBrowserPanel";

describe("filePathFromTreeContextMenu", () => {
  it("returns a project-relative file path from a tree row", () => {
    const row = document.createElement("button");
    row.dataset.itemPath = "docs/notes.txt";

    expect(
      filePathFromTreeContextMenu(
        [document.createElement("span"), row],
        new Map([["docs/notes.txt", "file"]]),
      ),
    ).toBe("docs/notes.txt");
  });

  it("ignores directory and non-row context menus", () => {
    const directory = document.createElement("button");
    directory.dataset.itemPath = "docs/";
    const entryKinds = new Map([["docs", "directory"]] as const);

    expect(filePathFromTreeContextMenu([directory], entryKinds)).toBeNull();
    expect(filePathFromTreeContextMenu([document.createElement("div")], entryKinds)).toBeNull();
  });
});
