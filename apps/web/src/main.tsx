import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserHistory } from "@tanstack/react-router";

import "./index.css";

import { getRouter } from "./router";
import { AppRoot } from "./AppRoot";
import { CoderBootstrap } from "./coder/CoderBootstrap";

const router = getRouter(createBrowserHistory());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <CoderBootstrap app={<AppRoot router={router} />} />
  </React.StrictMode>,
);
