// Upstream's RightPanelSurfaceContent. Coder: there are no browser or device surfaces, file
// surfaces read through the helper (sent attachments preview in memory), and pull request copy
// names GitLab merge requests. See docs/internals/coder-only.md.
import type {
  EnvironmentId,
  ProjectId,
  ScopedThreadRef,
  ThreadLinkedPullRequest,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { lazy, Suspense } from "react";
import type { DraftId } from "../../composerDraftStore";
import type { ShortcutMatchContext } from "../../keybindings";
import { type RightPanelSurface, useRightPanelStore } from "../../rightPanelStore";
import {
  PersistentThreadTerminalPanel,
  type PersistentThreadTerminalPanelProps,
} from "../PersistentThreadTerminals";
import { pullRequestPanelContext } from "../pullRequest/pullRequestDetail.logic";
import { PullRequestDetailPanel } from "../pullRequest/PullRequestDetailPanel";
import { PullRequestDetailGhost } from "../pullRequest/PullRequestGhosts";
import { PullRequestsUnavailableState } from "../pullRequest/PullRequestsUnavailableState";
import { ThreadPullRequestsPanel } from "../pullRequest/ThreadPullRequestsPanel";
import { SentAttachmentFilePreview } from "../files/SentAttachmentFilePreview";

const DiffPanel = lazy(() => import("../DiffPanel"));
const FilePreviewPanel = lazy(() => import("../files/FilePreviewPanel"));

export type RightPanelTerminalProps = Omit<
  PersistentThreadTerminalPanelProps,
  "visible" | "threadRef" | "surface"
>;

export interface RightPanelPullRequestProps {
  readonly capabilityKnown: boolean;
  readonly supported: boolean;
  readonly projectId: ProjectId | null;
  readonly pullRequests: ReadonlyArray<ThreadPullRequestLink>;
  readonly linkedPullRequest: ThreadLinkedPullRequest | null;
  readonly branchPullRequest: ThreadLinkedPullRequest | null | undefined;
  /** Back to the pull request list; absent when there is no list to go back to. */
  readonly onBack: (() => void) | undefined;
}

export interface RightPanelFileProps {
  // Coder: a draft names its project so the helper can verify the root it reads.
  readonly projectId: ProjectId | null;
  readonly projectName: string | null;
  readonly workspaceRoot: string | undefined;
  readonly pendingSurfaceIds: ReadonlySet<string>;
  readonly onOpenFile: (relativePath: string) => void;
  readonly onPendingChange: (relativePath: string, pending: boolean) => void;
}

/** The body of the thread's right panel for the surface it is showing. */
export function RightPanelSurfaceContent(props: {
  readonly surface: RightPanelSurface | null;
  readonly activeSurfaceId: string | null;
  readonly threadRef: ScopedThreadRef;
  readonly environmentId: EnvironmentId;
  readonly visible: boolean;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  readonly workspaceMutationId: string | null;
  readonly getShortcutContext: () => ShortcutMatchContext;
  readonly terminal: RightPanelTerminalProps;
  readonly pullRequest: RightPanelPullRequestProps;
  readonly files: RightPanelFileProps;
}) {
  const { surface, threadRef, visible } = props;
  if (surface === null) return null;
  switch (surface.kind) {
    // Coder: there is no in-app browser or device preview.
    case "preview":
    case "device":
      return null;
    case "terminal":
      return (
        <PersistentThreadTerminalPanel
          {...props.terminal}
          visible={visible}
          threadRef={threadRef}
          surface={surface}
        />
      );
    case "diff":
      return (
        <Suspense fallback={null}>
          <DiffPanel
            key={scopedThreadKey(threadRef)}
            mode="embedded"
            composerDraftTarget={props.composerDraftTarget}
            onOpenFile={props.files.onOpenFile}
            workspaceMutationId={props.workspaceMutationId}
          />
        </Suspense>
      );
    case "pull-request": {
      const pullRequest = props.pullRequest;
      if (!pullRequest.capabilityKnown) return <PullRequestDetailGhost />;
      if (!pullRequest.supported) {
        return (
          <PullRequestsUnavailableState
            title="Merge requests unavailable"
            error="Update this Coder workspace's T3 server to browse GitLab merge requests."
          />
        );
      }
      return (
        <PullRequestDetailPanel
          getShortcutContext={props.getShortcutContext}
          shortcutsEnabled={visible && props.activeSurfaceId === surface.id}
          key={`${surface.host ?? ""}:${surface.repository}#${surface.number}`}
          environmentId={props.environmentId}
          onSelectPullRequest={(reference) => {
            useRightPanelStore.getState().openPullRequest(threadRef, {
              projectId: reference.projectId,
              repository: reference.repository,
              number: reference.number,
              ...(reference.host ? { host: reference.host } : {}),
            });
          }}
          threadRef={threadRef}
          reference={{
            projectId: surface.projectId as ProjectId,
            ...(surface.host ? { host: surface.host } : {}),
            repository: surface.repository,
            number: surface.number,
          }}
          context={pullRequestPanelContext(
            {
              projectId: pullRequest.projectId,
              pullRequests: pullRequest.pullRequests,
              linkedPullRequest: pullRequest.linkedPullRequest,
              branchPullRequest: pullRequest.branchPullRequest,
            },
            surface,
          )}
          composerDraftTarget={props.composerDraftTarget}
          onBack={pullRequest.onBack}
        />
      );
    }
    case "pull-requests":
      return <ThreadPullRequestsPanel threadRef={threadRef} />;
    case "files":
    case "file": {
      const files = props.files;
      const attachment = surface.kind === "file" ? surface.attachment : undefined;
      if (attachment) {
        // Coder: upstream's FilePreviewPanel shows only the attachment's preview in this mode;
        // the helper reads it into memory in place of the signed asset URL.
        return (
          <SentAttachmentFilePreview
            key={`${props.environmentId}:attachment:${attachment.id}`}
            environmentId={props.environmentId}
            attachment={attachment}
            threadRef={threadRef}
          />
        );
      }
      if (files.projectId === null || files.projectName === null || !files.workspaceRoot) {
        return null;
      }
      return (
        <Suspense fallback={null}>
          <FilePreviewPanel
            key={`${props.environmentId}:${files.workspaceRoot}`}
            environmentId={props.environmentId}
            cwd={files.workspaceRoot}
            projectName={files.projectName}
            threadRef={threadRef}
            projectId={files.projectId}
            composerDraftTarget={props.composerDraftTarget}
            relativePath={surface.kind === "file" ? surface.relativePath : null}
            revealLine={surface.kind === "file" ? (surface.revealLine ?? null) : null}
            revealRequestId={surface.kind === "file" ? surface.revealRequestId : 0}
            onOpenFile={files.onOpenFile}
            onNavigateFolder={(relativePath, folderTrail, keepSource) =>
              useRightPanelStore
                .getState()
                .navigateFolder(threadRef, surface.id, relativePath, folderTrail, keepSource)
            }
            folderTrail={surface.folderTrail}
            onPendingChange={files.onPendingChange}
            selectedFilePending={surface.kind === "file" && files.pendingSurfaceIds.has(surface.id)}
            workspaceMutationId={props.workspaceMutationId}
          />
        </Suspense>
      );
    }
  }
}
