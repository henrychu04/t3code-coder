import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  selectActiveRightPanel,
  selectActiveRightPanelSurface,
  selectThreadRightPanelState,
  pullRequestSurface,
  updatePullRequestTabStatus,
  useRightPanelStore,
} from "./rightPanelStore";

const threadRef = scopeThreadRef(
  EnvironmentId.make("test-environment"),
  ThreadId.make("test-thread"),
);

describe("rightPanelStore files", () => {
  beforeEach(() =>
    useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} }),
  );

  it("replaces the standalone explorer with file tabs and reuses an open file", () => {
    const store = useRightPanelStore.getState();
    store.open(threadRef, "files");
    store.openFile(threadRef, "src/index.ts", 12);
    store.openFile(threadRef, "README.md");
    store.openFile(threadRef, "src/index.ts", 20);

    const state = Object.values(useRightPanelStore.getState().byThreadKey)[0]!;
    expect(state.surfaces.map((surface) => surface.id)).toEqual([
      "file:src/index.ts",
      "file:README.md",
    ]);
    expect(state.activeSurfaceId).toBe("file:src/index.ts");
    expect(state.surfaces[0]).toMatchObject({
      relativePath: "src/index.ts",
      revealLine: 20,
      revealRequestId: 2,
    });
  });

  it("opens arbitrary GitLab merge requests as independent surfaces", () => {
    const store = useRightPanelStore.getState();
    store.openPullRequest(threadRef, {
      projectId: "project-1",
      repository: "group/project",
      number: 41,
    });
    store.openPullRequest(threadRef, {
      projectId: "project-1",
      repository: "group/project",
      number: 42,
    });

    const state = Object.values(useRightPanelStore.getState().byThreadKey)[0]!;
    expect(state.surfaces.map((surface) => surface.id)).toEqual([
      "pull-request:project-1:group%2Fproject:41",
      "pull-request:project-1:group%2Fproject:42",
    ]);
    expect(state.activeSurfaceId).toBe("pull-request:project-1:group%2Fproject:42");
  });

  it("keeps the same merge request from two Coder workspaces in separate tabs", () => {
    const store = useRightPanelStore.getState();
    store.openPullRequest(threadRef, {
      environmentId: "workspace-a",
      projectId: "project-1",
      repository: "group/project",
      number: 42,
    });
    store.openPullRequest(threadRef, {
      environmentId: "workspace-b",
      projectId: "project-1",
      repository: "group/project",
      number: 42,
    });

    const state = Object.values(useRightPanelStore.getState().byThreadKey)[0]!;
    expect(state.surfaces.map((surface) => surface.id)).toEqual([
      "pull-request:workspace-a:project-1:group%2Fproject:42",
      "pull-request:workspace-b:project-1:group%2Fproject:42",
    ]);
  });

  it("keys a tab status by the concrete merge-request surface id", () => {
    const surface = pullRequestSurface({
      environmentId: "workspace-a",
      projectId: "project-1",
      repository: "group/project",
      number: 42,
    });
    const status = { state: "merged" as const, isDraft: false };
    const statuses = updatePullRequestTabStatus({}, surface.id, status);

    expect(statuses).toEqual({ [surface.id]: status });
    expect(updatePullRequestTabStatus(statuses, surface.id, status)).toBe(statuses);
  });
});

const refA = threadRef;
const refB = scopeThreadRef(threadRef.environmentId, ThreadId.make("thread-B"));
describe("rightPanelStore", () => {
  const completedDiff = { id: "diff", kind: "diff" } as const;
  const linkedPullRequest = pullRequestSurface({
    projectId: "project-a",
    repository: "pingdotgg/t3code",
    number: 42,
  });

  it.each(["diff-first", "pull-request-first"])(
    "prioritizes the linked pull request over browser and diff with %s delivery",
    (order) => {
      const store = useRightPanelStore.getState();
      store.open(refA, "files");
      const revision = store.getUserActionRevision(refA);
      const requests =
        order === "diff-first"
          ? [completedDiff, linkedPullRequest]
          : [linkedPullRequest, completedDiff];
      for (const surface of requests) store.openProactive(refA, surface, revision);

      expect(
        selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, refA),
      ).toEqual(linkedPullRequest);

      store.open(refA, "diff");
      expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("diff");
    },
  );

  it.each([
    { choice: "file", choose: () => useRightPanelStore.getState().openFile(refA, "src/app.ts") },
    {
      choice: "pull request",
      choose: () =>
        useRightPanelStore.getState().openPullRequest(refA, { ...linkedPullRequest, number: 41 }),
    },

    {
      choice: "terminal",
      choose: () => useRightPanelStore.getState().openTerminal(refA, "term-1"),
    },
    {
      choice: "same tab",
      choose: () => useRightPanelStore.getState().activateSurface(refA, "diff"),
    },
    { choice: "hide", choose: () => useRightPanelStore.getState().close(refA) },
    { choice: "toggle", choose: () => useRightPanelStore.getState().toggle(refA, "diff") },
    { choice: "close all", choose: () => useRightPanelStore.getState().closeAllSurfaces(refA) },
    {
      choice: "terminal close",
      choose: () => {
        const store = useRightPanelStore.getState();
        store.openTerminal(refA, "term-1");
        store.closeTerminal(refA, "terminal:term-1", "term-1");
      },
    },
  ])("keeps a later $choice choice when automatic requests arrive", ({ choose }) => {
    const store = useRightPanelStore.getState();
    store.open(refA, "diff");
    const revision = store.getUserActionRevision(refA);
    choose();
    const chosen = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);

    expect(store.openProactive(refA, completedDiff, revision)).toBe(false);
    expect(store.openProactive(refA, linkedPullRequest, revision)).toBe(false);
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toBe(
      chosen,
    );
  });

  it("allows automatic panels for a later turn after a manual choice", () => {
    const store = useRightPanelStore.getState();
    const firstTurnRevision = store.getUserActionRevision(refA);
    store.openFile(refA, "src/app.ts");
    expect(store.openProactive(refA, completedDiff, firstTurnRevision)).toBe(false);

    const nextTurnRevision = store.getUserActionRevision(refA);
    expect(store.openProactive(refA, completedDiff, nextTurnRevision)).toBe(true);
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refA)).toBe("diff");
  });

  it("keeps manual choices scoped to their thread and environment", () => {
    const otherEnvironment = scopeThreadRef("env-2" as EnvironmentId, refA.threadId);
    const store = useRightPanelStore.getState();
    const revision = store.getUserActionRevision(refA);
    store.openFile(refB, "src/app.ts");
    store.openFile(otherEnvironment, "src/app.ts");

    expect(store.openProactive(refA, completedDiff, revision)).toBe(true);
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, refB)).toBe("file");
    expect(
      selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, otherEnvironment),
    ).toBe("file");
  });
});
