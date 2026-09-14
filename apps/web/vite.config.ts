import { thirdPartyLicensesPlugin } from "./vite/third-party-licenses.ts";
import { readBuildVersion } from "../../scripts/build-info.ts";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineProject, type TestProjectInlineConfiguration } from "vite-plus/test/config";
import { defineConfig } from "vite-plus";

const unitTestProject = {
  extends: true,
  test: {
    name: "unit",
    include: ["src/**/*.test.{ts,tsx}"],
    hookTimeout: 15_000,
    testTimeout: 15_000,
    setupFiles: ["../../packages/shared/src/testing/longTempDir.ts"],
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
    react(),
    babel({
      parserOpts: { plugins: ["typescript", "jsx"] },
      presets: [reactCompilerPreset()],
    }),
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
  test: { projects: [defineProject(unitTestProject)] },
});
