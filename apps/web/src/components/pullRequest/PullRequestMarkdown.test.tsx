// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { PullRequestMarkdown, PullRequestMarkdownContext } from "./PullRequestMarkdown";
import {
  PULL_REQUESTS_PANEL_REF,
  pullRequestSurface,
  selectActiveRightPanelSurface,
  useRightPanelStore,
} from "../../rightPanelStore";

const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));
vi.mock("../../state/entities", async (original) => ({
  ...(await original<typeof import("../../state/entities")>()),
  useProjects: () => [
    {
      id: "project",
      environmentId: "workspace",
      repositoryIdentity: {
        provider: "gitlab",
        displayName: "group/project",
        canonicalKey: "gitlab.example/group/project",
        locator: { source: "git-remote", remoteUrl: "https://gitlab.example/group/project.git" },
      },
    },
  ],
}));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
  navigate.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});
it("opens a recognized MR in the page panel and updates its URL selection", async () => {
  await act(() =>
    root.render(
      <PullRequestMarkdownContext
        value={{
          repositoryUrl: "https://gitlab.example/group/project",
          panelRef: PULL_REQUESTS_PANEL_REF,
        }}
      >
        <PullRequestMarkdown
          environmentId={EnvironmentId.make("workspace")}
          cwd="/project"
          hostUrl="https://gitlab.example"
          text="[Next MR](https://gitlab.example/group/project/-/merge_requests/42)"
        />
      </PullRequestMarkdownContext>,
    ),
  );
  const button = [...container.querySelectorAll("button")].find(
    (entry) => entry.textContent === "Next MR",
  );
  expect(button).toBeDefined();
  await act(() => button!.click());
  expect(
    selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      PULL_REQUESTS_PANEL_REF,
    ),
  ).toEqual(
    pullRequestSurface({
      environmentId: "workspace",
      projectId: "project",
      repository: "group/project",
      number: 42,
      url: "https://gitlab.example/group/project/-/merge_requests/42",
    }),
  );
  expect(navigate).toHaveBeenCalledWith(
    expect.objectContaining({ to: "/pull-requests", replace: true }),
  );
});
it("keeps external video and attachment cards inert", async () => {
  await act(() =>
    root.render(
      <PullRequestMarkdown
        environmentId={EnvironmentId.make("workspace")}
        cwd="/project"
        hostUrl="https://gitlab.example"
        text={
          "https://example.com/demo.mp4\n\n/uploads/abc/file.zip\n\n![image](https://example.com/picture.png)"
        }
      />,
    ),
  );
  expect(container.textContent).toContain("Video attachment");
  expect(container.textContent).toContain("Attachment on gitlab.example");
  expect(container.querySelector("a[href], video, iframe, img[src]")).toBeNull();
});
