import type { EnvironmentId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ProjectFavicon } from "./ProjectFavicon";

const environmentId = "environment-test" as EnvironmentId;

describe("ProjectFavicon", () => {
  it("renders the local folder fallback in the Coder-only client", () => {
    const html = renderToStaticMarkup(
      <ProjectFavicon
        className="project-icon"
        environmentId={environmentId}
        cwd="/workspace-test"
        faviconPath="brand/icon.svg"
      />,
    );

    expect(html).toContain("project-icon");
    expect(html).toContain("text-icon-muted");
    expect(html).toContain("<svg");
  });

  it("supports a caller-provided fallback icon", () => {
    const FallbackIcon = ({ className }: { className?: string }) => (
      <span className={className}>custom fallback</span>
    );
    const html = renderToStaticMarkup(
      <ProjectFavicon
        environmentId={environmentId}
        cwd="/workspace-test"
        fallbackIcon={FallbackIcon}
      />,
    );

    expect(html).toContain("custom fallback");
    expect(html).toContain("size-3.5");
  });
});
