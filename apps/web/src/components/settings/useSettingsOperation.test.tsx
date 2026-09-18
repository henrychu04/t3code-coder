import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useSettingsOperation } from "./useSettingsOperation";
let renderer: ReactTestRenderer;
let operation: ReturnType<typeof useSettingsOperation>;
function Probe() {
  operation = useSettingsOperation();
  return null;
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(async () => {
    renderer = create(<Probe />);
  });
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});
it("prevents duplicate command submission before React updates the buttons", async () => {
  let finish!: () => void;
  const work = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  let first!: Promise<boolean>;
  let second!: Promise<boolean>;
  await act(async () => {
    first = operation.run("resource", "Failed", work);
    second = operation.run("resource", "Failed", work);
  });
  expect(await second).toBe(false);
  expect(work).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish();
    expect(await first).toBe(true);
  });
  expect(operation.pending).toBeNull();
});
it("attaches a failure to its resource and clears it after a retry", async () => {
  await act(async () => {
    expect(
      await operation.run("forward", "Could not restart", async () => {
        throw new Error("port busy");
      }),
    ).toBe(false);
  });
  expect(operation.error).toEqual({
    key: "forward",
    title: "Could not restart",
    details: "port busy",
  });
  await act(async () => {
    await operation.run("forward", "Could not restart", async () => {});
  });
  expect(operation.error).toBeNull();
});
