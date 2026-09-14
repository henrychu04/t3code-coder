import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useDirectoryEntries } from "./useDirectoryEntries";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), list: vi.fn((input) => input) }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({ executeAtomQuery: mocks.execute }));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("~/state/projects", () => ({ projectEnvironment: { listEntries: mocks.list } }));

let renderer: ReactTestRenderer;
let result: ReturnType<typeof useDirectoryEntries>;
function Probe() {
  const value = useDirectoryEntries(
    EnvironmentId.make("workspace"),
    ThreadId.make("thread"),
    "/project",
  );
  useLayoutEffect(() => {
    result = value;
  });
  return null;
}
beforeEach(() => {
  mocks.execute.mockReset();
  mocks.list.mockClear();
  mocks.execute.mockResolvedValue({ _tag: "Success", value: { entries: [], truncated: false } });
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
});

it("loads only the root initially and deduplicates concurrent folder expansion", async () => {
  await act(async () => {
    renderer = create(<Probe />);
  });
  expect(mocks.list).toHaveBeenCalledExactlyOnceWith({
    environmentId: "workspace",
    input: { threadId: "thread", cwd: "/project", directoryPath: "" },
  });
  let resolve!: (value: unknown) => void;
  mocks.execute.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  let request!: Promise<void>;
  await act(async () => {
    request = result.load("ignored");
    expect(result.load("ignored")).toBe(request);
  });
  expect(mocks.execute).toHaveBeenCalledTimes(2);
  await act(async () => {
    resolve({ _tag: "Success", value: { entries: [], truncated: false } });
    await request;
  });
  await act(async () => {
    await result.load("ignored");
  });
  expect(mocks.execute).toHaveBeenCalledTimes(2);
});

it("limits concurrent directory requests and drops queued work when the panel closes", async () => {
  await act(async () => {
    renderer = create(<Probe />);
  });
  const pending: Array<(value: unknown) => void> = [];
  mocks.execute.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
  let requests!: Promise<void>[];
  await act(async () => {
    requests = Array.from({ length: 9 }, (_, index) => result.load(`folder-${index}`));
  });
  expect(pending).toHaveLength(4);
  await act(async () => renderer.unmount());
  await act(async () => {
    for (const resolve of pending)
      resolve({ _tag: "Success", value: { entries: [], truncated: false } });
    await Promise.all(requests);
  });
  expect(mocks.execute).toHaveBeenCalledTimes(5);
});
