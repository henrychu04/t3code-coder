import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { collectNativeUsageAccounts } from "./NativeUsageOverview.logic";

function environment(id: string, email: string | undefined, checkedAt = "2026-09-07T00:00:00Z") {
  return {
    environmentId: id,
    label: id,
    connection: { phase: "connected" },
    serverConfig: {
      providers: [
        {
          driver: ProviderDriverKind.make("codex"),
          instanceId: ProviderInstanceId.make("codex"),
          enabled: true,
          installed: true,
          auth: { status: "authenticated" as const, ...(email ? { email } : {}) },
          usageLimits: {
            checkedAt,
            windows: [{ id: "weekly", kind: "weekly" as const, label: "Weekly", usedPercent: 20 }],
          },
        },
      ],
    },
  };
}
describe("native usage overview", () => {
  it("deduplicates shared accounts across workspaces using the freshest snapshot", () => {
    const first = environment("one", " User@Example.com ");
    const second = environment("two", "user@example.com", "2026-09-07T01:00:00Z");
    second.serverConfig.providers[0]!.usageLimits.windows[0]!.usedPercent = 70;
    const accounts = collectNativeUsageAccounts([first, second]);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.workspaces.map(({ id }) => id)).toEqual(["one", "two"]);
    expect(accounts[0]!.limits.windows[0]!.usedPercent).toBe(70);
  });
  it("keeps unknown identities and different providers separate", () => {
    const claude = environment("three", "same@example.com");
    claude.serverConfig.providers[0]!.driver = ProviderDriverKind.make("claudeAgent");
    expect(
      collectNativeUsageAccounts([
        environment("one", undefined),
        environment("two", undefined),
        environment("four", "same@example.com"),
        claude,
      ]),
    ).toHaveLength(4);
  });
  it("excludes offline and disabled sources and preserves unavailable snapshots", () => {
    const offline = environment("offline", undefined);
    offline.connection.phase = "disconnected";
    const disabled = environment("disabled", undefined);
    disabled.serverConfig.providers[0]!.enabled = false;
    const available = environment("connected", undefined);
    const limits = {
      ...available.serverConfig.providers[0]!.usageLimits,
      unavailable: { reason: "probeFailed" as const },
    };
    available.serverConfig.providers[0]!.usageLimits = limits;
    const accounts = collectNativeUsageAccounts([offline, disabled, available]);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.limits.unavailable?.reason).toBe("probeFailed");
  });
});
it("keeps usable quota when another workspace's newer probe failed", () => {
  const good = environment("good", "shared@example.com");
  const failed = environment("failed", "shared@example.com", "2026-09-07T01:00:00Z");
  Object.assign(failed.serverConfig.providers[0]!.usageLimits, {
    windows: [],
    unavailable: { reason: "probeFailed" },
  });
  const accounts = collectNativeUsageAccounts([good, failed]);
  expect(accounts[0]!.limits.windows).toHaveLength(1);
  expect(accounts[0]!.unavailableWorkspaces).toEqual([{ id: "failed", label: "failed" }]);
  expect(collectNativeUsageAccounts([failed, good])[0]!.limits.windows).toHaveLength(1);
});
