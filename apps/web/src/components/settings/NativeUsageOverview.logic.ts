import type { ServerProvider } from "@t3tools/contracts";

type UsageProvider = Pick<
  ServerProvider,
  "driver" | "instanceId" | "displayName" | "enabled" | "installed" | "auth" | "usageLimits"
>;

/** Only native snapshots already held in browser memory; unknown accounts never collapse together. */
export function collectNativeUsageAccounts(
  environments: readonly {
    environmentId: string;
    label: string;
    connection: { phase: string };
    serverConfig: { providers: readonly UsageProvider[] } | null;
  }[],
) {
  const accounts = new Map<
    string,
    {
      key: string;
      driver: string;
      label: string;
      workspaces: { id: string; label: string }[];
      limits: NonNullable<UsageProvider["usageLimits"]>;
    }
  >();
  for (const environment of environments) {
    if (environment.connection.phase !== "connected") continue;
    for (const provider of environment.serverConfig?.providers ?? []) {
      if (!provider.enabled || !provider.installed || !provider.usageLimits) continue;
      const email = provider.auth.email?.trim();
      const key = JSON.stringify([
        provider.driver,
        email?.toLowerCase() || [environment.environmentId, provider.instanceId],
      ]);
      const workspace = { id: environment.environmentId, label: environment.label };
      const previous = accounts.get(key);
      if (previous) {
        if (!previous.workspaces.some(({ id }) => id === workspace.id))
          previous.workspaces.push(workspace);
        if (Date.parse(provider.usageLimits.checkedAt) > Date.parse(previous.limits.checkedAt)) {
          previous.limits = provider.usageLimits;
        }
      } else {
        accounts.set(key, {
          key,
          driver: provider.driver,
          label: email || provider.displayName || provider.instanceId,
          workspaces: [workspace],
          limits: provider.usageLimits,
        });
      }
    }
  }
  return [...accounts.values()];
}
