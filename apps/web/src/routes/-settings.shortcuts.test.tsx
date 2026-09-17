import type { ReactNode } from "react";
import { create, act } from "react-test-renderer";
import { it, vi, expect } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import type { EnvironmentPresentation } from "../state/environments";
import { WorkspaceShortcutsSettings } from "./settings.shortcuts";
const state = vi.hoisted(() => ({
  upsert: vi.fn(async (_input: unknown) => ({ _tag: "Success" })),
  remove: vi.fn(async (_input: unknown) => ({ _tag: "Success" })),
  targets: [] as EnvironmentPresentation[],
}));
vi.mock("@tanstack/react-router", () => ({ createFileRoute: () => (options: object) => options }));
vi.mock("../state/server", () => ({
  serverEnvironment: { upsertKeybinding: "upsert", removeKeybinding: "remove" },
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (key: string) => (key === "upsert" ? state.upsert : state.remove),
}));
vi.mock("../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../components/settings/SettingsScopeContext", () => ({
  useSettingsScope: () => ({ connectedEnvironments: state.targets }),
}));
vi.mock("../components/settings/WorkspaceSettingsTarget", () => ({
  WorkspaceSettingsTarget: () => null,
}));
vi.mock("../components/settings/SettingsPage", () => ({
  SettingsPage: ({ children }: { children: ReactNode }) => children,
  SettingsSection: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../components/settings/KeybindingWhenEditor", () => ({
  KeybindingWhenEditor: () => null,
}));
vi.mock("../components/ui/button", () => ({ Button: (props: object) => <button {...props} /> }));
it("resets each selected workspace using its own current rules", async () => {
  const original = DEFAULT_RESOLVED_KEYBINDINGS.find((rule) => rule.command === "thread.pin")!;
  state.targets = ["one", "two"].map((id, index) => ({
    environmentId: id,
    serverConfig: {
      settings: DEFAULT_SERVER_SETTINGS,
      keybindings: [
        { ...original, shortcut: { ...original.shortcut, key: index === 0 ? "a" : "b" } },
      ],
    },
  })) as unknown as EnvironmentPresentation[];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.remove.mockClear();
  state.upsert.mockClear();
  let renderer: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<WorkspaceShortcutsSettings environment={state.targets[0]!} />);
  });
  try {
    await act(async () => {
      await renderer!.root
        .findByProps({ "aria-label": "Reset Pin or unpin current thread" })
        .props.onClick();
    });
    expect(state.remove.mock.calls).toHaveLength(2);
    expect(state.remove.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({
        environmentId: "one",
        input: expect.objectContaining({ key: expect.stringContaining("a") }),
      }),
      expect.objectContaining({
        environmentId: "two",
        input: expect.objectContaining({ key: expect.stringContaining("b") }),
      }),
    ]);
    expect(state.upsert.mock.calls).toHaveLength(2);
  } finally {
    await act(async () => renderer!.unmount());
    vi.unstubAllGlobals();
  }
});
