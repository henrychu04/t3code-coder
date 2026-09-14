import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserHistory } from "@tanstack/react-router";

import "./index.css";

import { getRouter } from "./router";
import { AppRoot } from "./AppRoot";
import { CoderBootstrap } from "./coder/CoderBootstrap";
import { reportErrorDiagnostic } from "@t3tools/client-runtime/errors";
import { installConsoleDiagnostics } from "./consoleDiagnostics";

const disposeDiagnostics = installConsoleDiagnostics();
if (import.meta.hot) import.meta.hot.dispose(disposeDiagnostics);

const router = getRouter(createBrowserHistory());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement, {
  onCaughtError: (error) => reportErrorDiagnostic("react.caught", error),
  onUncaughtError: (error) => reportErrorDiagnostic("react.uncaught", error),
  onRecoverableError: (error) => reportErrorDiagnostic("react.recoverable", error),
}).render(
  <React.StrictMode>
    <CoderBootstrap app={<AppRoot router={router} />} />
  </React.StrictMode>,
);
