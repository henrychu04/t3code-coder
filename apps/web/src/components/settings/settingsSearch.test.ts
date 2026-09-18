import { describe, expect, it } from "vite-plus/test";

import {
  SETTINGS_SEARCH_ITEMS,
  searchSettings,
  filterAvailableSettingsSearchItems,
  isSettingsSearchScopeAvailable,
} from "./settingsSearch";

describe("settings search catalog", () => {
  it("finds individual shortcuts by their command and default keys", () => {
    expect(
      searchSettings("filePicker.toggle").some(
        (item) => item.id === "keybinding-filePicker.toggle",
      ),
    ).toBe(true);
    const shortcut = SETTINGS_SEARCH_ITEMS.find(
      (item) => item.id === "keybinding-commandPalette.toggle",
    )!;
    expect(shortcut.to).toBe("/settings/shortcuts");
    expect(shortcut.secondary).toBe(true);
    expect(shortcut.searchTerms.length).toBeGreaterThan(1);
  });

  it("uses unique action ids", () => {
    const ids = SETTINGS_SEARCH_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("indexes individual GitLab, sidebar, editor, and appearance controls", () => {
    const ids = new Set(SETTINGS_SEARCH_ITEMS.map((item) => item.id));
    for (const id of [
      "git-fetch-interval",
      "source-control-writing-style",
      "follow-merge-request-templates",
      "gitlab-write-probe",
      "default-checkout-mode",
      "auto-settle-inactive-threads",
      "diff-layout",
      "confirm-thread-delete",
      "color-mode",
      "interface-font",
      "terminal-font",
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it("provides searchable context beyond the visible title", () => {
    for (const item of SETTINGS_SEARCH_ITEMS) {
      expect(item.section.length).toBeGreaterThan(0);
      expect(item.searchTerms.some((term) => term.trim().length > 0)).toBe(true);
    }
  });
});

it("finds settings by multiple words across titles and keywords", () => {
  expect(searchSettings("default model").some((item) => item.id === "default-model")).toBe(true);
  expect(searchSettings("fast forward").some((item) => item.id === "automatic-pull")).toBe(true);
  expect(searchSettings("custom COLORS").some((item) => item.id === "custom-themes")).toBe(true);
  expect(searchSettings("  ")).toEqual([]);
  expect(searchSettings("definitely-no-such-setting")).toEqual([]);
});

it("ranks exact titles ahead of aliases and normalizes diacritics", () => {
  const items = [
    {
      id: "alias",
      title: "Other",
      to: "/settings/preferences" as const,
      section: "General",
      searchTerms: ["cafe"],
    },
    {
      id: "prefix",
      title: "Café colors",
      to: "/settings/appearance" as const,
      section: "Appearance",
      searchTerms: [],
    },
    {
      id: "exact",
      title: "Café",
      to: "/settings/appearance" as const,
      section: "Appearance",
      searchTerms: [],
    },
  ];
  expect(searchSettings("  CAFE  ", items).map((item) => item.id)).toEqual([
    "exact",
    "prefix",
    "alias",
  ]);
});
it("does not offer settlement settings without a supporting workspace", () => {
  expect(
    filterAvailableSettingsSearchItems({ hasThreadAutoSettlement: false }).some(
      (item) => item.requiresThreadAutoSettlement,
    ),
  ).toBe(false);
  expect(
    filterAvailableSettingsSearchItems({ hasThreadAutoSettlement: true }).some(
      (item) => item.requiresThreadAutoSettlement,
    ),
  ).toBe(true);
});

it("filters workspace-only destinations while keeping browser preferences without connections", () => {
  const available = filterAvailableSettingsSearchItems({
    hasEnvironment: false,
    hasThreadAutoSettlement: false,
  });
  expect(available.some((item) => item.environmentOnly)).toBe(false);
  expect(available.some((item) => item.id === "custom-themes")).toBe(true);
});

it("finds local Coder resource sections without a connected workspace", () => {
  const items = filterAvailableSettingsSearchItems({
    hasEnvironment: false,
    hasThreadAutoSettlement: false,
  });
  expect(searchSettings("tcp", items).map((item) => item.id)).toContain("port-forwarding");
  expect(searchSettings("restart workspace", items).map((item) => item.id)).toContain(
    "coder-workspaces",
  );
});

it("finds workspace default actions without selecting a project", () => {
  const item = searchSettings("default actions").find(
    (item) => item.id === "default-project-actions",
  );
  expect(item?.to).toBe("/settings/preferences");
  expect(item?.scope).toBe("environment-defaults");
  expect(isSettingsSearchScopeAvailable(item!.scope!, "all")).toBe(true);
  expect(isSettingsSearchScopeAvailable(item!.scope!, "environment")).toBe(true);
  expect(isSettingsSearchScopeAvailable(item!.scope!, "project")).toBe(false);
});
