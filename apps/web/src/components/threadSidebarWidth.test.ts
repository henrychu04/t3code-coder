// @effect-diagnostics nodeBuiltinImport:off - Regression coverage compares the sidebar component with its width contract.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import {
  resolveInitialThreadSidebarWidth,
  THREAD_MAIN_CONTENT_MIN_WIDTH,
  THREAD_SIDEBAR_DEFAULT_WIDTH,
  THREAD_SIDEBAR_MIN_WIDTH,
} from "./threadSidebarWidth";

describe("thread sidebar width", () => {
  it("uses the default width when no preference is stored", () => {
    expect(resolveInitialThreadSidebarWidth(null, 1200)).toBe(THREAD_SIDEBAR_DEFAULT_WIDTH);
  });

  it("uses a stored width in the initial render", () => {
    expect(resolveInitialThreadSidebarWidth(360, 1200)).toBe(360);
  });

  it("clamps a stored width to the sidebar minimum", () => {
    expect(resolveInitialThreadSidebarWidth(120, 1200)).toBe(THREAD_SIDEBAR_MIN_WIDTH);
  });

  it("leaves enough room for the main content on a smaller window", () => {
    const viewportWidth = 1000;

    expect(resolveInitialThreadSidebarWidth(900, viewportWidth)).toBe(
      viewportWidth - THREAD_MAIN_CONTENT_MIN_WIDTH,
    );
  });

  it("keeps the sidebar minimum when the whole layout is narrower than its minimums", () => {
    expect(resolveInitialThreadSidebarWidth(900, 700)).toBe(THREAD_SIDEBAR_MIN_WIDTH);
  });

  it("shows the desktop wordmark across the sidebar's full legal width range", () => {
    const sidebarSource = NodeFS.readFileSync(
      new URL("./sidebar/SidebarChrome.tsx", import.meta.url),
      "utf8",
    );

    expect(sidebarSource).toContain("hidden h-7 w-fit min-w-0 shrink-0 items-center overflow-hidden");
    expect(sidebarSource).toContain("md:flex");
    expect(THREAD_SIDEBAR_MIN_WIDTH).toBe(13 * 16);
  });
});
import { describe, expect, it } from "vite-plus/test";
import {
  clampThreadSidebarWidth,
  resolveThreadSidebarMaximumWidth,
  resolveThreadSidebarMinimumWidth,
  THREAD_SIDEBAR_MIN_WIDTH,
} from "./threadSidebarWidth";

describe("resolveThreadSidebarMinimumWidth", () => {
  it("keeps the default minimum when the brand fits", () => {
    expect(resolveThreadSidebarMinimumWidth(0)).toBe(THREAD_SIDEBAR_MIN_WIDTH);
    expect(resolveThreadSidebarMinimumWidth(194)).toBe(THREAD_SIDEBAR_MIN_WIDTH);
  });

  it("grows to a brand wider than the default, rounding up", () => {
    expect(resolveThreadSidebarMinimumWidth(237.2)).toBe(238);
  });
});

describe("resolveThreadSidebarMaximumWidth", () => {
  it("never drops below a raised minimum on a narrow viewport", () => {
    expect(resolveThreadSidebarMaximumWidth(800, 238)).toBe(238);
    expect(resolveThreadSidebarMaximumWidth(1200, 238)).toBe(560);
  });
});

describe("clampThreadSidebarWidth", () => {
  it("widens a stored width below a raised minimum", () => {
    expect(clampThreadSidebarWidth(208, 238, 560)).toBe(238);
  });

  it("keeps widths inside the range and caps wide ones", () => {
    expect(clampThreadSidebarWidth(300, 238, 560)).toBe(300);
    expect(clampThreadSidebarWidth(900, 238, 560)).toBe(560);
  });
});
