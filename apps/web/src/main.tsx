import React from "react";
import ReactDOM from "react-dom/client";

import "@fontsource-variable/inter";
import "./index.css";

import { startAppServices } from "./appInit";
import { AppRoot } from "./AppRoot";
import { clearChunkReloadGuard, reloadOnceForChunkLoadError } from "./lib/chunkReloadGuard";
// Coder: the Coder deployment/workspace manager wraps the app, and handled failures are reported
// to the browser console. There is no Electron shell, managed auth, or provider auth delivery.
import { CoderBootstrap } from "./coder/CoderBootstrap";
import { reportErrorDiagnostic } from "@t3tools/client-runtime/errors";
import { installConsoleDiagnostics } from "./consoleDiagnostics";

const disposeDiagnostics = installConsoleDiagnostics();
if (import.meta.hot) import.meta.hot.dispose(disposeDiagnostics);

const router = startAppServices();

let chunkLoadFailed = false;
let reloadScheduled = false;
window.addEventListener("vite:preloadError", (event) => {
  chunkLoadFailed = true;
  if (reloadOnceForChunkLoadError()) {
    reloadScheduled = true;
    event.preventDefault();
  }
});

export const startup = router
  .load()
  .then(() => {
    // Route chunk failures resolve router.load() and surface later through the error boundary.
    if (reloadScheduled) return;
    if (!chunkLoadFailed) clearChunkReloadGuard();
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement, {
      onCaughtError: (error) => reportErrorDiagnostic("react.caught", error),
      onUncaughtError: (error) => reportErrorDiagnostic("react.uncaught", error),
      onRecoverableError: (error) => reportErrorDiagnostic("react.recoverable", error),
    }).render(
      <React.StrictMode>
        <CoderBootstrap app={<AppRoot router={router} />} />
      </React.StrictMode>,
    );
  })
  .catch((error: unknown) => {
    if (reloadScheduled) return;
    throw error;
  });
