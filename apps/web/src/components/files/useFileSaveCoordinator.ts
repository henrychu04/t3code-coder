import type { EnvironmentId, ProjectWriteFileResult, ThreadId } from "@t3tools/contracts";
import { createRef, useEffect, useMemo, useRef } from "react";

import { projectEnvironment } from "~/state/projects";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { FileSaveCoordinator } from "./fileSaveCoordinator";
import {
  confirmProjectFileQueryData,
  getUnsavedProjectFileQueryData,
} from "./projectFilesQueryState";

const FILE_SAVE_DEBOUNCE_MS = 500;

interface FileSaveOptions {
  environmentId: EnvironmentId;
  // Coder: writes name the owning thread and the revision the edit is based on.
  threadId: ThreadId;
  revision: string;
  cwd: string;
  relativePath: string;
  onPendingChange: (relativePath: string, pending: boolean) => void;
  onSaveFailed: (relativePath: string) => void;
}

export function useFileSaveCoordinator({
  environmentId,
  threadId,
  revision,
  cwd,
  relativePath,
  onPendingChange,
  onSaveFailed,
}: FileSaveOptions): Pick<FileSaveCoordinator, "change"> {
  const canWriteFiles = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const writeFile = useAtomCommand(projectEnvironment.writeFile);
  // Coder: the base revision of the open file. It is tagged with the file identity so a write
  // confirmed for a retired file cannot leak its revision into the next file's writes.
  const fileKey = JSON.stringify([environmentId, threadId, cwd, relativePath]);
  const revisionRef = useRef({ fileKey, revision });
  useEffect(() => {
    revisionRef.current = { fileKey, revision };
  }, [fileKey, revision]);
  const session = useMemo(() => {
    const coordinatorRef = createRef<FileSaveCoordinator<ProjectWriteFileResult>>();
    const sessionFileKey = JSON.stringify([environmentId, threadId, cwd, relativePath]);
    // The revision this session last used, so a retired session's retry keeps its own file's.
    const sessionRevision: { current: string | undefined } = { current: undefined };
    const currentRevision = () => {
      if (revisionRef.current.fileKey === sessionFileKey) {
        sessionRevision.current = revisionRef.current.revision;
      }
      return sessionRevision.current ?? revisionRef.current.revision;
    };
    return {
      change: (contents: string) => coordinatorRef.current?.change(contents),
      setup: () => {
        // Coder: a retired editor still retries its pending edit on close, as upstream does,
        // but its failure must not flag the surface that replaced it.
        let active = true;
        const coordinator = new FileSaveCoordinator<ProjectWriteFileResult>({
          debounceMs: FILE_SAVE_DEBOUNCE_MS,
          canPersist: () => readEnvironmentScope(environmentId, AuthFilesystemWriteScope),
          onPendingChange: (pending) => onPendingChange(relativePath, pending),
          onFailed: () => {
            if (active) onSaveFailed(relativePath);
          },
          persist: (nextContents) =>
            writeFile({
              environmentId,
              input: {
                threadId,
                cwd,
                relativePath,
                contents: nextContents,
                expectedRevision: currentRevision(),
              },
            }),
          onConfirmed: (confirmedContents, result) => {
            sessionRevision.current = result.revision;
            if (revisionRef.current.fileKey === sessionFileKey) {
              revisionRef.current = { fileKey: sessionFileKey, revision: result.revision };
            }
            confirmProjectFileQueryData(
              environmentId,
              threadId,
              cwd,
              relativePath,
              confirmedContents,
              result.revision,
            );
          },
        });
        coordinatorRef.current = coordinator;
        return () => {
          active = false;
          coordinatorRef.current = null;
          coordinator.dispose();
        };
      },
    };
  }, [cwd, environmentId, onPendingChange, onSaveFailed, relativePath, threadId, writeFile]);

  // StrictMode replays effect setup. Retired file sessions stay inert, while the
  // replay gets a fresh coordinator instead of reusing a disposed one.
  useEffect(session.setup, [session]);
  useEffect(() => {
    if (!canWriteFiles) return;
    let cancelled = false;
    // Replay must retire the first session before recovery queues a draft to flush.
    queueMicrotask(() => {
      if (cancelled) return;
      const unsaved = getUnsavedProjectFileQueryData(environmentId, cwd, relativePath);
      if (unsaved) session.change(unsaved.contents);
    });
    return () => {
      cancelled = true;
    };
  }, [canWriteFiles, cwd, environmentId, relativePath, session]);
  return session;
}
