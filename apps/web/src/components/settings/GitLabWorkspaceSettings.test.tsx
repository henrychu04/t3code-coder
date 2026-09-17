import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { GitLabWorkspaceSettings } from "./GitLabWorkspaceSettings";
const state = vi.hoisted(() => ({
  selected: [{ environmentId: "one", label: "One", displayUrl: null }],
  discovery: vi.fn(),
  query: { data: null, error: null, isPending: false, refresh: vi.fn() },
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({ environments: state.selected }),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    isReady: true,
    environments: [{ environmentId: "one" }, { environmentId: "two" }],
  }),
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => state.query }));
vi.mock("../../state/sourceControl", () => ({
  sourceControlEnvironment: { discovery: state.discovery, probeWriteAccess: {} },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./SettingsPage", () => ({
  SettingsSection: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SettingsRow: ({ title, children }: { title: React.ReactNode; children: React.ReactNode }) => (
    <div>
      {title}
      {children}
    </div>
  ),
}));
let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.selected = [{ environmentId: "one", label: "One", displayUrl: null }];
  state.discovery.mockClear();
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});
it("queries and renders only the workspaces selected by the settings breadcrumb", async () => {
  await act(async () => {
    renderer = create(<GitLabWorkspaceSettings />);
  });
  expect(state.discovery.mock.calls.map(([input]) => input.environmentId)).toEqual(["one"]);
  expect(JSON.stringify(renderer.toJSON())).toContain("One");
  expect(JSON.stringify(renderer.toJSON())).not.toContain('"Two"');
});
it("does not fall back to unrelated workspaces when the selected scope is unavailable", async () => {
  state.selected = [];
  await act(async () => {
    renderer = create(<GitLabWorkspaceSettings />);
  });
  expect(state.discovery).not.toHaveBeenCalled();
  expect(JSON.stringify(renderer.toJSON())).toContain("Connect a selected Coder workspace");
});
