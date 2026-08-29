import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createGitLabMergeRequestEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    viewCurrent: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:gitlab:merge-request:view-current",
      tag: WS_METHODS.gitLabMergeRequestView,
      staleTimeMs: 15_000,
      idleTtlMs: 60_000,
    }),
  };
}
