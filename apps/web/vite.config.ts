// Coder: builds the static app served by the loopback gateway; no dev proxy, relay, hosted-app,
// Clerk, or tracing configuration.
import { thirdPartyLicensesPlugin } from "../../scripts/lib/third-party-licenses";
import { readBuildVersion } from "../../scripts/build-info.ts";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { playwright } from "vite-plus/test/browser-playwright";
import { defineProject, type TestProjectInlineConfiguration } from "vite-plus/test/config";
import { defineConfig } from "vite-plus";
import * as Hash from "effect/Hash";

const unitTestProject = {
  extends: true,
  test: {
    name: "unit",
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["src/**/*.browser.test.{ts,tsx}"],
    hookTimeout: 15_000,
    testTimeout: 15_000,
    setupFiles: ["../../packages/shared/src/testing/longTempDir.ts"],
  },
} satisfies TestProjectInlineConfiguration;

// Anything that renders React or touches the DOM is named *.browser.test.{ts,tsx} and runs
// in headless Chromium through the same plugins as the app, so it exercises compiled code.
// Vitest's fixed browser API port (63315) collides when two checkouts run
// browser tests at once, and `server.strictPort` above is inherited, so the
// second run fails instead of moving on. Hash the checkout path like
// scripts/dev-runner.ts does, into 61000-64999 (above Linux's ephemeral range).
const browserTestApiPort = 61_000 + ((Hash.string(import.meta.dirname) >>> 0) % 4_000);

const browserTestProject = {
  extends: true,
  // Pre-bundled so the first test importing userEvent does not trigger a mid-run reload.
  optimizeDeps: { include: ["vite-plus/test/browser"] },
  test: {
    name: "browser",
    include: ["src/**/*.browser.test.{ts,tsx}"],
    hookTimeout: 15_000,
    testTimeout: 15_000,
    api: { port: browserTestApiPort, strictPort: false },
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
      screenshotFailures: false,
    },
  },
} satisfies TestProjectInlineConfiguration;

export default defineConfig({
  define: { "import.meta.env.APP_VERSION": JSON.stringify(readBuildVersion()) },
  assetsInclude: ["**/*.wasm"],
  plugins: [
    thirdPartyLicensesPlugin({
      bundleName: "web",
      configFile: new URL("../../third-party-licenses.config.json", import.meta.url),
      packageManifests: [
        { bundle: "web", path: new URL("./package.json", import.meta.url) },
        { bundle: "helper", path: new URL("../coder-helper/package.json", import.meta.url) },
        { bundle: "gateway", path: new URL("../coder-gateway/package.json", import.meta.url) },
      ],
    }),
    tanstackRouter(),
    react({ compiler: true }),
    tailwindcss(),
  ],
  resolve: {
    tsconfigPaths: true,
    dedupe: ["react", "react-dom"],
  },
  server: {
    host: "127.0.0.1",
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
  test: { projects: [defineProject(unitTestProject), defineProject(browserTestProject)] },
});
