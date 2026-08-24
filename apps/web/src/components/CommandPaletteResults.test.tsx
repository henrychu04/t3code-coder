import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { CommandPaletteResults } from "./CommandPaletteResults";
import { Command } from "./ui/command";

describe("CommandPaletteResults", () => {
  it("renders and highlights a thread message match", () => {
    const html = renderToStaticMarkup(
      <Command mode="none" value="">
        <CommandPaletteResults
          groups={[
            {
              value: "threads-search",
              label: "Threads",
              items: [
                {
                  kind: "action",
                  value: "thread:env-a:thread-a",
                  searchTerms: ["Investigate reconnects", "gateway needle"],
                  title: "Investigate reconnects",
                  icon: null,
                  threadContentMatch: {
                    source: "assistant",
                    snippet: "The gateway needle appears after reconnecting.",
                    query: "needle",
                  },
                  run: async () => undefined,
                },
              ],
            },
          ]}
          keybindings={[]}
          onExecuteItem={() => undefined}
        />
      </Command>,
    );

    expect(html).toContain("Agent:");
    expect(html).toContain(">needle</mark>");
    expect(html).toContain("Investigate reconnects");
  });
});
