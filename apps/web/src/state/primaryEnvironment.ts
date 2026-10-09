import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

/**
 * Coder: there is no primary local server. The active workspace (the first connected one, until
 * the user picks another) stands in for upstream's primary environment.
 */
export const primaryEnvironmentIdAtom = Atom.make<EnvironmentId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-primary-environment-id"),
);
