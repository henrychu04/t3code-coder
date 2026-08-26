import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { DiffFileExpansionErrorNotice } from "./DiffFileExpansionErrorNotice";

describe("DiffFileExpansionErrorNotice", () => {
  it("identifies every oversized file and its expansion limit", () => {
    const markup = renderToStaticMarkup(
      <DiffFileExpansionErrorNotice
        errors={[
          { fileKey: "large-a", filePath: "src/large-a.ts", maxBytes: 32 * 1024 * 1024 },
          { fileKey: "large-b", filePath: "src/large-b.ts", maxBytes: 32 * 1024 * 1024 },
        ]}
      />,
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain("src/large-a.ts is too large to expand (32 MiB maximum).");
    expect(markup).toContain("src/large-b.ts is too large to expand (32 MiB maximum).");
  });

  it("renders nothing before an expansion fails", () => {
    expect(renderToStaticMarkup(<DiffFileExpansionErrorNotice errors={[]} />)).toBe("");
  });
});
