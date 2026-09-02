import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerStashMenu } from "./ComposerStashMenu";

const baseEntry = {
  id: "entry-1",
  createdAt: "2026-07-24T12:00:00.000Z",
  environmentId: "env-1",
  prompt: "Compare these screenshots",
};

describe("ComposerStashMenu", () => {
  it("renders as an attached composer drawer with a close control", () => {
    const markup = renderToStaticMarkup(
      <ComposerStashMenu
        entries={[]}
        stashShortcutLabel={null}
        onRestore={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
      />,
    );

    expect(markup).toContain('data-slot="composer-banner"');
    expect(markup).toContain('data-composer-stash-drawer="true"');
    expect(markup).toContain('aria-label="Close stash"');
    expect(markup).toContain('role="list"');
  });

  it("shows the stash shortcut in the empty-state hint", () => {
    const markup = renderToStaticMarkup(
      <ComposerStashMenu
        entries={[]}
        stashShortcutLabel="Ctrl+S"
        onRestore={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
      />,
    );

    expect(markup).toContain("Press Ctrl+S with a prompt in the composer to stash it.");
  });

  it("lists stashed prompts with a snippet and a delete control", () => {
    const markup = renderToStaticMarkup(
      <ComposerStashMenu
        entries={[baseEntry]}
        stashShortcutLabel={null}
        onRestore={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
      />,
    );

    expect(markup).toContain("Compare these screenshots");
    expect(markup).toContain('aria-label="Delete stashed prompt"');
    expect(markup).toContain('data-stash-restore="entry-1"');
    expect(markup).toContain('aria-label="Restore stashed prompt: Compare these screenshots"');
    expect(markup).toContain('dateTime="2026-07-24T12:00:00.000Z"');
  });

  it("truncates long prompts to the snippet limit", () => {
    const markup = renderToStaticMarkup(
      <ComposerStashMenu
        entries={[{ ...baseEntry, prompt: "x".repeat(200) }]}
        stashShortcutLabel={null}
        onRestore={() => {}}
        onDelete={() => {}}
        onClose={() => {}}
      />,
    );

    expect(markup).toContain("x".repeat(90));
    expect(markup).not.toContain("x".repeat(91));
  });
});
