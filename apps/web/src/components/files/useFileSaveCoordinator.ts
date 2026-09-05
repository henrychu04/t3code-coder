import type { EnvironmentId, ScopedThreadRef, ProjectWriteFileResult } from "@t3tools/contracts";
import { createRef, useEffect, useMemo } from "react";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { FileSaveCoordinator } from "./fileSaveCoordinator";
import { confirmProjectFileQueryData } from "./projectFilesQueryState";
import { confirmFileEditorSession } from "./fileEditorSessions";

interface FileSaveOptions {
  environmentId: EnvironmentId;
  threadRef: ScopedThreadRef;
  cwd: string;
  relativePath: string;
  revision: string;
  onPendingChange: (relativePath: string, pending: boolean) => void;
  onSaveFailed: (relativePath: string) => void;
}

export function useFileSaveCoordinator(input: FileSaveOptions) {
  const writeFile = useAtomCommand(projectEnvironment.writeFile);
  const { environmentId, threadRef, cwd, relativePath, onPendingChange, onSaveFailed } = input;
  const session = useMemo(() => {
    const revisionRef = { current: input.revision };
    const coordinatorRef = createRef<FileSaveCoordinator<ProjectWriteFileResult, unknown>>();
    return {
      updateRevision: (revision: string) => {
        revisionRef.current = revision;
      },
      change: (contents: string) => coordinatorRef.current?.change(contents),
      setup: () => {
        const coordinator = new FileSaveCoordinator<ProjectWriteFileResult, unknown>({
          debounceMs: 500,
          onPendingChange: (pending) => onPendingChange(relativePath, pending),
          onFailed: () => onSaveFailed(relativePath),
          persist: (contents) =>
            writeFile({
              environmentId,
              input: {
                threadId: threadRef.threadId,
                cwd,
                relativePath,
                contents,
                expectedRevision: revisionRef.current,
              },
            }),
          onConfirmed: (contents, result) => {
            revisionRef.current = result.revision;
            confirmFileEditorSession({ threadRef, cwd, relativePath }, contents, result.revision);
            confirmProjectFileQueryData(
              environmentId,
              threadRef.threadId,
              cwd,
              relativePath,
              contents,
              result.revision,
            );
          },
        });
        coordinatorRef.current = coordinator;
        return () => {
          coordinatorRef.current = null;
          coordinator.dispose();
        };
      },
    };
  }, [
    environmentId,
    threadRef.environmentId,
    threadRef.threadId,
    cwd,
    relativePath,
    onPendingChange,
    onSaveFailed,
    writeFile,
  ]);
  useEffect(() => session.updateRevision(input.revision), [session, input.revision]);
  // StrictMode setup replay needs a fresh coordinator; old file sessions remain inert.
  useEffect(session.setup, [session]);
  return session;
}
