import { EnvironmentId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  observeProactivePanelUserChoice,
  shouldRetargetThreadPullRequestPanel,
  resolveProactiveTurnDiffAction,
  shouldOpenProactiveTurnDiff,
} from "./components/ChatView.logic";
import {
  useRightPanelStore,
  pullRequestSurface,
  selectActiveRightPanelSurface,
} from "./rightPanelStore";
const ref = scopeThreadRef(EnvironmentId.make("workspace"), ThreadId.make("thread"));
beforeEach(() =>
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} }),
);
describe("proactive panels", () => {
  it("rejects a deferred opening after a manual choice, but allows the next turn", () => {
    const panels = useRightPanelStore.getState();
    const first = TurnId.make("first");
    const observed = observeProactivePanelUserChoice(null, {
      threadKey: "thread",
      runningTurnId: first,
      userActionRevision: panels.getUserActionRevision(ref),
    });
    panels.open(ref, "files");
    expect(
      panels.openProactive(ref, { id: "diff", kind: "diff" }, observed.userActionRevision),
    ).toBe(false);
    const next = observeProactivePanelUserChoice(observed, {
      threadKey: "thread",
      runningTurnId: TurnId.make("next"),
      userActionRevision: panels.getUserActionRevision(ref),
    });
    expect(panels.openProactive(ref, { id: "diff", kind: "diff" }, next.userActionRevision)).toBe(
      true,
    );
  });
  it("does not override a merge request with a completed-turn diff", () => {
    const panels = useRightPanelStore.getState();
    const revision = panels.getUserActionRevision(ref);
    expect(
      panels.openProactive(
        ref,
        pullRequestSurface({ projectId: "project", repository: "group/repo", number: 1 }),
        revision,
      ),
    ).toBe(true);
    expect(panels.openProactive(ref, { id: "diff", kind: "diff" }, revision)).toBe(false);
    panels.close(ref);
    expect(panels.openProactive(ref, { id: "diff", kind: "diff" }, revision)).toBe(false);
  });
  it("waits for metadata, ignores empty diffs, and only opens completed turns", () => {
    expect(resolveProactiveTurnDiffAction({ checkpoint: undefined, isGitRepo: true })).toBe(
      "defer",
    );
    expect(
      resolveProactiveTurnDiffAction({
        checkpoint: { status: "ready", files: [] },
        isGitRepo: true,
      }),
    ).toBe("ignore");
    expect(
      shouldOpenProactiveTurnDiff({
        previousRunningTurnId: TurnId.make("old"),
        runningTurnId: null,
        settledTurnId: TurnId.make("other"),
        turnCompleted: true,
      }),
    ).toBe(false);
    expect(
      shouldOpenProactiveTurnDiff({
        previousRunningTurnId: TurnId.make("old"),
        runningTurnId: null,
        settledTurnId: TurnId.make("old"),
        turnCompleted: true,
      }),
    ).toBe(true);
  });
});

it("retargets only the currently selected linked request and still respects a later manual choice", () => {
  const panels = useRightPanelStore.getState();
  const previous = {
    projectId: ProjectId.make("project"),
    repository: "Group/Repo",
    number: 1,
    url: "https://gitlab.test/1",
  };
  const current = { ...previous, number: 2, url: "https://gitlab.test/2" };
  panels.openPullRequest(ref, { ...previous, environmentId: ref.environmentId });
  const revision = panels.getUserActionRevision(ref);
  const surface = selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, ref);
  expect(shouldRetargetThreadPullRequestPanel(previous, current, surface)).toBe(true);
  // This selected-link rule is independent of the proactive-panels setting.
  expect(
    panels.openProactive(
      ref,
      pullRequestSurface({ ...current, environmentId: ref.environmentId }),
      revision,
    ),
  ).toBe(true);
  expect(
    shouldRetargetThreadPullRequestPanel(previous, current, {
      ...surface!,
      kind: "diff",
      id: "diff",
    }),
  ).toBe(false);
  expect(
    shouldRetargetThreadPullRequestPanel(
      previous,
      { ...previous, repository: "group/repo" },
      surface,
    ),
  ).toBe(false);
  panels.close(ref);
  expect(
    panels.openProactive(
      ref,
      pullRequestSurface({ ...previous, environmentId: ref.environmentId }),
      revision,
    ),
  ).toBe(false);
});
