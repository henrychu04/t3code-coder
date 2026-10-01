// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

const { navigate, openExternal } = vi.hoisted(() => ({
  navigate: vi.fn(),
  openExternal: vi.fn(async () => undefined),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("~/localApi", () => ({ readLocalApi: () => ({ shell: { openExternal } }) }));
vi.mock("../state/entities", () => ({
  useProjects: () => [
    {
      id: "frontend",
      environmentId: "workspace",
      repositoryIdentity: {
        provider: "gitlab",
        canonicalKey: "code.example/team/frontend",
        displayName: "team/frontend",
        locator: { source: "git-remote", remoteUrl: "https://code.example/team/frontend.git" },
      },
    },
  ],
  useServerConfigs: () =>
    new Map(
      ["workspace", "other"].map((id) => [
        id,
        { environment: { capabilities: { pullRequests: true, threadPullRequests: true } } },
      ]),
    ),
}));

import { selectActiveRightPanelSurface, useRightPanelStore } from "../rightPanelStore";
import { useOpenPrLink } from "./openPullRequestLink";

const url = "https://code.example/team/backend/-/merge_requests/42";
let open: ReturnType<typeof useOpenPrLink> | undefined;
function Probe({ environmentId }: { environmentId: string }) {
  const handler = useOpenPrLink({
    environmentId: EnvironmentId.make(environmentId),
    threadId: ThreadId.make("thread"),
  });
  useEffect(() => {
    open = handler;
  }, [handler]);
  return null;
}
function click(modifier = false) {
  const button = document.createElement("button");
  return {
    currentTarget: button,
    metaKey: modifier,
    ctrlKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as React.MouseEvent<HTMLElement>;
}
async function render(environmentId: string) {
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe environmentId={environmentId} />));
  return root;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("opens a same-host MR beside its thread", async () => {
  const root = await render("workspace");
  expect(open!(click(), url)).toBe(true);
  expect(
    selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, {
      environmentId: EnvironmentId.make("workspace"),
      threadId: ThreadId.make("thread"),
    }),
  ).toMatchObject({ kind: "pull-request" });
  expect(openExternal).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

it("sends modifier clicks and other workspaces' MRs to the system browser", async () => {
  const root = await render("workspace");
  expect(open!(click(true), url)).toBe(false);
  await act(async () => root.unmount());
  // A thread can only read MRs through projects in its own workspace.
  const other = await render("other");
  expect(open!(click(), url)).toBe(false);
  expect(openExternal).toHaveBeenCalledTimes(2);
  expect(openExternal).toHaveBeenCalledWith(url);
  await act(async () => other.unmount());
});
