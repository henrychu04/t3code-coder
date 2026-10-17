import {
  AVAILABLE_CONNECTION_STATE,
  connectionProjectionPhase,
} from "@t3tools/client-runtime/connection";
import {
  createEnvironmentShellAtoms,
  createEnvironmentSnapshotAtom,
  type EnvironmentShellStatus,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";

export const environmentShell = createEnvironmentShellAtoms(connectionAtomRuntime);
export const environmentSnapshotAtom = createEnvironmentSnapshotAtom(environmentShell.stateAtom);

const NO_SHELL_STATUS_ATOM = Atom.make<EnvironmentShellStatus | null>(null).pipe(
  Atom.withLabel("web-environment-shell-status:none"),
);
const NO_SHELL_SNAPSHOT_ATOM = Atom.make(false).pipe(
  Atom.withLabel("web-environment-shell-has-snapshot:none"),
);

export function useEnvironmentShellStatus(
  environmentId: EnvironmentId | null,
): EnvironmentShellStatus | null {
  return useAtomValue(
    environmentId === null ? NO_SHELL_STATUS_ATOM : environmentShell.statusAtom(environmentId),
  );
}

export function useEnvironmentShellHasSnapshot(environmentId: EnvironmentId | null): boolean {
  return useAtomValue(
    environmentId === null
      ? NO_SHELL_SNAPSHOT_ATOM
      : environmentShell.hasSnapshotAtom(environmentId),
  );
}

export const allEnvironmentShellsBootstrappedAtom = Atom.make((get) => {
  const catalog = AsyncResult.value(get(environmentCatalog.catalogAtom));
  if (Option.isNone(catalog)) {
    return false;
  }
  for (const environmentId of catalog.value.entries.keys()) {
    if (Option.isSome(get(environmentShell.stateValueAtom(environmentId)).snapshot)) {
      continue;
    }
    const connection = Option.getOrElse(
      AsyncResult.value(get(environmentCatalog.stateAtom(environmentId))),
      () => AVAILABLE_CONNECTION_STATE,
    );
    if (connectionProjectionPhase(connection) !== "disconnected") {
      return false;
    }
    if (connection.phase === "backoff" && connection.desired && connection.attempt <= 2) {
      return false;
    }
  }
  return true;
}).pipe(Atom.withLabel("web-all-environment-shells-bootstrapped"));

// Coder: every configured workspace is a remote environment; there is no primary local target.
export const allEnvironmentProjectSnapshotsReadyAtom = Atom.make((get) => {
  const catalog = AsyncResult.value(get(environmentCatalog.catalogAtom));
  if (Option.isNone(catalog)) return false;
  for (const id of catalog.value.entries.keys()) {
    if (get(environmentShell.stateValueAtom(id)).status !== "live") return false;
  }
  return true;
}).pipe(Atom.withLabel("web-all-environment-project-snapshots-ready"));
