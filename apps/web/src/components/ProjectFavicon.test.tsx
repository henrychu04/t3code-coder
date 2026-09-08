import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ProjectFavicon } from "./ProjectFavicon";

describe("ProjectFavicon", () => {
  it("derives the upstream icon from the project name without fetching images", () => {
    const html = renderToStaticMarkup(
      <ProjectFavicon
        className="project-icon"
        project={{ title: "agent-runtime", workspaceRoot: "/workspace-test" }}
      />,
    );

    expect(html).toContain("project-icon");
    expect(html).toContain("text-icon-muted");
    expect(html).toContain("<svg");
    expect(html).toContain("lucide-bot");
    expect(html).not.toContain("<img");
  });

  it("keeps the project icon when a caller supplies a fallback", () => {
    const html = renderToStaticMarkup(
      <ProjectFavicon
        project={{ title: "agent-runtime", workspaceRoot: "/workspace-test" }}
        fallbackIcon={() => <span>fallback</span>}
      />,
    );
    expect(html).toContain("lucide-bot");
    expect(html).not.toContain("fallback");
  });

  it("supports a caller-provided fallback icon", () => {
    const FallbackIcon = ({ className }: { className?: string }) => (
      <span className={className}>custom fallback</span>
    );
    const html = renderToStaticMarkup(
      <ProjectFavicon project={null} fallbackIcon={FallbackIcon} />,
    );

    expect(html).toContain("custom fallback");
    expect(html).toContain("size-3.5");
  });
});
