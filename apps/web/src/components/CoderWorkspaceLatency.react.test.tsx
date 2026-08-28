// @vitest-environment happy-dom

import { EnvironmentId } from "@t3tools/contracts";
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

const testState = vi.hoisted(() => ({
  workspaceNetwork: {
    "workspace-one": {
      latencyMs: 31.46,
      sampledAt: Date.parse("2026-08-25T18:00:00.000Z"),
      stale: false,
      slow: false,
    },
  },
  workspaceRuntime: {
    "workspace-one": {
      status: "running" as const,
      updateAvailable: false,
      healthy: true,
      autostopAt: "2026-08-25T20:00:00.000Z",
      requiredStopAt: null as string | null,
    },
  },
}));

vi.mock("../coder/CoderBootstrap", () => ({
  useCoder: () => ({
    workspaceNetwork: testState.workspaceNetwork,
    workspaceRuntime: testState.workspaceRuntime,
  }),
}));

vi.mock("../coder/api", () => ({
  loadCoderWorkspaceMetrics: () => new Promise(() => undefined),
}));

vi.mock("../coder/environmentStore", () => ({
  coderWorkspaceIdForEnvironment: () => "workspace-one",
}));

vi.mock("../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "environment-one",
        connection: { phase: "connected" },
      },
    ],
  }),
}));

vi.mock("./ui/popover", () => ({
  Popover: ({
    children,
    onOpenChange,
  }: {
    readonly children: ReactNode;
    readonly onOpenChange?: (open: boolean) => void;
  }) => {
    useEffect(() => onOpenChange?.(true), [onOpenChange]);
    return children;
  },
  PopoverPopup: ({ children }: { readonly children: ReactNode }) => children,
  PopoverTrigger: ({ render }: { readonly render: ReactNode }) => render,
}));

import { CoderWorkspaceLatency } from "./CoderWorkspaceLatency";

describe("Coder workspace hover metrics", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      configurable: true,
      value: true,
    });
  });

  afterAll(() => {
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-25T18:00:00.000Z");
    testState.workspaceRuntime["workspace-one"].autostopAt = "2026-08-25T20:00:00.000Z";
    testState.workspaceRuntime["workspace-one"].requiredStopAt = null;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("renders live latency precision and advances the open idle-stop countdown", async () => {
    await act(async () =>
      root.render(<CoderWorkspaceLatency environmentId={EnvironmentId.make("environment-one")} />),
    );

    expect(container.textContent).toContain("31.5 ms");
    expect(container.textContent).toContain("Idle stop in 2h 0m");

    await act(async () => vi.advanceTimersByTime(61_000));

    expect(container.textContent).toContain("Idle stop in 1h 59m");
  });

  it("labels an effective max deadline as a required stop without duplicating it", async () => {
    testState.workspaceRuntime["workspace-one"].requiredStopAt = "2026-08-25T20:00:00.000Z";

    await act(async () =>
      root.render(<CoderWorkspaceLatency environmentId={EnvironmentId.make("environment-one")} />),
    );

    expect(container.textContent).toContain("Required stop in 2h 0m");
    expect(container.textContent).not.toContain("Idle stop");
  });
});
