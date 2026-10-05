import { defineConfig } from "vite-plus";
import base from "./vite.config.ts";

// Supported workspace behavior across all retained server suites.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    // Every retained server suite exercises supported workspace behavior.
    // Upstream-only surfaces have been removed from this fork, so no exclusions are needed.
    include: ["apps/server/src/**/*.test.ts"],
  },
});
