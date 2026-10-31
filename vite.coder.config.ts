import * as NodeURL from "node:url";
import { defineConfig } from "vite-plus";
import base from "./vite.config.ts";

// Supported workspace behavior across all retained server suites.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    // Every retained server suite exercises supported workspace behavior.
    // Upstream-only surfaces have been removed from this fork, so no exclusions are needed.
    // The ACP mock and replay agents under scripts/ carry their own suite.
    include: ["apps/server/src/**/*.test.ts", "apps/server/scripts/**/*.test.ts"],
    setupFiles: [
      ...(base.test?.setupFiles ?? []),
      NodeURL.fileURLToPath(
        new URL("./apps/server/src/testUtils/darwinTempDir.setup.ts", import.meta.url),
      ),
    ],
  },
});
