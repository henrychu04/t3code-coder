import { ScreenshotArtifactId, type ScreenshotArtifactReference } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ScreenshotArtifactPreview } from "./ScreenshotArtifactPreview";

const artifact: ScreenshotArtifactReference = {
  id: ScreenshotArtifactId.make("screenshot-1"),
  name: "Screenshot",
  mimeType: "image/png",
  sizeBytes: 80,
  dimensions: { width: 900, height: 1600 },
};
describe("ScreenshotArtifactPreview", () => {
  it("reserves the reported frame before any image URL exists and keeps it after loading", () => {
    const loading = renderToStaticMarkup(<ScreenshotArtifactPreview artifact={artifact} />);
    const loaded = renderToStaticMarkup(
      <ScreenshotArtifactPreview
        artifact={artifact}
        image={{ status: "loaded", url: "blob:screenshot" }}
      />,
    );
    expect(loading).toContain("aspect-ratio:900 / 1600");
    expect(loading).not.toContain("<img");
    expect(loaded).toContain("aspect-ratio:900 / 1600");
    expect(loaded).toContain('width="900" height="1600"');
  });
  it.each([
    undefined,
    { width: 0, height: 100 },
    { width: Infinity, height: 100 },
    { width: "900", height: 100 },
  ])("uses the legacy frame for missing or malformed metadata: %j", (dimensions) => {
    const legacy = { ...artifact, dimensions } as unknown as ScreenshotArtifactReference;
    expect(renderToStaticMarkup(<ScreenshotArtifactPreview artifact={legacy} />)).toContain(
      "aspect-ratio:16 / 9",
    );
  });
});
