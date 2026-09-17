import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { Cause } from "effect";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ProjectScript,
} from "@t3tools/contracts";
import { useProjectScriptSettings } from "./useProjectScriptSettings";
const mocks = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../../state/server", () => ({ serverEnvironment: { updateSettings: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.update }));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
let renderer: ReactTestRenderer;
let actions: ReturnType<typeof useProjectScriptSettings>;
const script = (id: string): ProjectScript => ({
  id,
  name: id,
  command: `echo ${id}`,
  icon: "play",
  runOnWorktreeCreate: false,
});
const targets = ["one", "two"].map((id) => ({
  environmentId: EnvironmentId.make(id),
  project: { id: ProjectId.make("shared-id"), scripts: [] },
  settings: {
    ...DEFAULT_SERVER_SETTINGS,
    projectSettingsOverrides: {
      [ProjectId.make("shared-id")]: { defaultAutoPull: true, defaultProjectScripts: [script(id)] },
    },
  },
}));
function Harness() {
  actions = useProjectScriptSettings(targets);
  return null;
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  mocks.update.mockResolvedValue({ _tag: "Success", value: undefined });
  await act(async () => {
    renderer = create(<Harness />);
  });
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});
it("adds an action to each workspace's own list without replacing mixed values", async () => {
  await act(async () => {
    await actions.submit(null, {
      name: "Build",
      command: "pnpm build",
      icon: "build",
      runOnWorktreeCreate: true,
    });
  });
  expect(mocks.update).toHaveBeenCalledTimes(2);
  for (const [index, [call]] of mocks.update.mock.calls.entries()) {
    const entry = call.input.patch.projectSettingsOverrides["shared-id"];
    expect(entry.defaultAutoPull).toBe(true);
    expect(entry.defaultProjectScripts.map((item: ProjectScript) => item.id)).toEqual([
      index === 0 ? "one" : "two",
      "build",
    ]);
    expect(entry.defaultProjectScripts[1].runOnWorktreeCreate).toBe(true);
  }
});
it("resets only the scripts override", async () => {
  await act(async () => {
    await actions.persist(() => null);
  });
  expect(mocks.update.mock.calls[0]![0].input.patch.projectSettingsOverrides["shared-id"]).toEqual({
    defaultAutoPull: true,
  });
});
it("stops on failure and allows a retry", async () => {
  mocks.update.mockResolvedValueOnce({
    _tag: "Failure",
    cause: Cause.fail(new Error("Disconnected")),
  });
  let result: unknown;
  await act(async () => {
    result = await actions.submit(null, {
      name: "Build",
      command: "pnpm build",
      icon: "build",
      runOnWorktreeCreate: false,
    });
  });
  expect(result).toMatchObject({ _tag: "Failure" });
  expect(mocks.update).toHaveBeenCalledTimes(1);
  expect(actions.saving).toBe(false);
  await act(async () => {
    await actions.submit(null, {
      name: "Build",
      command: "pnpm build",
      icon: "build",
      runOnWorktreeCreate: false,
    });
  });
  expect(mocks.update).toHaveBeenCalledTimes(3);
});

it("reuses the action ID when retrying after a partial bulk save", async () => {
  const retryTargets = targets.map((target) => ({ ...target }));
  function RetryHarness() {
    actions = useProjectScriptSettings(retryTargets);
    return null;
  }
  await act(async () => renderer.update(<RetryHarness />));
  let failSecond = true;
  mocks.update.mockImplementation(async ({ environmentId, input }) => {
    if (environmentId === "two" && failSecond)
      return { _tag: "Failure", cause: Cause.fail(new Error("Disconnected")) };
    const target = retryTargets.find((entry) => entry.environmentId === environmentId)!;
    target.settings = {
      ...target.settings,
      projectSettingsOverrides: input.patch.projectSettingsOverrides,
    };
    return { _tag: "Success", value: undefined };
  });
  const input = {
    name: "Build",
    command: "pnpm build",
    icon: "build" as const,
    runOnWorktreeCreate: false,
  };
  await act(async () => {
    expect(await actions.submit(null, input)).toMatchObject({ _tag: "Failure" });
  });
  await act(async () => renderer.update(<RetryHarness />));
  failSecond = false;
  await act(async () => {
    expect(await actions.submit(null, input)).toMatchObject({ _tag: "Success" });
  });
  for (const target of retryTargets) {
    const scripts =
      target.settings.projectSettingsOverrides[ProjectId.make("shared-id")]!.defaultProjectScripts!;
    expect(
      scripts.filter((entry) => entry.command === "pnpm build").map((entry) => entry.id),
    ).toEqual(["build"]);
  }
});
