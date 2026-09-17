// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { Route } from "./settings";
const state = vi.hoisted(() => ({
  search: { machine: "one" },
  navigate: vi.fn(),
  change: (_next: unknown) => {},
  restore: () => {},
}));
function DraftForm() {
  const [draft, setDraft] = useState("");
  return <input value={draft} onChange={(e) => setDraft(e.target.value)} />;
}
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: object) => ({ ...options, useSearch: () => state.search }),
  useNavigate: () => state.navigate,
  useCanGoBack: () => false,
  useLocation: ({ select }: { select: (location: unknown) => unknown }) =>
    select({ pathname: "/settings/preferences" }),
  Outlet: () => <DraftForm />,
}));
vi.mock("../components/settings/SettingsScopeContext", () => ({
  SettingsScopeProvider: ({
    children,
    onChange,
  }: {
    children: ReactNode;
    onChange: typeof state.change;
  }) => {
    state.change = onChange;
    return children;
  },
}));
vi.mock("../components/settings/SettingsScopePicker", () => ({
  SettingsScopePicker: ({ onRestoreDefaults }: { onRestoreDefaults: () => void }) => {
    state.restore = onRestoreDefaults;
    return null;
  },
}));
vi.mock("../components/settings/SettingsScopeBoundary", () => ({
  SettingsScopeBoundary: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../components/ui/sidebar", () => ({
  SidebarInset: ({ children }: { children: ReactNode }) => children,
}));
let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.search = { machine: "one" };
  state.navigate.mockClear();
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});
it("clears the old search anchor and discards unfinished form state when switching scope", async () => {
  const Layout = (Route as unknown as { component: () => ReactNode }).component;
  await act(async () => {
    renderer = create(<Layout />);
  });
  await act(async () =>
    renderer.root.findByType("input").props.onChange({ target: { value: "unfinished" } }),
  );
  await act(async () => state.change({ machine: "two" }));
  expect(state.navigate).toHaveBeenCalledWith(
    expect.objectContaining({
      hash: "",
      search: { project: undefined, checkout: undefined, machine: "two" },
    }),
  );
  state.search = { machine: "two" };
  await act(async () => renderer.update(<Layout />));
  expect(renderer.root.findByType("input").props.value).toBe("");
});

it("discards unfinished form state after a successful defaults restore", async () => {
  const Layout = (Route as unknown as { component: () => ReactNode }).component;
  await act(async () => {
    renderer = create(<Layout />);
  });
  await act(async () =>
    renderer.root.findByType("input").props.onChange({ target: { value: "unfinished" } }),
  );
  await act(async () => state.restore());
  expect(renderer.root.findByType("input").props.value).toBe("");
});
