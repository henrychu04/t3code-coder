import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";
import { ScopedProjectDefaults } from "./ScopedProjectDefaults";
import { Textarea } from "../ui/textarea";
import { Input } from "../ui/input";

const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  settings: vi.fn(),
  update: vi.fn(),
  mixed: vi.fn(),
}));
vi.mock("./SettingsScopeContext", () => ({ useSettingsScope: mocks.scope }));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: mocks.settings,
  useUpdateScopedSettings: () => mocks.update,
  useOptionalScopedSettingsMixed: mocks.mixed,
}));
vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("./SettingsPage", () => ({
  SettingsPage: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SettingsSection: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  SettingsRow: ({
    control,
    children,
  }: {
    control?: React.ReactNode;
    children?: React.ReactNode;
  }) => (
    <div>
      {control}
      {children}
    </div>
  ),
}));
let renderer: ReactTestRenderer | undefined;
const scope = (machine?: string) => ({
  environment: { serverConfig: { providers: [] } },
  targets: [{ environmentId: machine ?? "one", projectId: null }],
  scope: { kind: machine ? "environment" : "all", environmentIds: [machine ?? "one"], members: [] },
  search: machine ? { machine } : {},
});
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  mocks.scope.mockReturnValue(scope());
  mocks.settings.mockReturnValue(DEFAULT_UNIFIED_SETTINGS);
  mocks.update.mockResolvedValue(true);
  mocks.mixed.mockReturnValue(true);
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
async function mount() {
  await act(async () => {
    renderer = create(<ScopedProjectDefaults />);
  });
  return renderer!.root;
}
async function submit() {
  await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
}
it("shows mixed values and saves only edited defaults, preserving other workspaces' values", async () => {
  const root = await mount();
  expect(root.findByProps({ "aria-label": "Default model" }).props.value).toBe("mixed");
  expect(root.findByProps({ "aria-label": "Default checkout mode" }).props.value).toBe("mixed");
  expect(root.findByProps({ type: "checkbox" }).props["aria-checked"]).toBe("mixed");
  await act(async () =>
    root.findByProps({ type: "checkbox" }).props.onChange({ target: { checked: true } }),
  );
  await submit();
  expect(mocks.update).toHaveBeenCalledExactlyOnceWith({ defaultAutoPull: true });
});
it("does not write an untouched mixed form", async () => {
  await mount();
  await submit();
  expect(mocks.update).not.toHaveBeenCalled();
});
it("keeps script drafts after a failed save so a retry submits the same edits", async () => {
  mocks.update.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const root = await mount();
  await act(async () =>
    root
      .findAllByType("button")
      .find((button) => button.children.join("") === "Add script")!
      .props.onClick(),
  );
  await act(async () => root.findByType(Input).props.onChange({ target: { value: "Setup" } }));
  await act(async () =>
    root.findByType(Textarea).props.onChange({ target: { value: "pnpm install" } }),
  );
  await submit();
  expect(root.findByType(Textarea).props.value).toBe("pnpm install");
  await submit();
  expect(mocks.update).toHaveBeenCalledTimes(2);
  expect(mocks.update.mock.calls[1]![0]).toEqual(mocks.update.mock.calls[0]![0]);
  expect(Object.keys(mocks.update.mock.calls[0]![0])).toEqual(["defaultProjectScripts"]);
});
it("does not let an old save reset a draft in the newly selected workspace", async () => {
  let finish!: (value: boolean) => void;
  mocks.update.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const root = await mount();
  await act(async () =>
    root.findByProps({ type: "checkbox" }).props.onChange({ target: { checked: true } }),
  );
  await submit();
  mocks.scope.mockReturnValue(scope("two"));
  await act(async () => renderer!.update(<ScopedProjectDefaults />));
  await act(async () =>
    root
      .findByProps({ "aria-label": "Default checkout mode" })
      .props.onChange({ target: { value: "worktree" } }),
  );
  await act(async () => finish(true));
  expect(root.findByProps({ "aria-label": "Default checkout mode" }).props.value).toBe("worktree");
  await submit();
  expect(mocks.update.mock.calls[1]![0]).toEqual({ defaultThreadEnvMode: "worktree" });
});

it("reflects inheritance and subscription changes without discarding edited fields", async () => {
  mocks.mixed.mockReturnValue(false);
  const root = await mount();
  await act(async () =>
    root.findByProps({ type: "checkbox" }).props.onChange({ target: { checked: true } }),
  );
  mocks.settings.mockReturnValue({ ...DEFAULT_UNIFIED_SETTINGS, defaultThreadEnvMode: "worktree" });
  await act(async () => renderer!.update(<ScopedProjectDefaults />));
  expect(root.findByProps({ "aria-label": "Default checkout mode" }).props.value).toBe("worktree");
  expect(root.findByProps({ type: "checkbox" }).props.checked).toBe(true);
  await submit();
  expect(mocks.update).toHaveBeenCalledExactlyOnceWith({ defaultAutoPull: true });
});
