import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectListEntriesResult,
  ProjectReadFileResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";

const EMPTY_PROJECT_FILE_PATH = "";
const EMPTY_PROJECT_FILE_QUERY_ATOM = Atom.make(
  AsyncResult.initial<ProjectReadFileResult, never>(false),
).pipe(Atom.withLabel("project-file-query:empty"));

function optimisticFileAtom(environmentId: EnvironmentId, cwd: string, relativePath: string) {
  return projectEnvironment.optimisticFile({ environmentId, cwd, relativePath });
}

interface ProjectQueryState<A> {
  readonly data: A | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

export function projectFileDataFromResult(
  result: AsyncResult.AsyncResult<ProjectReadFileResult, unknown>,
): ProjectReadFileResult | null {
  return result._tag === "Failure" ? null : Option.getOrNull(AsyncResult.value(result));
}

export function projectFileReadMatches(
  file: ProjectReadFileResult,
  contents: string,
  revision: string,
): boolean {
  return file.revision === revision && file.contents === contents;
}

export function getProjectEntriesQueryAtom(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  cwd: string,
) {
  return projectEnvironment.listEntries({ environmentId, input: { threadId, cwd } });
}

export function getProjectFileQueryAtom(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  cwd: string,
  relativePath: string | null,
) {
  return projectEnvironment.readFile({
    environmentId,
    input: { threadId, cwd, relativePath: relativePath ?? EMPTY_PROJECT_FILE_PATH },
  });
}

export function setProjectFileQueryData(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  cwd: string,
  relativePath: string,
  contents: string,
): void {
  const optimisticAtom = optimisticFileAtom(environmentId, cwd, relativePath);
  const queryAtom = getProjectFileQueryAtom(environmentId, threadId, cwd, relativePath);
  const currentOptimistic = appAtomRegistry.get(optimisticAtom)?.data;
  const currentQuery = Option.getOrNull(AsyncResult.value(appAtomRegistry.get(queryAtom)));
  const current = currentOptimistic ?? currentQuery;
  if (!current) return;
  appAtomRegistry.set(optimisticAtom, {
    confirmedAgainst: undefined,
    data: {
      ...current,
      contents,
      byteLength: new TextEncoder().encode(contents).byteLength,
      truncated: false,
    },
  });
}

export function getOptimisticProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): ProjectReadFileResult | null {
  return appAtomRegistry.get(optimisticFileAtom(environmentId, cwd, relativePath))?.data ?? null;
}

export function confirmProjectFileQueryData(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  cwd: string,
  relativePath: string,
  contents: string,
  revision: string,
): boolean {
  const atom = optimisticFileAtom(environmentId, cwd, relativePath);
  const optimisticFile = appAtomRegistry.get(atom);
  if (optimisticFile?.data.contents !== contents) return false;
  const queryAtom = getProjectFileQueryAtom(environmentId, threadId, cwd, relativePath);
  const confirmed = {
    confirmedAgainst: appAtomRegistry.get(queryAtom),
    data: { ...optimisticFile.data, revision },
  };
  appAtomRegistry.set(atom, confirmed);
  appAtomRegistry.refresh(queryAtom);
  void executeAtomQuery(appAtomRegistry, queryAtom, {
    reportDefect: false,
    reportFailure: false,
  }).then((result) => {
    const cached = projectFileDataFromResult(appAtomRegistry.get(queryAtom));
    if (
      result._tag === "Success" &&
      projectFileReadMatches(result.value, contents, revision) &&
      cached !== null &&
      projectFileReadMatches(cached, contents, revision) &&
      appAtomRegistry.get(atom) === confirmed
    ) {
      appAtomRegistry.set(atom, null);
    }
  });
  return true;
}

export function discardProjectFileQueryData(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  cwd: string,
  relativePath: string,
): void {
  const optimisticAtom = optimisticFileAtom(environmentId, cwd, relativePath);
  const queryAtom = getProjectFileQueryAtom(environmentId, threadId, cwd, relativePath);
  appAtomRegistry.set(optimisticAtom, null);
  appAtomRegistry.refresh(queryAtom);
  void executeAtomQuery(appAtomRegistry, queryAtom, {
    reportDefect: false,
    reportFailure: true,
  });
}

function errorMessage<A>(result: AsyncResult.AsyncResult<A, unknown>): string | null {
  if (result._tag !== "Failure") return null;
  const cause = Cause.squash(result.cause);
  return cause instanceof Error ? cause.message : "Workspace query failed.";
}

export function useProjectEntriesQuery(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  cwd: string,
): ProjectQueryState<ProjectListEntriesResult> {
  const atom = getProjectEntriesQueryAtom(environmentId, threadId, cwd);
  const result = useAtomValue(atom);
  const refreshAtom = useAtomRefresh(atom);
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: errorMessage(result),
    isPending: result.waiting,
    refresh: useCallback(() => refreshAtom(), [refreshAtom]),
  };
}

export function useProjectFileQuery(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  cwd: string,
  relativePath: string | null,
): ProjectQueryState<ProjectReadFileResult> {
  const atom = relativePath
    ? getProjectFileQueryAtom(environmentId, threadId, cwd, relativePath)
    : EMPTY_PROJECT_FILE_QUERY_ATOM;
  const result = useAtomValue(atom);
  const refreshAtom = useAtomRefresh(atom);
  const optimistic = useAtomValue(
    optimisticFileAtom(environmentId, cwd, relativePath ?? EMPTY_PROJECT_FILE_PATH),
  );
  const data = projectFileDataFromResult(result);
  return {
    data: optimistic?.data ?? data,
    error: errorMessage(result),
    isPending: result.waiting,
    refresh: useCallback(() => {
      const optimisticAtom = optimisticFileAtom(
        environmentId,
        cwd,
        relativePath ?? EMPTY_PROJECT_FILE_PATH,
      );
      const current = appAtomRegistry.get(optimisticAtom);
      if (current?.confirmedAgainst !== undefined) appAtomRegistry.set(optimisticAtom, null);
      refreshAtom();
    }, [cwd, environmentId, refreshAtom, relativePath]),
  };
}
