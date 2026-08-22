import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";

import ChatMarkdown, { orderedListGutterStyle } from "./ChatMarkdown";

describe("orderedListGutterStyle", () => {
  it("leaves the default gutter alone for single-digit lists", () => {
    expect(orderedListGutterStyle(9, undefined)).toBeUndefined();
  });

  it("leaves the default gutter alone for two-digit lists", () => {
    expect(orderedListGutterStyle(99, undefined)).toBeUndefined();
  });

  it("leaves the default gutter alone for a two-digit list that starts above 1", () => {
    // start=50 + 49 items => last marker is "98", still two digits.
    expect(orderedListGutterStyle(49, 50)).toBeUndefined();
  });

  it("widens the gutter once the last marker reaches three digits", () => {
    // item 100 is the bug from #6512: a 100-item list starting at 1.
    expect(orderedListGutterStyle(100, undefined)).toEqual({ "--list-gutter": "4ch" });
  });

  it("accounts for a non-default start attribute", () => {
    // start=95 + 9 items => last marker is "103", three digits.
    expect(orderedListGutterStyle(9, 95)).toEqual({ "--list-gutter": "4ch" });
    expect(orderedListGutterStyle(5, "999995")).toEqual({ "--list-gutter": "7ch" });
  });

  it("scales further for four-digit markers", () => {
    expect(orderedListGutterStyle(1000, undefined)).toEqual({ "--list-gutter": "5ch" });
  });

  it("uses the widest marker and includes a negative start's minus sign", () => {
    expect(orderedListGutterStyle(1001, -1000)).toEqual({ "--list-gutter": "6ch" });
    expect(orderedListGutterStyle(3, -15)).toEqual({ "--list-gutter": "4ch" });
    expect(orderedListGutterStyle(3, -5)).toBeUndefined();
  });

  it("treats a missing/zero item count as a single item", () => {
    expect(orderedListGutterStyle(0, undefined)).toBeUndefined();
    expect(orderedListGutterStyle(0, 100)).toEqual({ "--list-gutter": "4ch" });
  });
});

describe("ChatMarkdown", () => {
  it("restores rich presentation while keeping external resources inert", () => {
    const markup = renderToStaticMarkup(
      <ChatMarkdown
        cwd="/workspace/project"
        skills={[{ name: "review", displayName: "Code Review" }]}
        text={[
          "> [!WARNING]",
          "> Check this first.",
          "",
          "$review",
          "",
          "| Name | Value |",
          "| --- | --- |",
          "| alpha | 1 |",
          "",
          "[site](https://example.com) ![diagram](https://example.com/diagram.png)",
          "",
          "<details><summary>More</summary>Safe body</details>",
        ].join("\n")}
      />,
    );

    expect(markup).toContain('role="note"');
    expect(markup).toContain("Warning");
    expect(markup).toContain('data-markdown-copy="$review"');
    expect(markup).toContain("chat-markdown-table-container");
    expect(markup).toContain('aria-label="Copy table as Markdown"');
    expect(markup).toContain('data-markdown-details=""');
    expect(markup).toContain("Image unavailable · diagram");
    expect(markup).not.toContain('href="https://example.com"');
    expect(markup).not.toContain('src="https://example.com/diagram.png"');
  });

  it("adds code block controls while retaining a plain-text fallback", () => {
    const markup = renderToStaticMarkup(
      <ChatMarkdown cwd={undefined} text={'```ts title="example.ts"\nconst answer = 42;\n```'} />,
    );

    expect(markup).toContain('data-language="ts"');
    expect(markup).toContain("example.ts");
    expect(markup).toContain('aria-label="Copy code"');
    expect(markup).toContain("const answer = 42;");
  });
});
