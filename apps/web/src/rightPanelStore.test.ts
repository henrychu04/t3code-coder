import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useRightPanelStore } from "./rightPanelStore";

const threadRef = scopeThreadRef(
  EnvironmentId.make("test-environment"),
  ThreadId.make("test-thread"),
);

describe("rightPanelStore files", () => {
  beforeEach(() => useRightPanelStore.setState({ byThreadKey: {} }));

  it("replaces the standalone explorer with file tabs and reuses an open file", () => {
    const store = useRightPanelStore.getState();
    store.open(threadRef, "files");
    store.openFile(threadRef, "src/index.ts", 12);
    store.openFile(threadRef, "README.md");
    store.openFile(threadRef, "src/index.ts", 20);

    const state = Object.values(useRightPanelStore.getState().byThreadKey)[0]!;
    expect(state.surfaces.map((surface) => surface.id)).toEqual([
      "file:src/index.ts",
      "file:README.md",
    ]);
    expect(state.activeSurfaceId).toBe("file:src/index.ts");
    expect(state.surfaces[0]).toMatchObject({
      relativePath: "src/index.ts",
      revealLine: 20,
      revealRequestId: 2,
    });
  });
});
