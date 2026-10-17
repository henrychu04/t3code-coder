import {
  AuthFilesystemWriteScope,
  type EnvironmentId,
  type ProjectFilesOwner,
  type ProjectWriteFileResult,
} from "@t3tools/contracts";
import { createRef, useEffect, useState } from "react";

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
  // Coder: writes name their owner and the revision the edit is based on.
  owner: ProjectFilesOwner;
  revision: string;
  cwd: string;
  relativePath: string;
  onPendingChange: (relativePath: string, pending: boolean) => void;
  onSaveFailed: (relativePath: string) => void;
}

export function useFileSaveCoordinator({
  environmentId,
  owner,
  revision,
  cwd,
  relativePath,
  onPendingChange,
  onSaveFailed,
}: FileSaveOptions): Pick<FileSaveCoordinator, "change"> {
  const canWriteFiles = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const writeFile = useProjectFileWriter();
  // Coder: the base revision of the open file. It is tagged with the file identity so a write
  // confirmed for a retired file cannot leak its revision into the next file's writes.
  const fileKey = JSON.stringify([environmentId, owner, cwd, relativePath]);
  // Held in state rather than a ref so render can hand it to a new session.
  const [latestRevision] = useState(() => createRevisionTracker({ fileKey, revision }));
  useEffect(() => {
    latestRevision.write({ fileKey, revision });
  }, [fileKey, revision, latestRevision]);
  // A session owns the pending debounce, so it must outlive rerenders and be
  // replaced only when what it writes to changes.
  const inputs = {
    environmentId,
    owner,
    cwd,
    relativePath,
    onPendingChange,
    onSaveFailed,
    writeFile,
    latestRevision,
  };
  const [current, setCurrent] = useState(() => ({
    inputs,
    session: createFileSaveSession(inputs),
  }));
  if (
    current.inputs.environmentId !== environmentId ||
    current.inputs.owner !== owner ||
    current.inputs.cwd !== cwd ||
    current.inputs.relativePath !== relativePath ||
    current.inputs.onPendingChange !== onPendingChange ||
    current.inputs.onSaveFailed !== onSaveFailed ||
    current.inputs.writeFile !== writeFile
  ) {
    setCurrent({ inputs, session: createFileSaveSession(inputs) });
  }
  const session = current.session;

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

interface FileRevision {
  readonly fileKey: string;
  readonly revision: string;
}

function createRevisionTracker(initial: FileRevision) {
  let latest = initial;
  return {
    read: () => latest,
    write: (next: FileRevision) => {
      latest = next;
    },
  };
}

function useProjectFileWriter() {
  return useAtomCommand(projectEnvironment.writeFile);
}

function createFileSaveSession({
  environmentId,
  owner,
  cwd,
  relativePath,
  onPendingChange,
  onSaveFailed,
  writeFile,
  latestRevision,
}: Omit<FileSaveOptions, "revision"> & {
  writeFile: ReturnType<typeof useProjectFileWriter>;
  latestRevision: ReturnType<typeof createRevisionTracker>;
}) {
  const coordinatorRef = createRef<FileSaveCoordinator<ProjectWriteFileResult>>();
  const sessionFileKey = JSON.stringify([environmentId, owner, cwd, relativePath]);
  // The revision this session last used, so a retired session's retry keeps its own file's.
  const sessionRevision: { current: string | undefined } = { current: undefined };
  const currentRevision = () => {
    if (latestRevision.read().fileKey === sessionFileKey) {
      sessionRevision.current = latestRevision.read().revision;
    }
    return sessionRevision.current ?? latestRevision.read().revision;
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
              ...owner,
              cwd,
              relativePath,
              contents: nextContents,
              expectedRevision: currentRevision(),
            },
          }),
        onConfirmed: (confirmedContents, result) => {
          sessionRevision.current = result.revision;
          if (latestRevision.read().fileKey === sessionFileKey) {
            latestRevision.write({ fileKey: sessionFileKey, revision: result.revision });
          }
          return confirmProjectFileQueryData(
            environmentId,
            owner,
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
}
