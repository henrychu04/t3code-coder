import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness } from "../test/reactHookHarness";
import { removeLocalStorageItem, setLocalStorageItem } from "./useLocalStorage";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

import { useResizableWidth } from "./useResizableWidth";

describe("useResizableWidth", () => {
  beforeEach(() => {
    reactHookHarness.reset();
    removeLocalStorageItem("panel-width");
  });

  afterEach(() => {
    removeLocalStorageItem("panel-width");
    vi.unstubAllGlobals();
  });

  it("tracks a changed default until the user chooses a width", () => {
    reactHookHarness.beginRender();
    const initial = useResizableWidth({
      storageKey: "panel-width",
      defaultWidth: 576,
      minWidth: 320,
      maxWidth: 840,
      edge: "left",
    });

    reactHookHarness.beginRender();
    const measured = useResizableWidth({
      storageKey: "panel-width",
      defaultWidth: 384,
      minWidth: 320,
      maxWidth: 440,
      edge: "left",
    });

    expect(initial.width).toBe(576);
    expect(measured.width).toBe(384);
  });

  it("preserves a saved width when the default changes", () => {
    setLocalStorageItem("panel-width", 400, Schema.Finite);
    vi.stubGlobal("window", {});

    reactHookHarness.beginRender();
    const initial = useResizableWidth({
      storageKey: "panel-width",
      defaultWidth: 576,
      minWidth: 320,
      maxWidth: 840,
      edge: "left",
    });

    reactHookHarness.beginRender();
    const measured = useResizableWidth({
      storageKey: "panel-width",
      defaultWidth: 384,
      minWidth: 320,
      maxWidth: 440,
      edge: "left",
    });

    expect(initial.width).toBe(400);
    expect(measured.width).toBe(400);
  });
});
