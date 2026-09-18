import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ScopedProjectDefaults } from "./ScopedProjectDefaults";
const mocks = vi.hoisted(() => ({ scope: vi.fn() }));
vi.mock("./SettingsScopeContext", () => ({ useSettingsScope: mocks.scope }));
vi.mock("./SettingsScopeNotice", () => ({
  SettingsScopeNotice: ({ children }: { children: React.ReactNode }) => (
    <div data-project-notice>{children}</div>
  ),
}));
vi.mock("./ProjectSettingsPanel", () => ({
  ProjectSettingsPanel: ({ projectKey }: { projectKey: string }) => (
    <div data-project={projectKey} />
  ),
}));
vi.mock("./SettingsPage", () => ({
  SettingsPage: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
let renderer: ReactTestRenderer;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});
async function mount(scope: unknown) {
  mocks.scope.mockReturnValue(scope);
  await act(async () => {
    renderer = create(<ScopedProjectDefaults />);
  });
  return renderer.root;
}
it("asks for a project instead of hiding workspace defaults on the project page", async () => {
  const root = await mount({ search: {}, scope: { kind: "all" } });
  expect(root.findAllByProps({ "data-project-notice": true })).toHaveLength(1);
});
it("renders the upstream panel for a selected checkout", async () => {
  const root = await mount({
    search: { project: "selected", machine: "two", checkout: "checkout" },
    scope: { kind: "checkout" },
  });
  expect(root.findAllByProps({ "data-project": "selected" })).toHaveLength(1);
});
it("keeps the project panel mounted when a grouping key changes so it can follow its members", async () => {
  const root = await mount({
    search: { project: "old-group" },
    scope: { kind: "unavailable", reason: "project-missing" },
  });
  expect(root.findAllByProps({ "data-project": "old-group" })).toHaveLength(1);
});
it("shows unavailable environments without a writable defaults form", async () => {
  const root = await mount({
    search: { machine: "missing" },
    scope: { kind: "unavailable", reason: "environment-missing", message: "Unavailable workspace" },
  });
  expect(root.findByProps({ role: "status" }).children).toEqual(["Unavailable workspace"]);
  expect(root.findAllByProps({ "data-default-actions": true })).toHaveLength(0);
});
