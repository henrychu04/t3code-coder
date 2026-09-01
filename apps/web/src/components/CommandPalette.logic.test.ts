import { describe, expect, it } from "vite-plus/test";

import {
  filterCommandPaletteGroups,
  reduceCommandPaletteUiState,
  type CommandPaletteGroup,
} from "./CommandPalette.logic";

describe("reduceCommandPaletteUiState", () => {
  const closed = { open: false, mode: "command", openIntent: null } as const;

  it("routes add-project and new-thread intents independently", () => {
    expect(reduceCommandPaletteUiState(closed, { _tag: "OpenAddProject" })).toEqual({
      open: true,
      mode: "command",
      openIntent: { kind: "add-project" },
    });
    expect(reduceCommandPaletteUiState(closed, { _tag: "OpenNewThreadIn" })).toEqual({
      open: true,
      mode: "command",
      openIntent: { kind: "new-thread-in" },
    });
  });

  it("toggles command mode", () => {
    const command = reduceCommandPaletteUiState(closed, {
      _tag: "ToggleMode",
      mode: "command",
    });
    expect(command).toEqual({ open: true, mode: "command", openIntent: null });
    expect(reduceCommandPaletteUiState(command, { _tag: "ToggleMode", mode: "command" })).toEqual({
      open: false,
      mode: "command",
      openIntent: null,
    });
  });
});

describe("filterCommandPaletteGroups", () => {
  const groups: CommandPaletteGroup[] = [
    {
      value: "actions",
      label: "Actions",
      items: [
        {
          kind: "action",
          value: "new-thread",
          searchTerms: ["new thread", "create", "T3 Coder"],
          title: "New thread in T3 Coder",
          icon: null,
          run: async () => undefined,
        },
      ],
    },
    {
      value: "projects",
      label: "Projects",
      items: [
        {
          kind: "action",
          value: "api-playground",
          searchTerms: ["API Playground", "/workspaces/api"],
          title: "API Playground",
          icon: null,
          run: async () => undefined,
        },
      ],
    },
  ];

  it("finds projects by title and preserves their group", () => {
    expect(filterCommandPaletteGroups({ groups, query: "api" })).toEqual([groups[1]]);
  });

  it("limits a > query to actions", () => {
    expect(filterCommandPaletteGroups({ groups, query: ">new" })).toEqual([groups[0]]);
  });

  it("matches multi-word queries independent of token order", () => {
    const settingsGroup: CommandPaletteGroup = {
      value: "settings-search",
      label: "Settings",
      items: [
        {
          kind: "action",
          value: "setting:merge-request-templates",
          searchTerms: ["Follow merge request templates", "GitLab source control"],
          title: "Follow merge request templates",
          icon: null,
          run: async () => undefined,
        },
      ],
    };

    expect(
      filterCommandPaletteGroups({ groups: [settingsGroup], query: "templates merge" })[0]?.items[0]
        ?.value,
    ).toBe("setting:merge-request-templates");
  });

  it("ranks a title containing every token above a split contextual match", () => {
    const settingsGroup: CommandPaletteGroup = {
      value: "settings-search",
      label: "Settings",
      items: [
        {
          kind: "action",
          value: "setting:context",
          searchTerms: ["GitLab settings", "write probe"],
          title: "Context match",
          icon: null,
          run: async () => undefined,
        },
        {
          kind: "action",
          value: "setting:write-probe",
          searchTerms: ["GitLab write probe", "Source control"],
          title: "GitLab write probe",
          icon: null,
          run: async () => undefined,
        },
      ],
    };

    expect(
      filterCommandPaletteGroups({ groups: [settingsGroup], query: "probe gitlab" })[0]?.items.map(
        (item) => item.value,
      ),
    ).toEqual(["setting:write-probe", "setting:context"]);
  });
});
