import type { ProviderInstanceId } from "@t3tools/contracts";

export function shouldResetTextGenerationSelectionOnDisable(input: {
  readonly instanceId: ProviderInstanceId;
  readonly selectedInstanceId: ProviderInstanceId;
  readonly wasEnabled: boolean;
  readonly nextEnabled: boolean | undefined;
}): boolean {
  return (
    input.wasEnabled && input.nextEnabled === false && input.selectedInstanceId === input.instanceId
  );
}
