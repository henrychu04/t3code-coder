// Coder: builds the static app served by the loopback gateway; no dev proxy, relay, hosted-app,
// Clerk, or tracing configuration.
import { thirdPartyLicensesPlugin } from "../../scripts/lib/third-party-licenses";
import { readBuildVersion } from "../../scripts/build-info.ts";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { playwright } from "vite-plus/test/browser-playwright";
import { defineProject, type TestProjectInlineConfiguration } from "vite-plus/test/config";
import { defineConfig, type Plugin } from "vite-plus";
import * as Hash from "effect/Hash";
import pdfjsPkg from "pdfjs-dist/package.json" with { type: "json" };

const unitTestProject = {
  extends: true,
  test: {
    name: "unit",
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["src/**/*.browser.test.{ts,tsx}"],
    hookTimeout: 15_000,
    testTimeout: 15_000,
    setupFiles: [
      "../../packages/shared/src/testing/longTempDir.ts",
      "../../packages/shared/src/testing/providerEnv.ts",
    ],
  },
} satisfies TestProjectInlineConfiguration;

// Hash checkout paths to ports 61000-64999; Vitest's fixed port collides under inherited strictPort.
const browserTestApiPort = 61_000 + ((Hash.string(import.meta.dirname) >>> 0) % 4_000);

const browserTestProject = {
  extends: true,
  // Pre-bundle lazy browser and worker dependencies to avoid mid-run reloads.
  optimizeDeps: {
    include: [
      "vite-plus/test/browser",
      "@base-ui/react/autocomplete",
      "saxes",
      "@betteroffice/docx/editor",
      "@betteroffice/docx/layout",
      "@betteroffice/docx/layout/render",
      "@betteroffice/docx/yrs",
      "@betteroffice/fonts",
      "@betteroffice/pptx",
      "@betteroffice/xlsx",
      "@betteroffice/xlsx/headless",
      "fast-xml-parser",
      "entities",
      "dompurify",
      "heic-to/next",
      "jszip",
      "pdfjs-dist",
      "sql.js",
      "tiff",
    ],
  },
  test: {
    name: "browser",
    include: ["src/**/*.browser.test.{ts,tsx}"],
    hookTimeout: 15_000,
    testTimeout: 15_000,
    setupFiles: ["./test/browserSetup.ts"],
    api: { port: browserTestApiPort, strictPort: false },
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
      screenshotFailures: false,
      commands: {
        // Playwright's mouse outlives each test, so whatever mounts under its last
        // position starts hovered. test/browserSetup.ts parks it off the page before each test.
        resetPointer: async ({ page }) => {
          await page.mouse.move(-1, -1);
        },
      },
    },
  },
} satisfies TestProjectInlineConfiguration;

// A static import cycle between chunks can run a chunk before the values it imports exist,
// which blanks the app at boot. Fail the build instead of shipping it.
function chunkCycleGuardPlugin(): Plugin {
  return {
    name: "t3code:chunk-cycle-guard",
    apply: "build",
    generateBundle(_options, bundle) {
      const done = new Set<string>();
      const visit = (fileName: string, path: string[]) => {
        if (done.has(fileName)) return;
        const start = path.indexOf(fileName);
        if (start !== -1) {
          this.error(`Chunk import cycle: ${[...path.slice(start), fileName].join(" -> ")}`);
        }
        const chunk = bundle[fileName];
        if (chunk?.type !== "chunk") return;
        for (const imported of chunk.imports) visit(imported, [...path, fileName]);
        done.add(fileName);
      };
      for (const fileName of Object.keys(bundle)) visit(fileName, []);
    },
  };
}

export default defineConfig({
  define: { "import.meta.env.APP_VERSION": JSON.stringify(readBuildVersion()) },
  assetsInclude: ["**/*.wasm"],
  plugins: [
    chunkCycleGuardPlugin(),
    thirdPartyLicensesPlugin({
      bundleName: "web",
      configFile: new URL("../../third-party-licenses.config.json", import.meta.url),
      packageManifests: [
        { bundle: "web", path: new URL("./package.json", import.meta.url) },
        { bundle: "helper", path: new URL("../coder-helper/package.json", import.meta.url) },
        { bundle: "gateway", path: new URL("../coder-gateway/package.json", import.meta.url) },
      ],
    }),
    tanstackRouter({ autoCodeSplitting: true }),
    react({ compiler: true }),
    tailwindcss(),
  ],
  resolve: {
    tsconfigPaths: true,
    alias: {
      "@betteroffice/fonts-cjk": new URL(
        "./src/components/files/office/fonts-cjk.ts",
        import.meta.url,
      ).pathname,
    },
    dedupe: ["react", "react-dom"],
  },
  server: {
    host: "127.0.0.1",
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    manifest: true,
    sourcemap: false,
    rolldownOptions: {
      output: {
        // PDF.js resolves decoder modules and ICC data relative to wasmUrl.
        assetFileNames: (asset) =>
          asset.originalFileNames.some((path) => /[/\\]pdfjs-dist[/\\]wasm[/\\]/.test(path))
            ? `assets/pdfjs-${pdfjsPkg.version}/[name][extname]`
            : "assets/[name]-[hash][extname]",
      },
    },
  },
  worker: { format: "es" },
  test: { projects: [defineProject(unitTestProject), defineProject(browserTestProject)] },
});
