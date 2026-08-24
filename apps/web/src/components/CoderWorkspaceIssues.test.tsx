import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { CoderWorkspaceIssueList, summarizeCoderWorkspaceError } from "./CoderWorkspaceIssues";

describe("Coder workspace issue presentation", () => {
  it("summarizes a noisy missing-Nix preflight failure", () => {
    expect(
      summarizeCoderWorkspaceError(
        "Coder workspace preflight exited with code 1. T3 Coder requires nix-env to provision Node.js 24. Waiting for the workspace agent…",
      ),
    ).toBe("T3 Coder could not initialize this workspace because Nix is unavailable.");
  });

  it("shows multiple concise issues with expandable technical details", () => {
    const markup = renderToStaticMarkup(
      <CoderWorkspaceIssueList
        issues={[
          {
            id: "status",
            title: "Workspace status unavailable",
            summary: "T3 Coder could not check the workspace status.",
            details: "Could not fetch workspace status. Failed to fetch",
          },
          {
            id: "connection",
            title: "T3 connection failed",
            summary: "T3 Coder could not finish setting up this workspace.",
            details: "Coder workspace preflight exited with code 1.",
          },
        ]}
      />,
    );

    expect(markup).toContain("Workspace status unavailable");
    expect(markup).toContain("T3 connection failed");
    expect(markup).toContain("Technical details");
  });
});
