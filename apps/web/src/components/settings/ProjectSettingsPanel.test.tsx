import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { ProjectSettingsPanel } from "./ProjectSettingsPanel";
import { Input } from "../ui/input";

const mocks = vi.hoisted(() => ({ update: vi.fn(), readProject: vi.fn(), environment: vi.fn() }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.update }));
vi.mock("../../state/projects", () => ({ projectEnvironment: { update: {} } }));
vi.mock("../../state/entities", () => ({
  readProject: mocks.readProject,
  useProject: vi.fn(),
  useProjects: vi.fn(),
}));
vi.mock("../../state/environments", () => ({
  useEnvironment: mocks.environment,
  useEnvironments: vi.fn(),
}));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => DEFAULT_UNIFIED_SETTINGS,
}));
vi.mock("../chat/ProviderModelPicker", () => ({ ProviderModelPicker: () => null }));

const project = {
  id: ProjectId.make("project"),
  environmentId: EnvironmentId.make("workspace-a"),
  title: "Smoke project",
  workspaceRoot: "/repo",
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  scripts: [],
} as unknown as EnvironmentProject;
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  mocks.environment.mockReturnValue({
    connection: { phase: "connected" },
    label: "Workspace A",
    serverConfig: { providers: [] },
  });
  mocks.readProject.mockReturnValue(project);
  mocks.update.mockResolvedValue({ _tag: "Success", value: undefined });
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
async function mount() {
  await act(async () => {
    renderer = create(<ProjectSettingsPanel project={project} />);
  });
  return renderer!.root;
}

it("saves edits only to the selected Coder workspace and project", async () => {
  const root = await mount();
  await act(async () =>
    root
      .findByType(Input)
      .props.onChange({ target: { value: "Renamed" } }),
  );
  await act(async () => root.findByType("form").props.onSubmit({ preventDefault() {} }));
  expect(mocks.readProject).toHaveBeenCalledWith({
    environmentId: "workspace-a",
    projectId: "project",
  });
  expect(mocks.update).toHaveBeenCalledOnce();
  expect(mocks.update).toHaveBeenCalledWith({
    environmentId: "workspace-a",
    input: {
      projectId: "project",
      title: "Renamed",
      defaultModelSelection: null,
      defaultThreadEnvMode: null,
      autoPull: false,
      scripts: [],
    },
  });
  expect(JSON.stringify(renderer!.toJSON())).toContain("Project settings saved.");
});

it("does not overwrite settings changed since the form was opened", async () => {
  const root = await mount();
  mocks.readProject.mockReturnValue({ ...project, autoPull: true });
  await act(async () => root.findByType("form").props.onSubmit({ preventDefault() {} }));
  expect(mocks.update).not.toHaveBeenCalled();
  expect(JSON.stringify(renderer!.toJSON())).toContain("changed elsewhere");
});

it("disables edits and dispatch when the workspace is disconnected", async () => {
  mocks.environment.mockReturnValue({
    connection: { phase: "offline" },
    label: "Workspace A",
    serverConfig: null,
  });
  const root = await mount();
  expect(root.findByType("fieldset").props.disabled).toBe(true);
  await act(async () => root.findByType("form").props.onSubmit({ preventDefault() {} }));
  expect(mocks.update).not.toHaveBeenCalled();
});
