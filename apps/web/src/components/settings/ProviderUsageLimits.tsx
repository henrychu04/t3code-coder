import type { ServerProviderUsageLimits } from "@t3tools/contracts";

/** Read-only quota snapshots from the workspace provider, never a browser-side account probe. */
export function ProviderUsageLimits({
  limits,
}: {
  readonly limits: ServerProviderUsageLimits | undefined;
}) {
  if (!limits) return null;
  return (
    <section
      aria-label="Subscription limits"
      className="space-y-2 border-b border-border/70 px-4 py-3 text-xs"
    >
      <div className="flex flex-wrap justify-between gap-2">
        <span className="font-medium">Subscription limits</span>
        <span className="text-muted-foreground">
          Checked{" "}
          <time dateTime={limits.checkedAt}>{new Date(limits.checkedAt).toLocaleString()}</time>
        </span>
      </div>
      {limits.unavailable ? (
        <p className="text-muted-foreground">
          {limits.unavailable.reason === "unsupported"
            ? "Subscription limits are not available for this account."
            : "Could not read subscription limits from the workspace provider."}
        </p>
      ) : limits.windows.length === 0 ? (
        <p className="text-muted-foreground">No quota windows reported.</p>
      ) : (
        limits.windows.map((window) => (
          <div key={window.id} className="space-y-1">
            <div className="flex justify-between gap-2">
              <span>{window.label}</span>
              <span>{Math.round(window.usedPercent)}% used</span>
            </div>
            <progress
              aria-label={window.label}
              value={window.usedPercent}
              max={100}
              className="h-1.5 w-full accent-primary"
            />
            {window.resetsAt ? (
              <p className="text-muted-foreground">
                Resets{" "}
                <time dateTime={window.resetsAt}>{new Date(window.resetsAt).toLocaleString()}</time>
              </p>
            ) : null}
          </div>
        ))
      )}
    </section>
  );
}
