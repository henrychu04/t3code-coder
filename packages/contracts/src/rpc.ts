import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import {
  GitCommandError,
  GitManagerServiceError,
  VcsCreateRefInput,
  VcsCreateRefResult,
  VcsCreateWorktreeInput,
  VcsCreateWorktreeResult,
  VcsInitInput,
  VcsListRefsInput,
  VcsListRefsResult,
  VcsRemoveWorktreeInput,
  VcsRefStatusStreamEvent,
  VcsRenameThreadBranchError,
  VcsRenameThreadBranchInput,
  VcsRenameThreadBranchResult,
  VcsStatusInput,
  VcsStatusResult,
  VcsStatusStreamEvent,
  VcsSwitchRefInput,
  VcsSwitchRefResult,
} from "./git.ts";
import {
  ClientOrchestrationCommand,
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnDiffError,
  OrchestrationGetTurnDiffInput,
  OrchestrationRpcSchemas,
  OrchestrationSearchThreadsError,
  OrchestrationSearchThreadsInput,
} from "./orchestration.ts";
import {
  ProjectSearchEntriesError,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  WorkspaceListDirectoriesError,
  WorkspaceListDirectoriesInput,
  WorkspaceListDirectoriesResult,
} from "./project.ts";
import {
  ReviewDiffFileContentsInput,
  ReviewDiffFileContentsResult,
  ReviewDiffFileChunkInput,
  ReviewDiffFileChunkResult,
  ReviewDiffFileSnapshotResult,
  ReviewDiffPreviewError,
  ReviewDiffPreviewInput,
  ReviewDiffPreviewResult,
} from "./review.ts";
import {
  ServerConfig,
  ServerConfigStreamEvent,
  ServerLifecycleStreamEvent,
  ServerProviderSlashCommands,
  ServerProviderSlashCommandsInput,
} from "./server.ts";
import { ServerSettings, ServerSettingsError, ServerSettingsPatch } from "./settings.ts";
import {
  TerminalAttachInput,
  TerminalAttachStreamEvent,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalError,
  TerminalEvent,
  TerminalMetadataStreamEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal.ts";
import { VcsError } from "./vcs.ts";
import {
  ScreenshotArtifactChunk,
  ScreenshotArtifactReadError,
  ScreenshotArtifactReadInput,
} from "./screenshotArtifact.ts";

export const WS_METHODS = {
  projectsSearchEntries: "projects.searchEntries",
  workspaceListDirectories: "workspace.listDirectories",
  workspaceReadScreenshotArtifact: "workspace.readScreenshotArtifact",
  providerListSlashCommands: "provider.listSlashCommands",
  vcsRefreshStatus: "vcs.refreshStatus",
  vcsListRefs: "vcs.listRefs",
  vcsCreateWorktree: "vcs.createWorktree",
  vcsRemoveWorktree: "vcs.removeWorktree",
  vcsCreateRef: "vcs.createRef",
  vcsSwitchRef: "vcs.switchRef",
  vcsRenameThreadBranch: "vcs.renameThreadBranch",
  vcsInit: "vcs.init",
  reviewGetDiffPreview: "review.getDiffPreview",
  reviewGetDiffFileContents: "review.getDiffFileContents",
  reviewOpenDiffFileContents: "review.openDiffFileContents",
  reviewReadDiffFileChunk: "review.readDiffFileChunk",
  terminalOpen: "terminal.open",
  terminalAttach: "terminal.attach",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",
  serverProbe: "server.probe",
  serverGetConfig: "server.getConfig",
  serverGetSettings: "server.getSettings",
  serverUpdateSettings: "server.updateSettings",
  subscribeVcsStatus: "subscribeVcsStatus",
  subscribeVcsRefStatus: "subscribeVcsRefStatus",
  subscribeTerminalEvents: "subscribeTerminalEvents",
  subscribeTerminalMetadata: "subscribeTerminalMetadata",
  subscribeServerConfig: "subscribeServerConfig",
  subscribeServerLifecycle: "subscribeServerLifecycle",
} as const;

const WsServerProbeRpc = Rpc.make(WS_METHODS.serverProbe, {
  payload: Schema.Struct({}),
  success: Schema.Struct({}),
});

const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: ServerConfig,
  error: ServerSettingsError,
});

const WsServerGetSettingsRpc = Rpc.make(WS_METHODS.serverGetSettings, {
  payload: Schema.Struct({}),
  success: ServerSettings,
  error: ServerSettingsError,
});

const WsServerUpdateSettingsRpc = Rpc.make(WS_METHODS.serverUpdateSettings, {
  payload: Schema.Struct({ patch: ServerSettingsPatch }),
  success: ServerSettings,
  error: ServerSettingsError,
});

const WsProjectsSearchEntriesRpc = Rpc.make(WS_METHODS.projectsSearchEntries, {
  payload: ProjectSearchEntriesInput,
  success: ProjectSearchEntriesResult,
  error: ProjectSearchEntriesError,
});

const WsWorkspaceListDirectoriesRpc = Rpc.make(WS_METHODS.workspaceListDirectories, {
  payload: WorkspaceListDirectoriesInput,
  success: WorkspaceListDirectoriesResult,
  error: WorkspaceListDirectoriesError,
});

const WsWorkspaceReadScreenshotArtifactRpc = Rpc.make(WS_METHODS.workspaceReadScreenshotArtifact, {
  payload: ScreenshotArtifactReadInput,
  success: ScreenshotArtifactChunk,
  error: ScreenshotArtifactReadError,
});

const WsProviderListSlashCommandsRpc = Rpc.make(WS_METHODS.providerListSlashCommands, {
  payload: ServerProviderSlashCommandsInput,
  success: ServerProviderSlashCommands,
});

const WsSubscribeVcsStatusRpc = Rpc.make(WS_METHODS.subscribeVcsStatus, {
  payload: VcsStatusInput,
  success: VcsStatusStreamEvent,
  error: GitManagerServiceError,
  stream: true,
});

const WsSubscribeVcsRefStatusRpc = Rpc.make(WS_METHODS.subscribeVcsRefStatus, {
  payload: VcsStatusInput,
  success: VcsRefStatusStreamEvent,
  error: GitManagerServiceError,
  stream: true,
});

const WsVcsRefreshStatusRpc = Rpc.make(WS_METHODS.vcsRefreshStatus, {
  payload: VcsStatusInput,
  success: VcsStatusResult,
  error: GitManagerServiceError,
});

const WsVcsListRefsRpc = Rpc.make(WS_METHODS.vcsListRefs, {
  payload: VcsListRefsInput,
  success: VcsListRefsResult,
  error: GitCommandError,
});

const WsVcsCreateWorktreeRpc = Rpc.make(WS_METHODS.vcsCreateWorktree, {
  payload: VcsCreateWorktreeInput,
  success: VcsCreateWorktreeResult,
  error: GitCommandError,
});

const WsVcsRemoveWorktreeRpc = Rpc.make(WS_METHODS.vcsRemoveWorktree, {
  payload: VcsRemoveWorktreeInput,
  error: GitCommandError,
});

const WsVcsCreateRefRpc = Rpc.make(WS_METHODS.vcsCreateRef, {
  payload: VcsCreateRefInput,
  success: VcsCreateRefResult,
  error: GitCommandError,
});

const WsVcsSwitchRefRpc = Rpc.make(WS_METHODS.vcsSwitchRef, {
  payload: VcsSwitchRefInput,
  success: VcsSwitchRefResult,
  error: GitCommandError,
});

const WsVcsRenameThreadBranchRpc = Rpc.make(WS_METHODS.vcsRenameThreadBranch, {
  payload: VcsRenameThreadBranchInput,
  success: VcsRenameThreadBranchResult,
  error: VcsRenameThreadBranchError,
});

const WsVcsInitRpc = Rpc.make(WS_METHODS.vcsInit, {
  payload: VcsInitInput,
  error: VcsError,
});

const WsReviewGetDiffPreviewRpc = Rpc.make(WS_METHODS.reviewGetDiffPreview, {
  payload: ReviewDiffPreviewInput,
  success: ReviewDiffPreviewResult,
  error: ReviewDiffPreviewError,
});

const WsReviewGetDiffFileContentsRpc = Rpc.make(WS_METHODS.reviewGetDiffFileContents, {
  payload: ReviewDiffFileContentsInput,
  success: ReviewDiffFileContentsResult,
  error: ReviewDiffPreviewError,
});

const WsReviewOpenDiffFileContentsRpc = Rpc.make(WS_METHODS.reviewOpenDiffFileContents, {
  payload: ReviewDiffFileContentsInput,
  success: ReviewDiffFileSnapshotResult,
  error: ReviewDiffPreviewError,
});

const WsReviewReadDiffFileChunkRpc = Rpc.make(WS_METHODS.reviewReadDiffFileChunk, {
  payload: ReviewDiffFileChunkInput,
  success: ReviewDiffFileChunkResult,
  error: ReviewDiffPreviewError,
});

const WsTerminalOpenRpc = Rpc.make(WS_METHODS.terminalOpen, {
  payload: TerminalOpenInput,
  success: TerminalSessionSnapshot,
  error: TerminalError,
});

const WsTerminalAttachRpc = Rpc.make(WS_METHODS.terminalAttach, {
  payload: TerminalAttachInput,
  success: TerminalAttachStreamEvent,
  error: TerminalError,
  stream: true,
});

const WsTerminalWriteRpc = Rpc.make(WS_METHODS.terminalWrite, {
  payload: TerminalWriteInput,
  error: TerminalError,
});

const WsTerminalResizeRpc = Rpc.make(WS_METHODS.terminalResize, {
  payload: TerminalResizeInput,
  error: TerminalError,
});

const WsTerminalClearRpc = Rpc.make(WS_METHODS.terminalClear, {
  payload: TerminalClearInput,
  error: TerminalError,
});

const WsTerminalRestartRpc = Rpc.make(WS_METHODS.terminalRestart, {
  payload: TerminalRestartInput,
  success: TerminalSessionSnapshot,
  error: TerminalError,
});

const WsTerminalCloseRpc = Rpc.make(WS_METHODS.terminalClose, {
  payload: TerminalCloseInput,
  error: TerminalError,
});

const WsSubscribeTerminalEventsRpc = Rpc.make(WS_METHODS.subscribeTerminalEvents, {
  payload: Schema.Struct({}),
  success: TerminalEvent,
  stream: true,
});

const WsSubscribeTerminalMetadataRpc = Rpc.make(WS_METHODS.subscribeTerminalMetadata, {
  payload: Schema.Struct({}),
  success: TerminalMetadataStreamEvent,
  stream: true,
});

const WsSubscribeServerConfigRpc = Rpc.make(WS_METHODS.subscribeServerConfig, {
  payload: Schema.Struct({}),
  success: ServerConfigStreamEvent,
  error: ServerSettingsError,
  stream: true,
});

const WsSubscribeServerLifecycleRpc = Rpc.make(WS_METHODS.subscribeServerLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  stream: true,
});

const WsOrchestrationDispatchCommandRpc = Rpc.make(ORCHESTRATION_WS_METHODS.dispatchCommand, {
  payload: ClientOrchestrationCommand,
  success: OrchestrationRpcSchemas.dispatchCommand.output,
  error: OrchestrationDispatchCommandError,
});

const WsOrchestrationGetTurnDiffRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getTurnDiff, {
  payload: OrchestrationGetTurnDiffInput,
  success: OrchestrationRpcSchemas.getTurnDiff.output,
  error: OrchestrationGetTurnDiffError,
});

const WsOrchestrationGetFullThreadDiffRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getFullThreadDiff, {
  payload: OrchestrationGetFullThreadDiffInput,
  success: OrchestrationRpcSchemas.getFullThreadDiff.output,
  error: OrchestrationGetFullThreadDiffError,
});

const WsOrchestrationSearchThreadsRpc = Rpc.make(ORCHESTRATION_WS_METHODS.searchThreads, {
  payload: OrchestrationSearchThreadsInput,
  success: OrchestrationRpcSchemas.searchThreads.output,
  error: OrchestrationSearchThreadsError,
});

const WsOrchestrationGetArchivedShellSnapshotRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
  {
    payload: OrchestrationRpcSchemas.getArchivedShellSnapshot.input,
    success: OrchestrationRpcSchemas.getArchivedShellSnapshot.output,
    error: OrchestrationGetSnapshotError,
  },
);

const WsOrchestrationGetThreadSnapshotRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getThreadSnapshot, {
  payload: OrchestrationRpcSchemas.getThreadSnapshot.input,
  success: OrchestrationRpcSchemas.getThreadSnapshot.output,
  error: OrchestrationGetSnapshotError,
});

const WsOrchestrationSubscribeShellRpc = Rpc.make(ORCHESTRATION_WS_METHODS.subscribeShell, {
  payload: OrchestrationRpcSchemas.subscribeShell.input,
  success: OrchestrationRpcSchemas.subscribeShell.output,
  error: OrchestrationGetSnapshotError,
  stream: true,
});

const WsOrchestrationSubscribeThreadRpc = Rpc.make(ORCHESTRATION_WS_METHODS.subscribeThread, {
  payload: OrchestrationRpcSchemas.subscribeThread.input,
  success: OrchestrationRpcSchemas.subscribeThread.output,
  error: OrchestrationGetSnapshotError,
  stream: true,
});

export const CoderWsRpcGroup = RpcGroup.make(
  WsServerProbeRpc,
  WsServerGetConfigRpc,
  WsServerGetSettingsRpc,
  WsServerUpdateSettingsRpc,
  WsProjectsSearchEntriesRpc,
  WsWorkspaceListDirectoriesRpc,
  WsWorkspaceReadScreenshotArtifactRpc,
  WsProviderListSlashCommandsRpc,
  WsSubscribeVcsStatusRpc,
  WsSubscribeVcsRefStatusRpc,
  WsVcsRefreshStatusRpc,
  WsVcsListRefsRpc,
  WsVcsCreateWorktreeRpc,
  WsVcsRemoveWorktreeRpc,
  WsVcsCreateRefRpc,
  WsVcsSwitchRefRpc,
  WsVcsRenameThreadBranchRpc,
  WsVcsInitRpc,
  WsReviewGetDiffPreviewRpc,
  WsReviewGetDiffFileContentsRpc,
  WsReviewOpenDiffFileContentsRpc,
  WsReviewReadDiffFileChunkRpc,
  WsTerminalOpenRpc,
  WsTerminalAttachRpc,
  WsTerminalWriteRpc,
  WsTerminalResizeRpc,
  WsTerminalClearRpc,
  WsTerminalRestartRpc,
  WsTerminalCloseRpc,
  WsSubscribeTerminalEventsRpc,
  WsSubscribeTerminalMetadataRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerLifecycleRpc,
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationGetTurnDiffRpc,
  WsOrchestrationGetFullThreadDiffRpc,
  WsOrchestrationSearchThreadsRpc,
  WsOrchestrationGetArchivedShellSnapshotRpc,
  WsOrchestrationGetThreadSnapshotRpc,
  WsOrchestrationSubscribeShellRpc,
  WsOrchestrationSubscribeThreadRpc,
);
