import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserHistory } from "@tanstack/react-router";

import "./index.css";

import { getRouter } from "./router";
import { AppRoot } from "./AppRoot";
import { clearChunkReloadGuard, reloadOnceForChunkLoadError } from "./lib/chunkReloadGuard";
// Coder: the Coder deployment/workspace manager wraps the app, and handled failures are reported
// to the browser console. There is no Electron shell, managed auth, or provider auth delivery.
import { CoderBootstrap } from "./coder/CoderBootstrap";
import { reportErrorDiagnostic } from "@t3tools/client-runtime/errors";
import { installConsoleDiagnostics } from "./consoleDiagnostics";

const disposeDiagnostics = installConsoleDiagnostics();
if (import.meta.hot) import.meta.hot.dispose(disposeDiagnostics);

const router = getRouter(createBrowserHistory());

// A failed split-chunk fetch usually means the hashed assets went stale under
// a deploy; one guarded reload picks up the fresh index.html.
let chunkLoadFailed = false;
let reloadScheduled = false;
window.addEventListener("vite:preloadError", (event) => {
  chunkLoadFailed = true;
  if (reloadOnceForChunkLoadError()) {
    reloadScheduled = true;
    event.preventDefault();
  }
});

// The index.html boot splash lives inside #root, and React's first commit
// clears it. Resolve the initial route's split chunks before rendering, so the
// splash holds until real UI paints instead of dropping to a blank window
// while chunks download.
export const startup = router
  .load()
  .then(() => {
    // A route chunk failure still resolves router.load(): the error is parked in
    // the lazy component and surfaces through the route error boundary. Skip the
    // paint when a reload is on its way, and only re-arm the guard after a boot
    // that fetched every chunk it asked for.
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
    // Let the bootstrap entry show the error unless a reload is already scheduled.
    if (reloadScheduled) return;
    throw error;
  });
