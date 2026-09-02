import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerStashBadge } from "./ComposerStashBadge";

describe("ComposerStashBadge", () => {
  it("renders nothing when the stash is empty", () => {
    const markup = renderToStaticMarkup(
      <ComposerStashBadge
        count={0}
        menuOpen={false}
        pulseKey={0}
        pulsing={false}
        onToggleMenu={() => {}}
      />,
    );

    expect(markup).toBe("");
  });

  it("renders an inline control with the stash count", () => {
    const markup = renderToStaticMarkup(
      <ComposerStashBadge
        count={3}
        menuOpen={false}
        pulseKey={0}
        pulsing={false}
        onToggleMenu={() => {}}
      />,
    );

    expect(markup).toContain('data-slot="button"');
    expect(markup).toContain("Stashed prompts: 3. Open stash.");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain(">3</span>");
  });

  it("reports when the stash menu is open", () => {
    const markup = renderToStaticMarkup(
      <ComposerStashBadge
        count={3}
        menuOpen
        pulseKey={0}
        pulsing={false}
        onToggleMenu={() => {}}
      />,
    );

    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("text-foreground");
  });
});
