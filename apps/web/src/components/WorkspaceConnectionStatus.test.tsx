import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  coderAuthenticationStatusText,
  workspaceConnectionStatusText,
} from "./WorkspaceConnectionStatus";

describe("workspaceConnectionStatusText", () => {
  it("describes a reconnecting workspace", () => {
    expect(workspaceConnectionStatusText("reconnecting", "dev workspace")).toEqual({
      title: "Reconnecting to dev workspace…",
      description: "Restoring projects and threads.",
    });
  });

  it("distinguishes transport recovery from shell synchronization", () => {
    expect(workspaceConnectionStatusText("connected", "dev workspace")).toEqual({
      title: "Loading workspace data…",
      description: "dev workspace is connected and synchronizing.",
    });
  });

  it("surfaces a workspace connection failure", () => {
    expect(
      workspaceConnectionStatusText("error", "dev workspace", "Coder workspace preflight failed."),
    ).toEqual({
      title: "Couldn’t reconnect to dev workspace",
      description: "Coder workspace preflight failed.",
    });
  });

  it("uses a useful fallback before the environment catalog is restored", () => {
    const status = workspaceConnectionStatusText(null, null);
    const markup = renderToStaticMarkup(
      <div role="status">
        <span>{status.title}</span>
        <span>{status.description}</span>
      </div>,
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain("Reconnecting to Coder workspace…");
    expect(markup).toContain("Restoring projects and threads.");
  });
});

describe("coderAuthenticationStatusText", () => {
  it("explains why a new Coder session is required", () => {
    expect(coderAuthenticationStatusText("Acme Coder", "dev workspace", false)).toEqual({
      title: "Coder sign-in required",
      description: "Acme Coder needs a new session before dev workspace can reconnect.",
    });
  });

  it("directs the user to the terminal while login is running", () => {
    expect(coderAuthenticationStatusText("Acme Coder", "dev workspace", true)).toEqual({
      title: "Waiting for Coder sign-in…",
      description: "Complete authentication in the terminal running T3 Coder.",
    });
  });
});
