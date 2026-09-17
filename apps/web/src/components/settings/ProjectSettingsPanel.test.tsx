import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { Cause } from "effect";
import { ProjectSettingsPanel } from "./ProjectSettingsPanel";
import { Input } from "../ui/input";
const mocks = vi.hoisted(() => ({
  groups: vi.fn(),
  environments: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  confirm: vi.fn(),
  clear: vi.fn(),
  navigate: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("./useSettingsProjectGroups", () => ({ useSettingsProjectGroups: mocks.groups }));
vi.mock("../../state/environments", () => ({ useEnvironments: mocks.environments }));
vi.mock("../../state/entities", () => ({ useThreadShells: () => [] }));
vi.mock("../../state/projects", () => ({
  projectEnvironment: { update: "update", delete: "delete" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (operation: string) => (operation === "update" ? mocks.update : mocks.remove),
}));
vi.mock("../../composerDraftStore", () => ({
  useComposerDraftStore: { getState: () => ({ clearProjectDraftThreadId: mocks.clear }) },
}));
vi.mock("../../localApi", () => ({
  readLocalApi: () => ({ dialogs: { confirm: mocks.confirm } }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  useLocation: ({ select }: { select: (value: unknown) => unknown }) =>
    select({ pathname: "/settings/projects" }),
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: mocks.toast },
  stackedThreadToast: (value: unknown) => value,
}));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("./ProjectActionsSettings", () => ({ ProjectActionsSettings: () => null }));
vi.mock("./SettingsPage", () => ({
  SettingsPage: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SettingsSection: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  SettingsRow: ({ control }: { control: React.ReactNode }) => <div>{control}</div>,
  SettingResetButton: () => null,
}));
const members = ["one", "two"].map((id) => ({
  id: `project-${id}`,
  environmentId: id,
  physicalProjectKey: id,
  title: "Project",
  workspaceRoot: `/repo/${id}`,
  environmentLabel: id,
  scripts: [],
}));
const group = { projectKey: "group", displayName: "Project", memberProjects: members };
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  mocks.groups.mockReturnValue([group]);
  mocks.environments.mockReturnValue({
    environments: members.map((member) => ({
      environmentId: member.environmentId,
      connection: { phase: "connected" },
      serverConfig: {},
    })),
  });
  mocks.update.mockResolvedValue({ _tag: "Success", value: undefined });
  mocks.remove.mockResolvedValue({ _tag: "Success", value: undefined });
  mocks.confirm.mockResolvedValue(true);
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
async function mount(checkoutKey?: string) {
  await act(async () => {
    renderer = create(
      <ProjectSettingsPanel projectKey="group" {...(checkoutKey ? { checkoutKey } : {})} />,
    );
  });
  return renderer!.root;
}
async function rename() {
  const input = renderer!.root.findByType(Input);
  await act(async () => input.props.onChange());
  await act(async () => input.props.onBlur({ currentTarget: { value: "Renamed" } }));
}
it("renames all selected checkouts on blur", async () => {
  await mount();
  await rename();
  expect(mocks.update.mock.calls.map(([arg]) => arg)).toEqual(
    members.map((member) => ({
      environmentId: member.environmentId,
      input: { projectId: member.id, title: "Renamed" },
    })),
  );
});
it("does not rename any member while one is disconnected", async () => {
  mocks.environments.mockReturnValue({
    environments: [{ environmentId: "one", connection: { phase: "connected" }, serverConfig: {} }],
  });
  await mount();
  await rename();
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenCalled();
});
it("cancelling grouped removal leaves projects and drafts intact", async () => {
  mocks.confirm.mockResolvedValue(false);
  const root = await mount();
  await act(async () =>
    root
      .findAllByType("button")
      .find((node) => node.children.includes("Remove all entries"))!
      .props.onClick(),
  );
  expect(mocks.remove).not.toHaveBeenCalled();
  expect(mocks.clear).not.toHaveBeenCalled();
});
it("removes a whole group and clears only its drafts after confirmation", async () => {
  const root = await mount();
  await act(async () =>
    root
      .findAllByType("button")
      .find((node) => node.children.includes("Remove all entries"))!
      .props.onClick(),
  );
  expect(mocks.confirm.mock.calls[0]![0]).toContain("2 grouped project entries");
  expect(mocks.remove).toHaveBeenCalledTimes(2);
  expect(mocks.clear.mock.calls.map(([ref]) => ref)).toEqual(
    members.map((member) => ({ environmentId: member.environmentId, projectId: member.id })),
  );
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/", replace: true });
});
it("stops on a partial removal failure without clearing the failed checkout draft", async () => {
  mocks.remove
    .mockResolvedValueOnce({ _tag: "Success" })
    .mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail(new Error("Disconnected")) });
  const root = await mount();
  await act(async () =>
    root
      .findAllByType("button")
      .find((node) => node.children.includes("Remove all entries"))!
      .props.onClick(),
  );
  expect(mocks.clear).toHaveBeenCalledTimes(1);
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenCalled();
});
it("follows the selected physical project when grouping changes", async () => {
  await mount("one");
  mocks.groups.mockReturnValue([{ ...group, projectKey: "new-group" }]);
  await act(async () =>
    renderer!.update(<ProjectSettingsPanel projectKey="group" checkoutKey="one" />),
  );
  const navigation = mocks.navigate.mock.calls[0]![0];
  expect(navigation.search()).toEqual({
    project: "new-group",
    machine: undefined,
    checkout: "one",
  });
});
