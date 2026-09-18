import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { MenuRadioGroup, MenuRadioItem } from "../ui/menu";
import { SettingsScopePicker } from "./SettingsScopePicker";

const mocks = vi.hoisted(() => ({ scope: vi.fn(), selectScope: vi.fn() }));
vi.mock("../ui/menu", () => ({
  Menu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuTrigger: ({ children, ...props }: { children: React.ReactNode }) => (
    <button {...props}>{children}</button>
  ),
  MenuPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuRadioGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuRadioItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuRadioItemIndicator: () => null,
  MenuSeparator: () => null,
}));
vi.mock("./SettingsScopeContext", () => ({ useSettingsScope: mocks.scope }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      { environmentId: "one", label: "Workspace one", connection: { phase: "connected" } },
    ],
  }),
}));

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  const group = {
    projectKey: "group",
    displayName: "Project",
    memberProjects: [
      { physicalProjectKey: "first", environmentId: "one", workspaceRoot: "/repo/first" },
      { physicalProjectKey: "second", environmentId: "one", workspaceRoot: "/repo/second" },
      { physicalProjectKey: "other", environmentId: "two", workspaceRoot: "/repo/other" },
    ],
  };
  mocks.scope.mockReturnValue({
    search: { project: "group", machine: "one", checkout: "first" },
    scope: { kind: "checkout", group },
    selectScope: mocks.selectScope,
    groups: [group],
    connectedEnvironments: [],
    environments: [],
  });
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("shows the current checkout and switches within the selected workspace and project", async () => {
  await act(async () => {
    renderer = create(<SettingsScopePicker />);
  });
  const selector = renderer!.root.findAllByType(MenuRadioGroup)[2]!;
  expect(selector.props.value).toBe("first");
  expect(selector.findAllByType(MenuRadioItem).map((option) => option.props.value)).toEqual([
    "",
    "first",
    "second",
  ]);
  await act(async () => selector.props.onValueChange("second"));
  expect(mocks.selectScope).toHaveBeenLastCalledWith({
    project: "group",
    machine: "one",
    checkout: "second",
  });
  await act(async () => selector.props.onValueChange(""));
  expect(mocks.selectScope).toHaveBeenLastCalledWith({
    project: "group",
    machine: "one",
    checkout: undefined,
  });
});

it("hides workspace and project targets on Appearance and Coder connections", async () => {
  for (const pathname of ["/settings/appearance", "/settings/general"]) {
    await act(async () => {
      renderer = create(<SettingsScopePicker pathname={pathname} />);
    });
    expect(renderer!.root.findAllByType(MenuRadioGroup)).toHaveLength(0);
    expect(renderer!.root.findByProps({ "aria-label": "Settings breadcrumb" })).toBeDefined();
    await act(async () => renderer!.unmount());
    renderer = undefined;
  }
});
