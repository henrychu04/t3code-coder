import { useEnvironments } from "../../state/environments";
import { SettingsSection } from "./SettingsPage";
import { ProviderUsageLimits } from "./ProviderUsageLimits";
import { collectNativeUsageAccounts } from "./NativeUsageOverview.logic";

export function NativeUsageOverview() {
  const { environments } = useEnvironments();
  const accounts = collectNativeUsageAccounts(environments);
  return (
    <SettingsSection
      title="Subscription limits across workspaces"
      description="The latest reported limits from connected workspaces. Shared accounts appear once; different subscriptions keep their own limits."
    >
      {accounts.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">
          No native subscription limits reported by connected workspaces.
        </p>
      ) : (
        accounts.map((account) => (
          <section
            key={account.key}
            aria-label={`${account.driver === "claudeAgent" ? "Claude" : "Codex"} · ${account.label}`}
          >
            <div className="px-4 pt-3 text-sm">
              <p className="font-medium">
                {account.driver === "claudeAgent" ? "Claude" : "Codex"} · {account.label}
              </p>
              <p className="text-xs text-muted-foreground">
                {account.workspaces.map(({ label }) => label).join(", ")}
              </p>
            </div>
            <ProviderUsageLimits limits={account.limits} />
          </section>
        ))
      )}
    </SettingsSection>
  );
}
