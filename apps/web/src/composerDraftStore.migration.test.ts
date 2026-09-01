import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { COMPOSER_DRAFT_STORAGE_KEY, DraftId, useComposerDraftStore } from "./composerDraftStore";

function resetComposerDraftStore() {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
}

describe("composer draft persistence migration", () => {
  beforeEach(async () => {
    resetComposerDraftStore();
    await useComposerDraftStore.persist.clearStorage();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await useComposerDraftStore.persist.clearStorage();
  });

  it("clears branch and worktree state when a persisted draft changes projects", async () => {
    vi.useFakeTimers();
    const draftId = DraftId.make("draft-project-migration");
    const threadId = ThreadId.make("thread-project-migration");
    const oldEnvironmentId = EnvironmentId.make("environment-old");
    const newEnvironmentId = EnvironmentId.make("environment-new");
    const oldProjectId = ProjectId.make("project-old");
    const newProjectId = ProjectId.make("project-new");
    const logicalProjectKey = scopedProjectKey(scopeProjectRef(newEnvironmentId, newProjectId));
    const storage = useComposerDraftStore.persist.getOptions().storage;
    expect(storage).toBeDefined();

    storage?.setItem(COMPOSER_DRAFT_STORAGE_KEY, {
      version: 8,
      state: {
        draftsByThreadKey: {},
        draftThreadsByThreadKey: {
          [draftId]: {
            threadId,
            environmentId: oldEnvironmentId,
            projectId: oldProjectId,
            logicalProjectKey: "old-logical-project",
            createdAt: "2026-08-01T00:00:00.000Z",
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "old-project-branch",
            worktreePath: "/tmp/old-project-worktree",
            envMode: "worktree",
            startFromOrigin: true,
            promotedTo: null,
          },
        },
        logicalProjectDraftThreadKeyByLogicalProjectKey: {
          [logicalProjectKey]: draftId,
        },
        stickyModelSelectionByProvider: {},
        stickyActiveProvider: null,
      },
    } as never);
    await vi.advanceTimersByTimeAsync(300);

    await useComposerDraftStore.persist.rehydrate();

    expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
      environmentId: newEnvironmentId,
      projectId: newProjectId,
      logicalProjectKey,
      branch: null,
      worktreePath: null,
      envMode: "worktree",
      startFromOrigin: true,
    });
  });

  it("activates the Claude fallback for legacy sticky models without a provider", async () => {
    vi.useFakeTimers();
    const storage = useComposerDraftStore.persist.getOptions().storage;
    expect(storage).toBeDefined();

    storage?.setItem(COMPOSER_DRAFT_STORAGE_KEY, {
      version: 2,
      state: {
        draftsByThreadId: {},
        draftThreadsByThreadId: {},
        projectDraftThreadIdByProjectId: {},
        stickyModel: "claude-sonnet-4-6",
        stickyModelOptions: {},
      },
    } as never);
    await vi.advanceTimersByTimeAsync(300);

    await useComposerDraftStore.persist.rehydrate();

    const claudeAgent = ProviderInstanceId.make("claudeAgent");
    expect(useComposerDraftStore.getState()).toMatchObject({
      stickyActiveProvider: claudeAgent,
      stickyModelSelectionByProvider: {
        [claudeAgent]: {
          instanceId: claudeAgent,
          model: "claude-sonnet-4-6",
        },
      },
    });
  });
});
