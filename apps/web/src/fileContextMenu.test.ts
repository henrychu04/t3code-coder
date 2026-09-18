import { resolveComposerFileTarget } from "./fileContextMenu";
import { describe, expect, it } from "vite-plus/test";
import { buildFileContextMenuItems, resolveFileContextMenuRelativePath } from "./fileContextMenu";

const target = {
  environmentId: null,
  workspaceRoot: "/workspace/project",
  filePath: "src/main.ts",
};
describe("Coder file context menus", () => {
  it("copies only a project-relative path", () => {
    expect(resolveFileContextMenuRelativePath(target)).toBe("src/main.ts");
    expect(buildFileContextMenuItems(target)).toEqual([
      { id: "copy-path", label: "Copy path", icon: "copy" },
    ]);
  });
  it("opens validated project files in the existing Files surface", () => {
    expect(buildFileContextMenuItems(target, true).map((item) => item.id)).toEqual([
      "open",
      "copy-path",
    ]);
    expect(buildFileContextMenuItems({ ...target, filePath: "../secret" }, true)).toEqual([]);
  });
  it.each([
    "../secret",
    "/etc/passwd",
    "src/../../secret",
    "src\\secret",
    "a\0b",
    "C:/secret",
    "./src",
    "a//b",
  ])("rejects unsafe paths: %s", (filePath) => {
    expect(buildFileContextMenuItems({ ...target, filePath })).toEqual([]);
  });
  it("rejects repository paths outside the project", () => {
    expect(
      resolveFileContextMenuRelativePath({ ...target, repositoryRoot: "/workspace" }),
    ).toBeNull();
    expect(
      resolveFileContextMenuRelativePath({
        ...target,
        repositoryRoot: "/workspace/project/nested",
      }),
    ).toBe("nested/src/main.ts");
  });
});

describe("composer file targets", () => {
  it.each(["Makefile", "folder/雪 #1.txt", "./src/main.ts", "/workspace/project/src/main.ts"])(
    "opens contained paths: %s",
    (path) => {
      expect(resolveComposerFileTarget(path, "/workspace/project")).not.toBeNull();
    },
  );
  it.each([
    "../secret",
    "/workspace/project-other/secret",
    "/etc/passwd",
    "https://example.com/file",
    "src/../../secret",
    "a\\b",
    "a\0b",
  ])("rejects unsafe targets: %s", (path) => {
    expect(resolveComposerFileTarget(path, "/workspace/project")).toBeNull();
  });
  it("retains the referenced line", () => {
    expect(resolveComposerFileTarget("src/main.ts:42", "/workspace/project")).toEqual({
      relativePath: "src/main.ts",
      line: 42,
    });
  });
});
