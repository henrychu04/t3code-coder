import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { CoderProfileConfig } from "../../coder/api";
import { CoderWorkspaceSettings } from "./CoderWorkspaceSettings";
import { SettingsResource } from "./SettingsResource";

const state = vi.hoisted(() => ({
  confirm: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  restart: vi.fn(),
  update: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  refresh: vi.fn(),
  pollError: null as string | null,
  runtime: {} as Record<string, { status: string; updateAvailable: boolean }>,
  config: {} as CoderProfileConfig,
}));
vi.mock("../../coder/CoderBootstrap", () => ({
  useCoder: () => ({
    config: state.config,
    workspaceRuntime: state.runtime,
    connectionErrors: {},
    connectWorkspace: state.connect,
    disconnectWorkspace: state.disconnect,
    refreshWorkspaceRuntime: state.refresh,
    startWorkspace: state.start,
    stopWorkspace: state.stop,
    restartWorkspace: state.restart,
    updateWorkspace: state.update,
  }),
}));
vi.mock("../../localApi", () => ({
  readLocalApi: () => ({ dialogs: { confirm: state.confirm } }),
}));
vi.mock("./useSettingsPolling", () => ({
  useSettingsPolling: () => ({ error: state.pollError, pending: false, refresh: state.refresh }),
}));
vi.mock("../CoderWorkspaceDiagnostics", () => ({ CoderWorkspaceDiagnostics: () => null }));
vi.mock("./SettingsPage", () => ({
  SettingsRow: ({
    title,
    status,
    control,
    children,
  }: {
    title: React.ReactNode;
    status: React.ReactNode;
    control: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <div>
      {title}
      {status}
      {control}
      {children}
    </div>
  ),
  SettingsSection: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../ui/menu", () => ({
  Menu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MenuTrigger: () => null,
  MenuPopup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MenuItem: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));
let renderer: ReactTestRenderer;
const save = vi.fn(async (update: (config: CoderProfileConfig) => CoderProfileConfig) => {
  state.config = update(state.config);
});
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  state.confirm.mockResolvedValue(false);
  state.start.mockResolvedValue(undefined);
  state.pollError = null;
  state.config = {
    version: 1,
    deployments: [{ id: "domain", name: "Work", url: "https://coder.example.com" }],
    workspaces: ["one", "two"].map((id) => ({
      id,
      name: id,
      deploymentId: "domain",
      workspace: `owner/${id}`,
    })),
    portForwards: ["one", "two"].map((id, index) => ({
      id: `forward-${id}`,
      workspaceId: id,
      protocol: "tcp",
      localPort: 3000 + index,
      remotePort: 3000,
    })),
  };
  state.runtime = {
    one: { status: "running", updateAvailable: true },
    two: { status: "running", updateAvailable: false },
  };
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => {
    renderer = create(<CoderWorkspaceSettings updateConfig={save} />);
  });
}
async function click(label: string, resource = 0) {
  const row = renderer.root.findAllByType(SettingsResource)[resource]!;
  const button = row.findAllByType("button").find((node) => node.children.includes(label));
  expect(button).toBeDefined();
  expect(button!.props.disabled).not.toBe(true);
  await act(async () => {
    button!.props.onClick();
  });
}
it("keeps restart and stop behind their existing confirmations", async () => {
  await render();
  await click("Restart workspace");
  expect(state.restart).not.toHaveBeenCalled();
  state.confirm.mockResolvedValue(true);
  await click("Stop workspace");
  expect(state.confirm).toHaveBeenLastCalledWith(expect.stringContaining("Stop one?"), {
    variant: "destructive",
  });
  expect(state.stop).toHaveBeenCalledWith("one");
  expect(state.refresh).toHaveBeenCalledTimes(1);
});
it("removes only the selected workspace and its saved forwards", async () => {
  await render();
  await click("Remove connection");
  expect(state.disconnect).toHaveBeenCalledWith("one");
  expect(state.config.workspaces.map((workspace) => workspace.id)).toEqual(["two"]);
  expect(state.config.portForwards?.map((forward) => forward.id)).toEqual(["forward-two"]);
});
it("keeps a failed start beside the affected workspace", async () => {
  state.runtime.one = { status: "stopped", updateAvailable: false };
  state.start.mockRejectedValueOnce(new Error("Workspace failed to start"));
  await render();
  await click("Start");
  const rows = renderer.root.findAllByType(SettingsResource);
  expect(
    rows[0]!.findAll(
      (node) => node.type === "p" && node.children.includes("Could not start workspace"),
    ),
  ).toHaveLength(1);
  expect(
    rows[1]!.findAll(
      (node) => node.type === "p" && node.children.includes("Could not start workspace"),
    ),
  ).toHaveLength(0);
});
it("allows status retry after an initial poll fails", async () => {
  state.runtime = {};
  state.pollError = "The status check timed out.";
  await render();
  await click("Retry status");
  expect(state.refresh).toHaveBeenCalledTimes(1);
  expect(state.connect).not.toHaveBeenCalled();
});
