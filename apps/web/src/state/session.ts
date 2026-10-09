import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentSessionAtoms } from "@t3tools/client-runtime/state/session";
import type { AuthEnvironmentScope, EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export const environmentSession = createEnvironmentSessionAtoms(connectionAtomRuntime);

// Coder: Coder authenticates the workspace owner and T3 Coder has no environment auth, so the
// connected workspace grants every scope. Upstream's scope gates keep their call sites and pass.
/** Uses the selected environment's grant, including cached scopes during a refresh. */
export function useEnvironmentScope(
  environmentId: EnvironmentId | null,
  _scope: AuthEnvironmentScope,
): boolean {
  return environmentId !== null;
}

/** Subscribe to the grants of every selected environment. */
export function useEnvironmentsWithScope(
  environments: ReadonlyArray<{ readonly environmentId: EnvironmentId }>,
  _scope: AuthEnvironmentScope,
): ReadonlySet<EnvironmentId> {
  return useMemo(
    () => new Set(environments.map((environment) => environment.environmentId)),
    [environments],
  );
}

export function readEnvironmentScope(
  _environmentId: EnvironmentId,
  _scope: AuthEnvironmentScope,
): boolean {
  return true;
}

const EMPTY_PREPARED_CONNECTION_ATOM = Atom.make(Option.none()).pipe(
  Atom.withLabel("web-prepared-connection:empty"),
);

export function usePreparedConnection(environmentId: EnvironmentId | null) {
  return useAtomValue(
    environmentId === null
      ? EMPTY_PREPARED_CONNECTION_ATOM
      : environmentSession.preparedConnectionValueAtom(environmentId),
  );
}

export function readPreparedConnection(environmentId: EnvironmentId) {
  return Option.getOrNull(
    appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
  );
}
