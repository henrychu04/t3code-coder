import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ThreadSyncStatusPill } from "./ThreadSyncStatusPill";

describe("ThreadSyncStatusPill", () => {
  it.each([
    ["loading", "Loading messages..."],
    ["syncing", "Syncing messages..."],
  ] as const)("renders the %s message sync phase", (phase, label) => {
    const markup = renderToStaticMarkup(<ThreadSyncStatusPill phase={phase} />);

    expect(markup).toContain('role="status"');
    expect(markup).toContain('data-thread-sync-drawer="true"');
    expect(markup).toContain('data-slot="composer-banner-attachment"');
    expect(markup).toContain('data-composer-banner-surface="attached"');
    expect(markup).toContain('data-composer-banner-row="true"');
    expect(markup).not.toContain("chat-composer-drawer-surface");
    expect(markup).toContain("motion-safe:animate-spin");
    expect(markup).toContain(label);
  });
});
