import { beforeEach, expect, it, vi } from "vite-plus/test";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useRightPanelStore } from "../rightPanelStore";
import { readThreadReference } from "./threadReference";

const entities = vi.hoisted(() => ({ readProject: vi.fn(), readThreadShell: vi.fn() }));
vi.mock("../state/entities", () => entities);
const ref = scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make("thread"));
const linkedUrl = "https://gitlab.example/group/project/-/merge_requests/1";
beforeEach(() => {
  vi.resetAllMocks();
  useRightPanelStore.setState({ byThreadKey: {} });
  entities.readThreadShell.mockReturnValue({ linkedPullRequest: { url: linkedUrl } });
  entities.readProject.mockReturnValue({
    repositoryIdentity: {
      provider: "gitlab",
      canonicalKey: "gitlab.example/group/project",
      locator: { source: "git-remote", remoteUrl: "git@gitlab.example:group/project.git" },
    },
  });
});

it("prefers the visible MR in its own environment, then the linked MR when closed", () => {
  useRightPanelStore.getState().openPullRequest(ref, {
    environmentId: "other",
    projectId: "project",
    repository: "group/project",
    number: 2,
  });
  expect(readThreadReference(ref)).toBe("https://gitlab.example/group/project/-/merge_requests/2");
  expect(entities.readProject).toHaveBeenCalledWith({
    environmentId: "other",
    projectId: "project",
  });
  useRightPanelStore.getState().close(ref);
  expect(readThreadReference(ref)).toBe(linkedUrl);
});

it("falls back to the thread ID without a usable MR and ignores other threads' panels", () => {
  entities.readThreadShell.mockReturnValue({ linkedPullRequest: null });
  const other = scopeThreadRef(ref.environmentId, ThreadId.make("other-thread"));
  useRightPanelStore
    .getState()
    .openPullRequest(other, { projectId: "project", repository: "group/project", number: 2 });
  expect(readThreadReference(ref)).toBe("thread");
  expect(entities.readProject).not.toHaveBeenCalled();
});
