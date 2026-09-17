import { create, act, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import { SettingsScopeBoundary } from "./SettingsScopeBoundary";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
const state = vi.hoisted(() => ({
  hash: "",
  scope: { kind: "all", environmentIds: ["one", "two"] },
  environments: [
    {
      environmentId: "one",
      label: "One",
      connection: { phase: "connected" },
      serverConfig: { environment: { capabilities: { threadAutoSettlement: true } } },
    },
    {
      environmentId: "two",
      label: "Two",
      connection: { phase: "connected" },
      serverConfig: { environment: { capabilities: { threadAutoSettlement: false } } },
    },
  ],
}));
vi.mock("@tanstack/react-router", () => ({
  useLocation: ({ select }: { select: (location: unknown) => unknown }) =>
    select({ hash: state.hash }),
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({ scope: state.scope, connectedEnvironments: state.environments }),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: state.environments }),
}));
vi.mock("./SettingsScopeNotice", () => ({ SettingsScopeNotice: () => null }));
let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.hash = "";
  state.scope = { kind: "all", environmentIds: ["one", "two"] };
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});
it("offers the owning scope for a project search destination", async () => {
  state.hash = "project-overview";
  await act(async () => {
    renderer = create(
      <SettingsScopeBoundary pathname="/settings/projects">
        <p>Content</p>
      </SettingsScopeBoundary>,
    );
  });
  expect(renderer.root.findByType(SettingsScopeNotice).props.target).toBe("project");
});
it("offers only capable workspaces for unavailable settlement settings", async () => {
  state.hash = "auto-settle-inactive-threads";
  await act(async () => {
    renderer = create(
      <SettingsScopeBoundary pathname="/settings/preferences">
        <p>Content</p>
      </SettingsScopeBoundary>,
    );
  });
  expect(renderer.root.findByType(SettingsScopeNotice).props.eligibleEnvironmentIds).toEqual([
    "one",
  ]);
});
it("leaves browser preferences usable without a valid project target", async () => {
  state.scope = { kind: "unavailable", environmentIds: [] };
  await act(async () => {
    renderer = create(
      <SettingsScopeBoundary pathname="/settings/appearance">
        <p>Appearance</p>
      </SettingsScopeBoundary>,
    );
  });
  expect(renderer.root.findByType("p").children).toEqual(["Appearance"]);
});

it("withholds scoped controls without duplicating the breadcrumb's unavailable notice", async () => {
  state.scope = { kind: "unavailable", environmentIds: [] };
  await act(async () => {
    renderer = create(
      <SettingsScopeBoundary pathname="/settings/source-control">
        <p>Workspace controls</p>
      </SettingsScopeBoundary>,
    );
  });
  expect(renderer.toJSON()).toBeNull();
});
