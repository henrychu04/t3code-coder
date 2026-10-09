// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useThreadActionMenu } from "./useThreadActionMenu";

const state = vi.hoisted(() => ({
  clicked: null as string | null,
  setThreadAutoSettle: vi.fn(async () => ({ _tag: "Success" as const, value: undefined })),
}));
vi.mock("./useThreadActions", () => ({
  useThreadActions: () => ({ setThreadAutoSettle: state.setThreadAutoSettle }),
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("./useSettings", () => ({
  useClientSettings: (select: (settings: object) => unknown) =>
    select({ confirmThreadDelete: false, confirmThreadArchive: false, timestampFormat: "24-hour" }),
}));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate: vi.fn() }) }));
vi.mock("../state/entities", () => ({
  useActiveEnvironmentId: () => null,
  useProjects: () => [],
  readEnvironmentSupportsAutoSettleOptOut: () => true,
  readEnvironmentSupportsPinning: () => true,
  readEnvironmentSupportsSettlement: () => true,
  readEnvironmentSupportsSnooze: () => true,
  readEnvironmentSupportsTitleRegeneration: () => true,
  readThreadShell: () => ({
    id: "thread",
    projectId: "project",
    title: "Thread",
    branch: null,
    worktreePath: null,
    pinnedAt: null,
    settledOverride: null,
    autoSettleDisabledAt: null,
    titleRegeneration: null,
    session: null,
  }),
}));
vi.mock("../localApi", () => ({
  readLocalApi: () => ({
    contextMenu: { show: async () => state.clicked, close: async () => {} },
  }),
}));

const threadRef = { environmentId: "workspace", threadId: "thread" } as unknown as ScopedThreadRef;
let root: Root;
let openMenu: ((position: { x: number; y: number }) => void) | undefined;

function Probe() {
  openMenu = useThreadActionMenu({
    threadRef,
    projectCwd: "/repo",
    onStartRename: () => {},
  }).openMenu;
  return null;
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.setThreadAutoSettle.mockClear();
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(() => root.unmount());
});

it.each([
  ["auto-settle:disabled", false],
  ["auto-settle:enabled", true],
])("applies %s from the chat header menu", async (action, enabled) => {
  state.clicked = action;
  await act(() => root.render(<Probe />));
  await act(async () => {
    openMenu?.({ x: 0, y: 0 });
    await vi.waitFor(() => expect(state.setThreadAutoSettle).toHaveBeenCalled());
  });
  expect(state.setThreadAutoSettle).toHaveBeenCalledWith(threadRef, enabled);
});
