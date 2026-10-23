import { createAssetEnvironmentAtoms } from "@t3tools/client-runtime/state/assets";

import { connectionAtomRuntime } from "../connection/runtime";

// Coder: no local desktop media environment, and project favicons are not carried.
export const assetEnvironment = createAssetEnvironmentAtoms(connectionAtomRuntime);
