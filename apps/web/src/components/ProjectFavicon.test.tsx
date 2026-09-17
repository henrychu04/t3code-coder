import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ProjectFavicon, ProjectIconGraphic } from "./ProjectFavicon";

describe("ProjectFavicon", () => {
  it("renders upstream monograms from the saved project name without fetching images", () => {
    const html = renderToStaticMarkup(
      <ProjectFavicon
        className="project-icon"
        project={{ title: "agent-runtime", workspaceRoot: "/workspace-test" }}
      />,
    );

    expect(html).toContain("project-icon");
    expect(html).toContain("<svg");
    expect(html).toContain(">AR</text>");
    expect(html).not.toContain("<img");
  });

  it("honors a caller-provided fallback even when a project is available", () => {
    const html = renderToStaticMarkup(
      <ProjectFavicon
        project={{ title: "agent-runtime", workspaceRoot: "/workspace-test" }}
        fallbackIcon={() => <span>fallback</span>}
      />,
    );
    expect(html).toContain("fallback");
    expect(html).not.toContain("lucide-bot");
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

it("renders workspace-owned icon overrides without loading images", () => {
  const markup = renderToStaticMarkup(
    <ProjectIconGraphic icon={{ kind: "lucide", name: "book-open", color: "violet" }} />,
  );
  expect(markup).toContain("<svg");
  expect(markup).toContain("text-violet-");
  expect(markup).not.toContain("<img");
  const emoji = renderToStaticMarkup(<ProjectIconGraphic icon={{ kind: "emoji", emoji: "🚀" }} />);
  expect(emoji).toContain("🚀");
  expect(emoji).not.toContain("<img");
});
