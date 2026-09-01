import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { RightPanelSurface } from "../rightPanelStore";
import {
  RightPanelTabs,
  rightPanelTabContextMenuItems,
  surfaceShortcutActionForKey,
  surfaceShortcutTargetsTypingContext,
} from "./RightPanelTabs";

function shortcutEvent(
  key: string,
  overrides: Partial<Parameters<typeof surfaceShortcutActionForKey>[1]> = {},
): Parameters<typeof surfaceShortcutActionForKey>[1] {
  return {
    key,
    altKey: false,
    ctrlKey: false,
    defaultPrevented: false,
    isComposing: false,
    metaKey: false,
    ...overrides,
  };
}

const sharedProps = {
  surfaces: [],
  activeSurfaceId: null,
  pendingSurfaceIds: new Set<string>(),
  terminalLabelsById: new Map<string, string>(),
  onActivate: () => {},
  onCloseSurface: () => {},
  onCloseOtherSurfaces: () => {},
  onCloseSurfacesToRight: () => {},
  onCloseAllSurfaces: () => {},
  onCopyFilePath: () => {},
  onAddTerminal: () => {},
  onAddDiff: () => {},
  onAddFiles: () => {},
  onAddAgents: () => {},
  terminalAvailable: true,
  diffAvailable: true,
  filesAvailable: true,
  agentsAvailable: true,
  liveAgentCount: 0,
  children: null,
} as const;

describe("RightPanelTabs", () => {
  it("renders a resize handle for the inline panel", () => {
    const markup = renderToStaticMarkup(<RightPanelTabs {...sharedProps} mode="inline" />);

    expect(markup).toContain('aria-label="Resize right panel"');
    expect(markup).toContain('style="width:614px"');
    expect(markup).toContain("max-w-full");
    expect(markup).toContain("pr-28");
  });

  it("reserves inline titlebar controls only when they are overlaid", () => {
    const sheetMarkup = renderToStaticMarkup(
      <RightPanelTabs {...sharedProps} mode="sheet" layoutControls={<span>Controls</span>} />,
    );

    expect(sheetMarkup).toContain("pr-2");
    expect(sheetMarkup).not.toContain("pr-28");
  });

  it("does not render a resize handle when maximized or in a sheet", () => {
    const maximizedMarkup = renderToStaticMarkup(
      <RightPanelTabs {...sharedProps} mode="inline" maximized />,
    );
    const sheetMarkup = renderToStaticMarkup(<RightPanelTabs {...sharedProps} mode="sheet" />);

    expect(maximizedMarkup).not.toContain('aria-label="Resize right panel"');
    expect(sheetMarkup).not.toContain('aria-label="Resize right panel"');
  });

  it("explains why Files is disabled before a thread starts", () => {
    const markup = renderToStaticMarkup(
      <RightPanelTabs {...sharedProps} filesAvailable={false} mode="inline" />,
    );

    expect(markup).toContain("Available when a project is open.");
  });

  it("uses tab close controls without a redundant pane-level close-all button", () => {
    const markup = renderToStaticMarkup(<RightPanelTabs {...sharedProps} mode="inline" />);

    expect(markup).not.toContain('aria-label="Close all panel tabs"');
  });

  it("renders upstream launcher cards and their retained shortcuts", () => {
    const markup = renderToStaticMarkup(<RightPanelTabs {...sharedProps} mode="inline" />);

    expect(markup).toContain('data-surface-launcher-keys="TFDA"');
    expect(markup).toContain("grid-cols-[repeat(auto-fit,minmax(min(100%,11rem),1fr))]");
    expect(markup.match(/relative flex min-w-0 w-full/g)).toHaveLength(4);
    expect(markup).toContain("Start a shell in this workspace.");
    expect(markup).toContain("Browse and read workspace files.");
    expect(markup).toContain("Review changes in this thread.");
    expect(markup).toContain("Follow subagents and workflows.");
  });
});

describe("surface shortcuts", () => {
  const actions = [
    { shortcut: "T", available: true, label: "Terminal" },
    { shortcut: "D", available: false, label: "Diff" },
  ] as const;

  it("matches available surface shortcuts case-insensitively", () => {
    expect(surfaceShortcutActionForKey(actions, shortcutEvent("t"))).toBe(actions[0]);
    expect(surfaceShortcutActionForKey(actions, shortcutEvent("T"))).toBe(actions[0]);
  });

  it("does not activate unavailable surfaces", () => {
    expect(surfaceShortcutActionForKey(actions, shortcutEvent("d"))).toBeNull();
  });

  it("leaves modified, composing, and already-handled key events alone", () => {
    expect(surfaceShortcutActionForKey(actions, shortcutEvent("t", { metaKey: true }))).toBeNull();
    expect(
      surfaceShortcutActionForKey(actions, shortcutEvent("t", { isComposing: true })),
    ).toBeNull();
    expect(
      surfaceShortcutActionForKey(actions, shortcutEvent("t", { defaultPrevented: true })),
    ).toBeNull();
  });
});

describe("surface shortcut typing contexts", () => {
  const makeTarget = (matches: string | null) => ({
    closest(selectors: string) {
      if (matches === null || !selectors.includes(matches)) return null;
      return {};
    },
  });

  it("treats form fields and every editable region as typing contexts", () => {
    expect(surfaceShortcutTargetsTypingContext(makeTarget("input"))).toBe(true);
    expect(surfaceShortcutTargetsTypingContext(makeTarget("textarea"))).toBe(true);
    expect(surfaceShortcutTargetsTypingContext(makeTarget("select"))).toBe(true);
    expect(surfaceShortcutTargetsTypingContext(makeTarget("[contenteditable]"))).toBe(true);
  });

  it("claims letters when focus sits outside any editable region", () => {
    expect(surfaceShortcutTargetsTypingContext(null)).toBe(false);
    expect(surfaceShortcutTargetsTypingContext(makeTarget(null))).toBe(false);
  });
});

describe("right-panel tab context menu", () => {
  const fileSurface: RightPanelSurface = {
    id: "file:src/App.tsx",
    kind: "file",
    relativePath: "src/App.tsx",
    revealLine: null,
    revealRequestId: 0,
  };
  const surfaces: RightPanelSurface[] = [
    { id: "files", kind: "files" },
    fileSurface,
    { id: "diff", kind: "diff" },
  ];

  it("matches upstream file-tab actions and disabled states", () => {
    expect(rightPanelTabContextMenuItems(surfaces, fileSurface)).toEqual([
      { id: "copy-path", label: "Copy path" },
      { id: "close", label: "Close" },
      { id: "close-others", label: "Close others", disabled: false },
      { id: "close-to-right", label: "Close to the right", disabled: false },
      { id: "close-all", label: "Close all", disabled: false },
    ]);
  });

  it("omits Copy path for non-file tabs and disables closing to the right at the end", () => {
    expect(rightPanelTabContextMenuItems(surfaces, surfaces[2]!)).toEqual([
      { id: "close", label: "Close" },
      { id: "close-others", label: "Close others", disabled: false },
      { id: "close-to-right", label: "Close to the right", disabled: true },
      { id: "close-all", label: "Close all", disabled: false },
    ]);
  });

  it("returns no actions for a stale surface", () => {
    expect(rightPanelTabContextMenuItems(surfaces, { id: "agents", kind: "agents" })).toEqual([]);
  });
});
