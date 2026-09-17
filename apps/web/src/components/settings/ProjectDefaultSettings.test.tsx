import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ProjectDefaultModelSetting, ProjectAutoPullSetting } from "./ProjectDefaultSettings";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { ScopedSwitch } from "./ScopedSwitch";
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  mixed: vi.fn(),
  options: vi.fn(),
  toast: vi.fn(),
}));
const environments = ["one", "two"].map((environmentId) => ({
  environmentId,
  label: environmentId,
  serverConfig: { providers: [] },
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: "project" },
    target: { environmentId: "one" },
    targets: environments.map((entry) => ({
      environmentId: entry.environmentId,
      settings: DEFAULT_SERVER_SETTINGS,
    })),
    connectedEnvironments: environments,
  }),
}));
vi.mock("../../state/environments", () => ({ useEnvironments: () => ({ environments }) }));
vi.mock("../../providerInstances", () => ({
  resolveDefaultProviderModelSelection: () => ({ instanceId: "codex", model: "model" }),
  deriveCoderProviderInstanceEntries: () => [
    { instanceId: "codex", driverKind: "codex", enabled: true, isAvailable: true, models: [] },
  ],
  applyProviderInstanceSettings: (entries: unknown) => entries,
  sortProviderInstanceEntries: (entries: unknown) => entries,
}));
vi.mock("../../modelSelection", () => ({ getModelOptionsByInstance: mocks.options }));
vi.mock("../chat/ProviderModelPicker", () => ({ ProviderModelPicker: () => null }));
vi.mock("../chat/TraitsPicker", () => ({ TraitsPicker: () => null }));
vi.mock("../ui/toast", () => ({ toastManager: { add: mocks.toast } }));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => ({ defaultModelSelection: null, defaultAutoPull: false }),
  useScopedSettingsMixed: mocks.mixed,
  useUpdateScopedSettings: () => mocks.update,
}));
vi.mock("./ScopedSwitch", () => ({ ScopedSwitch: () => null }));
vi.mock("./SettingsPage", () => ({
  SettingsRow: ({ control }: { control: React.ReactNode }) => <div>{control}</div>,
}));
let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  mocks.update.mockResolvedValue(true);
  mocks.options.mockImplementation(() => new Map([["codex", [{ slug: "model" }]]]));
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});
it("shows mixed model defaults and saves only the chosen model", async () => {
  mocks.mixed.mockReturnValue(true);
  await act(async () => {
    renderer = create(<ProjectDefaultModelSetting />);
  });
  const select = renderer.root.findByType(ProviderModelPicker);
  expect(select.props.triggerLabel).toBe("Mixed");
  await act(async () => select.props.onInstanceModelChange("codex", "model"));
  expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
    defaultModelSelection: { instanceId: "codex", model: "model" },
  });
});
it("changes automatic pull through the scoped settings writer", async () => {
  await act(async () => {
    renderer = create(<ProjectAutoPullSetting />);
  });
  await act(async () => renderer.root.findByType(ScopedSwitch).props.onCheckedChange(true));
  expect(mocks.update).toHaveBeenCalledExactlyOnceWith({ defaultAutoPull: true });
});

it("rejects a model missing from another selected workspace", async () => {
  await act(async () => {
    renderer = create(<ProjectDefaultModelSetting />);
  });
  mocks.options
    .mockReturnValueOnce(new Map([["codex", [{ slug: "model" }]]]))
    .mockReturnValueOnce(new Map());
  await act(async () =>
    renderer.root.findByType(ProviderModelPicker).props.onInstanceModelChange("codex", "model"),
  );
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.toast.mock.calls[0]![0].description).toContain("two");
});
