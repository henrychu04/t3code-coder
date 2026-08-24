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

  it("toggles command and file modes without stacking them", () => {
    const files = reduceCommandPaletteUiState(closed, { _tag: "ToggleMode", mode: "files" });
    expect(files).toEqual({ open: true, mode: "files", openIntent: null });
    expect(reduceCommandPaletteUiState(files, { _tag: "ToggleMode", mode: "command" })).toEqual({
      open: true,
      mode: "command",
      openIntent: null,
    });
    expect(reduceCommandPaletteUiState(files, { _tag: "ToggleMode", mode: "files" })).toEqual({
      open: false,
      mode: "files",
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
});
