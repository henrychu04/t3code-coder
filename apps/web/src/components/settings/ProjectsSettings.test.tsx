import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { ProjectsSettings } from "./ProjectsSettings";

const mocks = vi.hoisted(() => ({ environments: vi.fn(), update: vi.fn() }));
vi.mock("../../state/environments", () => ({ useEnvironments: mocks.environments }));
vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.update }));
vi.mock("./SettingsPage", () => ({
  SettingsPage: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SettingsSection: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  SettingsRow: ({ control }: { control: React.ReactNode }) => <div>{control}</div>,
}));
let renderer: ReactTestRenderer | undefined;
const environment = (id: string, phase = "connected") => ({
  environmentId: id,
  label: id,
  connection: { phase },
  serverConfig: { settings: DEFAULT_SERVER_SETTINGS, providers: [] },
});
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.environments.mockReturnValue({
    environments: [environment("one"), environment("offline", "offline"), environment("two")],
  });
  mocks.update.mockReset().mockResolvedValue({ _tag: "Success" });
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
async function mount() {
  await act(async () => {
    renderer = create(<ProjectsSettings />);
  });
  return renderer!.root;
}

it("writes defaults to connected workspaces and leaves offline workspaces untouched", async () => {
  const root = await mount();
  await act(async () => root.findByType("input").props.onChange({ target: { checked: true } }));
  await act(async () => root.findByType("form").props.onSubmit({ preventDefault() {} }));
  expect(mocks.update.mock.calls.map(([input]) => input.environmentId)).toEqual(["one", "two"]);
  expect(
    mocks.update.mock.calls.every(([input]) => input.input.patch.defaultAutoPull === true),
  ).toBe(true);
});
it("scopes a default change to the explicitly selected workspace", async () => {
  const root = await mount();
  await act(async () =>
    root
      .findByProps({ "aria-label": "Project defaults workspace" })
      .props.onChange({ target: { value: "two" } }),
  );
  await act(async () => root.findByType("form").props.onSubmit({ preventDefault() {} }));
  expect(mocks.update).toHaveBeenCalledOnce();
  expect(mocks.update.mock.calls[0]![0].environmentId).toBe("two");
});
it("reports partial failures without claiming every workspace was updated", async () => {
  mocks.update
    .mockResolvedValueOnce({ _tag: "Success" })
    .mockResolvedValueOnce({ _tag: "Failure" });
  const root = await mount();
  await act(async () => root.findByType("form").props.onSubmit({ preventDefault() {} }));
  expect(JSON.stringify(renderer!.toJSON())).toContain("Could not save defaults in: two");
});
it("resets displayed defaults when the source workspace disconnects", async () => {
  const one = environment("one");
  const two = {
    ...environment("two"),
    serverConfig: {
      settings: { ...DEFAULT_SERVER_SETTINGS, defaultAutoPull: true },
      providers: [],
    },
  };
  mocks.environments.mockReturnValue({ environments: [one, two] });
  const root = await mount();
  expect(root.findByType("input").props.checked).toBe(false);
  mocks.environments.mockReturnValue({
    environments: [{ ...one, connection: { phase: "offline" } }, two],
  });
  await act(async () => renderer!.update(<ProjectsSettings />));
  await act(async () => root.findByType("form").props.onSubmit({ preventDefault() {} }));
  expect(mocks.update.mock.calls[0]![0].environmentId).toBe("two");
  expect(mocks.update.mock.calls[0]![0].input.patch.defaultAutoPull).toBe(true);
});
