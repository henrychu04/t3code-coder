import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ProviderUsageLimits } from "./ProviderUsageLimits";

describe("workspace subscription limits", () => {
  it("renders reported windows and reset times without links or external sources", () => {
    const html = renderToStaticMarkup(
      <ProviderUsageLimits
        limits={{
          checkedAt: "2026-09-04T10:00:00.000Z",
          windows: [
            {
              id: "primary",
              label: "Session",
              kind: "session",
              usedPercent: 25,
              resetsAt: "2026-09-04T14:00:00.000Z",
            },
          ],
        }}
      />,
    );
    expect(html).toContain("25% used");
    expect(html).toContain('value="25"');
    expect(html).toContain("2026-09-04T14:00:00.000Z");
    expect(html).not.toContain("href=");
  });
  it("does not render a failed probe as zero usage", () => {
    const html = renderToStaticMarkup(
      <ProviderUsageLimits
        limits={{
          checkedAt: "2026-09-04T10:00:00.000Z",
          windows: [],
          unavailable: { reason: "probeFailed" },
        }}
      />,
    );
    expect(html).toContain("Could not read");
    expect(html).not.toContain("<progress");
  });
});
