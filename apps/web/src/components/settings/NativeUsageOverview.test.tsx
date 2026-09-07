import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({ environments: [] as unknown[] }));
vi.mock("../../state/environments", () => ({ useEnvironments: () => state }));
import { NativeUsageOverview } from "./NativeUsageOverview";

describe("native usage overview rendering", () => {
  it("explains when connected workspaces have no limits", () => {
    state.environments = [];
    expect(renderToStaticMarkup(<NativeUsageOverview />)).toContain(
      "No native subscription limits",
    );
  });
  it("shows shared workspaces once with the freshest remaining quota", () => {
    state.environments = ["One", "Two"].map((label, i) => ({
      environmentId: label,
      label,
      connection: { phase: "connected" },
      serverConfig: {
        providers: [
          {
            instanceId: "codex",
            driver: "codex",
            enabled: true,
            installed: true,
            auth: { email: "user@example.com" },
            usageLimits: {
              checkedAt: `2026-09-07T0${i}:00:00Z`,
              windows: [
                { id: "weekly", label: "Weekly", kind: "weekly", usedPercent: 20 + 50 * i },
              ],
            },
          },
        ],
      },
    }));
    const markup = renderToStaticMarkup(<NativeUsageOverview />);
    expect(markup).toContain("One, Two");
    expect(markup.match(/<progress /g)).toHaveLength(1);
    expect(markup).toContain("30% left");
  });
});
