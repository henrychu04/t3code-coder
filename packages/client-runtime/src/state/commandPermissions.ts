import { clientRpcRequiredScopes, type EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/**
 * UI availability and dispatch use the same target session and method policy.
 *
 * Coder: Coder authenticates the workspace owner and T3 Coder has no environment auth, so every
 * connected workspace grants each method's scopes. The guard keeps upstream's shape and passes.
 */
function makeCommandPermissions(method: string) {
  const requiredScopes = (input?: unknown) => clientRpcRequiredScopes(method, input);
  const atomsByEnvironment = Atom.family((environmentId: EnvironmentId | null) =>
    Atom.make(() => environmentId !== null),
  );
  const permissionAtom = (environmentId: EnvironmentId | null, _input?: unknown) =>
    atomsByEnvironment(environmentId);
  const authorize = (
    _registry: AtomRegistry.AtomRegistry,
    _environmentId: EnvironmentId,
    _input?: unknown,
  ) => Effect.void;
  return { requiredScopes, permissionAtom, authorize };
}

const permissionsByRuntime = new WeakMap<
  object,
  Map<string, ReturnType<typeof makeCommandPermissions>>
>();

/** Reuse availability atoms and dispatch guards across commands on the same runtime. */
export function createCommandPermissions<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  method: string,
) {
  let permissions = permissionsByRuntime.get(runtime);
  if (permissions === undefined) {
    permissions = new Map();
    permissionsByRuntime.set(runtime, permissions);
  }
  const existing = permissions.get(method);
  if (existing !== undefined) return existing;
  const created = makeCommandPermissions(method);
  permissions.set(method, created);
  return created;
}
