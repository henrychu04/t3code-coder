// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { PULL_REQUESTS_PANEL_REF, useRightPanelStore } from "../rightPanelStore";
import { useOpenPanelPullRequestUrl } from "./useOpenPanelPullRequestUrl";
const state = vi.hoisted(() => ({
  detail: undefined as unknown,
  project: null as unknown,
  query: vi.fn(),
}));
vi.mock("../state/entities", () => ({ useProject: () => state.project }));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: (input: unknown) => {
    state.query(input);
    return { data: state.detail };
  },
}));
vi.mock("../state/pullRequests", () => ({
  pullRequestEnvironment: { detail: (input: unknown) => input },
}));
let root: Root;
let element: HTMLDivElement;
let value: string | null | undefined;
function Probe() {
  value = useOpenPanelPullRequestUrl(PULL_REQUESTS_PANEL_REF);
  return null;
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.detail = undefined;
  state.project = null;
  state.query.mockClear();
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
  element = document.createElement("div");
  root = createRoot(element);
});
afterEach(async () => {
  await act(() => root.unmount());
});
it("uses the selected MR's workspace and refuses a stale detail from another MR", async () => {
  state.detail = {
    projectId: "project",
    repository: "group/project",
    number: 1,
    url: "https://gitlab.example/group/project/-/merge_requests/1",
  };
  useRightPanelStore.getState().openPullRequest(PULL_REQUESTS_PANEL_REF, {
    environmentId: "workspace-b",
    projectId: "project",
    repository: "group/project",
    number: 2,
  });
  await act(() => root.render(<Probe />));
  expect(value).toBeNull();
  expect(state.query).toHaveBeenLastCalledWith({
    environmentId: "workspace-b",
    input: { projectId: "project", repository: "group/project", number: 2 },
  });
  state.detail = {
    ...(state.detail as object),
    number: 2,
    url: "https://gitlab.example/group/project/-/merge_requests/2",
  };
  await act(() => root.render(<Probe />));
  expect(value).toBe("https://gitlab.example/group/project/-/merge_requests/2");
  await act(() => useRightPanelStore.getState().close(PULL_REQUESTS_PANEL_REF));
  expect(value).toBeUndefined();
  expect(state.query).toHaveBeenLastCalledWith(null);
});
it("uses a selected list entry's URL before detail has loaded and updates it on reopen", async () => {
  const target = {
    environmentId: "workspace",
    projectId: "project",
    repository: "group/project",
    number: 2,
  };
  useRightPanelStore.getState().openPullRequest(PULL_REQUESTS_PANEL_REF, target);
  await act(() => root.render(<Probe />));
  expect(value).toBeNull();
  await act(() =>
    useRightPanelStore
      .getState()
      .openPullRequest(PULL_REQUESTS_PANEL_REF, {
        ...target,
        url: "https://gitlab.example/group/project/-/merge_requests/2",
      }),
  );
  expect(value).toBe("https://gitlab.example/group/project/-/merge_requests/2");
});
