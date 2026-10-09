import { createFilesystemEnvironmentAtoms } from "@t3tools/client-runtime/state/filesystem";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const filesystemEnvironment = createFilesystemEnvironmentAtoms(connectionAtomRuntime);

// Coder: the workspace owner always holds the filesystem read scope (see `useEnvironmentScope`).
export function useFilesystemReadAccess(environmentId: EnvironmentId | null) {
  return environmentId === null
    ? { canReadFiles: false, isPending: false, error: "This environment is not connected." }
    : { canReadFiles: true, isPending: false, error: null };
}
