import type { ReactNode, ReactElement } from "react";
import { act, create } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";
import { DEFAULT_CLIENT_SETTINGS, DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import { Route } from "./settings.preferences";
import { SettingsRow } from "../components/settings/SettingsPage";
const state = vi.hoisted(() => ({
  update: vi.fn(),
  scopeKind: "all",
  modes: ["local", "worktree"],
}));
vi.mock("@tanstack/react-router", () => ({ createFileRoute: () => (options: object) => options }));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: () => DEFAULT_CLIENT_SETTINGS,
  useUpdateClientSettings: () => state.update,
}));
vi.mock("../components/settings/useScopedSettings", () => ({
  useScopedSettings: () => ({ ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: state.modes[0] }),
  useScopedSettingsMixed: () => new Set(state.modes).size > 1,
  useUpdateScopedSettings: () => state.update,
}));
vi.mock("../components/settings/SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { kind: state.scopeKind },
    target: { environmentId: "one", sources: { defaultThreadEnvMode: "environment" } },
    targets: [
      { environmentId: "one", settings: { defaultThreadEnvMode: "local" } },
      { environmentId: "two", settings: { defaultThreadEnvMode: "worktree" } },
    ],
  }),
}));
vi.mock("../hooks/useT3ProjectFile", () => ({ useT3ProjectFile: () => ({ file: null }) }));
vi.mock("../components/settings/ScopedSettingsTarget", () => ({
  ScopedSettingsTarget: ({ children }: { children: (environment: object) => ReactNode }) =>
    children({ environmentId: "one", serverConfig: { providers: [] } }),
}));
vi.mock("../components/settings/RestoreSettings", () => ({ RestoreWorkspaceSettings: () => null }));
vi.mock("../components/settings/TextGenerationModelSettings", () => ({
  TextGenerationModelSettings: () => null,
}));
vi.mock("../components/settings/ProjectActionsSettings", () => ({
  ProjectActionsSettings: () => <div data-default-actions />,
}));
vi.mock("../components/settings/ProjectDefaultSettings", () => ({
  ProjectDefaultModelSetting: () => null,
}));
vi.mock("../components/settings/ResponseSettings", () => ({ ResponseSettings: () => null }));
vi.mock("../components/settings/ScopedSwitch", () => ({ ScopedSwitch: () => null }));
vi.mock("../components/settings/projectGroupingSettings", () => ({
  readLastEnabledProjectGroupingMode: () => "repository",
  isProjectGroupingEnabled: () => false,
}));
vi.mock("../components/settings/SettingsPage", () => ({
  SettingsPage: ({ children }: { children: ReactNode }) => children,
  SettingsSection: ({ children }: { children: ReactNode }) => children,
  SettingsRow: ({ control }: { control: ReactNode }) => control,
  SettingResetButton: () => null,
}));
vi.mock("../components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => children,
  SelectTrigger: ({ children }: { children: ReactNode }) => children,
  SelectValue: ({ children }: { children: ReactNode }) => children,
  SelectPopup: () => null,
  SelectItem: () => null,
}));
vi.mock("../components/ui/input", () => ({ Input: () => null }));
vi.mock("../components/ui/switch", () => ({ Switch: () => null }));
it("leaves checkout mode unselected when workspaces disagree, like upstream", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const View = (Route as unknown as { component: () => ReactElement }).component;
  let renderer: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(<View />);
  });
  try {
    const row = renderer!.root
      .findAllByType(SettingsRow)
      .find((entry) => entry.props.id === "default-checkout-mode")!;
    expect(row.props.control.props.value).toBeNull();
  } finally {
    await act(async () => renderer!.unmount());
    vi.unstubAllGlobals();
  }
});

it.each(["all", "environment", "project", "checkout"])(
  "keeps workspace default actions accessible in General at %s scope",
  async (scopeKind) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.scopeKind = scopeKind;
    const View = (Route as unknown as { component: () => ReactElement }).component;
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<View />);
    });
    try {
      expect(renderer!.root.findAllByProps({ "data-default-actions": true })).toHaveLength(
        scopeKind === "all" || scopeKind === "environment" ? 1 : 0,
      );
    } finally {
      await act(async () => renderer!.unmount());
      state.scopeKind = "all";
      vi.unstubAllGlobals();
    }
  },
);
