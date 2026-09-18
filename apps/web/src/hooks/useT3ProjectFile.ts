import { useAtomValue, useAtomRefresh } from "@effect/atom-react";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId, ProjectGetConfigResult } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { projectEnvironment } from "../state/projects";
const empty = Atom.make(
  AsyncResult.success<ProjectGetConfigResult>({ status: "missing", file: null }),
);
export function useT3ProjectFile(
  target: { environmentId: EnvironmentId; projectId?: ProjectId | null | undefined } | null,
) {
  const atom = target?.projectId
    ? projectEnvironment.getConfig({
        environmentId: target.environmentId,
        input: { projectId: target.projectId },
      })
    : empty;
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const data =
    result._tag === "Failure"
      ? { status: "unavailable" as const, file: null }
      : Option.getOrNull(AsyncResult.value(result));
  return { status: data?.status ?? "loading", file: data?.file ?? null, refresh };
}
export async function getT3ProjectFile(environmentId: EnvironmentId, projectId: ProjectId) {
  const result = await executeAtomQuery(
    appAtomRegistry,
    projectEnvironment.getConfig({ environmentId, input: { projectId } }),
    {
      refresh: true,
      reportDefect: false,
      reportFailure: false,
      // Optional repository metadata must not block draft creation during reconnect.
      signal: AbortSignal.timeout(5_000),
    },
  );
  return result._tag === "Success" && result.value.status === "valid" ? result.value.file : null;
}
