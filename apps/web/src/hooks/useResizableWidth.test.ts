import * as Schema from "effect/Schema";
import { act, createElement, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { removeLocalStorageItem, setLocalStorageItem } from "./useLocalStorage";
import { useResizableWidth, type UseResizableWidthOptions } from "./useResizableWidth";

let renderer: ReactTestRenderer | undefined;
let width: number;

function Panel(options: UseResizableWidthOptions) {
  const result = useResizableWidth(options);
  useLayoutEffect(() => {
    width = result.width;
  });
  return null;
}

const initialOptions: UseResizableWidthOptions = {
  storageKey: "panel-width",
  defaultWidth: 576,
  minWidth: 320,
  maxWidth: 840,
  edge: "left",
};
const measuredOptions = { ...initialOptions, defaultWidth: 384, maxWidth: 440 };

describe("useResizableWidth", () => {
  beforeEach(() => {
    removeLocalStorageItem("panel-width");
    const events = new EventTarget();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", {
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    });
  });

  afterEach(async () => {
    await act(() => renderer?.unmount());
    renderer = undefined;
    removeLocalStorageItem("panel-width");
    vi.unstubAllGlobals();
  });

  it("tracks a changed default until the user chooses a width", async () => {
    await act(() => {
      renderer = create(createElement(Panel, initialOptions));
    });
    expect(width).toBe(576);

    await act(() => renderer!.update(createElement(Panel, measuredOptions)));
    expect(width).toBe(384);
  });

  it("preserves a saved width when the default changes", async () => {
    setLocalStorageItem("panel-width", 400, Schema.Finite);
    await act(() => {
      renderer = create(createElement(Panel, initialOptions));
    });
    expect(width).toBe(400);

    await act(() => renderer!.update(createElement(Panel, measuredOptions)));
    expect(width).toBe(400);
  });
});
