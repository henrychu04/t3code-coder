import type { ProviderInstanceId } from "@t3tools/contracts";

const CODER_PROVIDER_INSTANCE_IDS: ReadonlySet<string> = new Set(["codex", "claudeAgent"]);

/** Provider instances exposed by T3 Coder's provider picker. */
export function isCoderProviderInstanceId(instanceId: ProviderInstanceId): boolean {
  return CODER_PROVIDER_INSTANCE_IDS.has(instanceId);
}
