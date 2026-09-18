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
