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
