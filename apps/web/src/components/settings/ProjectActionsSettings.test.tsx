import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ProjectActionsSettings } from "./ProjectActionsSettings";
import { ProjectScriptEditorDialog } from "../projectScriptEditor";
import { MenuItem } from "../ui/menu";
const state = vi.hoisted(() => ({
  config: {
    status: "valid",
    file: {
      scripts: [
        { name: "Build", command: "pnpm build" },
        { name: "Test", command: "pnpm test" },
      ],
    },
    refresh: vi.fn(),
  } as {
    status: string;
    file: { scripts: { name: string; command: string }[] } | null;
    refresh: () => void;
  },
  read: vi.fn(),
  submit: vi.fn(),
  targets: [] as { environmentId: string; projectId: string; settings: object }[],
}));
vi.mock("../../hooks/useT3ProjectFile", () => ({
  useT3ProjectFile: (target: unknown) => {
    state.read(target);
    return state.config;
  },
}));
vi.mock("../../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "checkout", members: [] },
    targets: state.targets,
    target: state.targets[0] ?? null,
  }),
}));
vi.mock("./useProjectScriptSettings", () => ({
  useProjectScriptSettings: () => ({ saving: false, persist: vi.fn(), submit: state.submit }),
}));
vi.mock("./ProjectActionsList", () => ({ ProjectActionsList: () => null }));
vi.mock("../projectScriptEditor", () => ({
  EMPTY_PROJECT_SCRIPT_INPUT: {},
  ProjectScriptEditorDialog: () => null,
}));
vi.mock("./SettingsPage", () => ({
  SettingsSection: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SettingsRow: ({ control, title }: { control: React.ReactNode; title: string }) => (
    <div>
      {title}
      {control}
    </div>
  ),
}));
vi.mock("../ui/menu", () => ({
  Menu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MenuTrigger: () => null,
  MenuPopup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MenuItem: ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}));
let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.read.mockClear();
  state.submit.mockReset().mockResolvedValue({ _tag: "Success" });
  state.targets = [
    {
      environmentId: "one",
      projectId: "project",
      settings: { defaultProjectScripts: [{ id: "build", name: "Build", command: "pnpm build" }] },
    },
  ];
  state.config = {
    status: "valid",
    file: {
      scripts: [
        { name: "Build", command: "pnpm build" },
        { name: "Test", command: "pnpm test" },
      ],
    },
    refresh: vi.fn(),
  };
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});
it("offers only new scripts and requires an explicit import", async () => {
  await act(async () => {
    renderer = create(<ProjectActionsSettings />);
  });
  expect(state.submit).not.toHaveBeenCalled();
  const items = renderer.root.findAllByType(MenuItem);
  expect(items).toHaveLength(1);
  await act(async () => items[0]!.props.onClick());
  expect(state.submit).toHaveBeenCalledWith(null, {
    name: "Test",
    command: "pnpm test",
    icon: "play",
    runOnWorktreeCreate: false,
    waitForSetup: false,
  });
});
it("opens the editor with the failed import ready to correct", async () => {
  state.submit.mockResolvedValue({ _tag: "Failure" });
  await act(async () => {
    renderer = create(<ProjectActionsSettings />);
  });
  await act(async () => renderer.root.findByType(MenuItem).props.onClick());
  expect(renderer.root.findByType(ProjectScriptEditorDialog).props.request).toEqual(
    expect.objectContaining({
      scriptId: null,
      initial: expect.objectContaining({ name: "Test" }),
      error: expect.any(String),
    }),
  );
});
it("shows invalid configuration feedback without exposing file contents", async () => {
  state.config = { status: "invalid", file: null, refresh: vi.fn() };
  await act(async () => {
    renderer = create(<ProjectActionsSettings />);
  });
  expect(JSON.stringify(renderer.toJSON())).toContain("Invalid t3.json");
  expect(renderer.root.findAllByType(MenuItem)).toHaveLength(0);
});
it("uses the representative checkout for grouped imports, like upstream", async () => {
  state.targets.push({
    environmentId: "two",
    projectId: "another",
    settings: { defaultProjectScripts: [] },
  });
  await act(async () => {
    renderer = create(<ProjectActionsSettings />);
  });
  expect(state.read).toHaveBeenCalledWith(state.targets[0]);
});
it("deduplicates repository action names case-insensitively, like upstream", async () => {
  state.config.file = { scripts: [{ name: "build", command: "pnpm build:release" }] };
  await act(async () => {
    renderer = create(<ProjectActionsSettings />);
  });
  expect(renderer.root.findAllByType(MenuItem)).toHaveLength(0);
});
