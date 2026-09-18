import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { CoderProfileConfig } from "../../coder/api";
import { useCoderSettingsConfig, type UpdateCoderSettingsConfig } from "./useCoderSettingsConfig";
let renderer: ReactTestRenderer;
let update: UpdateCoderSettingsConfig;
const config: CoderProfileConfig = { version: 1, deployments: [], workspaces: [] };
function Probe({ save }: { save: (next: CoderProfileConfig) => Promise<CoderProfileConfig> }) {
  update = useCoderSettingsConfig(config, save);
  return null;
}
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});
it("serializes configuration edits and applies the second to the first saved result", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const save = vi.fn(async (next: CoderProfileConfig) => next);
  await act(async () => {
    renderer = create(<Probe save={save} />);
  });
  await act(async () => {
    await Promise.all([
      update((current) => ({
        ...current,
        deployments: [
          ...current.deployments,
          { id: "one", name: "One", url: "https://one.example" },
        ],
      })),
      update((current) => ({
        ...current,
        deployments: [
          ...current.deployments,
          { id: "two", name: "Two", url: "https://two.example" },
        ],
      })),
    ]);
  });
  expect(save.mock.calls[1]?.[0].deployments.map((entry) => entry.id)).toEqual(["one", "two"]);
});
it("does not let a failed save poison later edits", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const save = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockImplementation(async (next: CoderProfileConfig) => next);
  await act(async () => {
    renderer = create(<Probe save={save} />);
  });
  await act(async () => {
    await expect(update((current) => current)).rejects.toThrow("offline");
    await update((current) => current);
  });
  expect(save).toHaveBeenCalledTimes(2);
});
