import type { ProviderDriverKind } from "@t3tools/contracts";

const CODER_PROVIDER_DRIVERS: ReadonlySet<string> = new Set(["codex", "claudeAgent"]);

/** Provider drivers T3 Coder registers; any instance of these drivers may be used. */
export function isCoderProviderDriver(driver: ProviderDriverKind): boolean {
  return CODER_PROVIDER_DRIVERS.has(driver);
}
