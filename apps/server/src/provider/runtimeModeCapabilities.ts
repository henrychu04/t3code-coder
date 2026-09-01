import type { ModelCapabilities, RuntimeMode, ServerProviderModel } from "@t3tools/contracts";

export const SAFE_RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
] as const satisfies ReadonlyArray<RuntimeMode>;

export const ALL_RUNTIME_MODES = [
  ...SAFE_RUNTIME_MODES,
  "auto",
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;

export function buildSupportedRuntimeModes(input: {
  readonly approvalRequired?: boolean;
  readonly autoAcceptEdits?: boolean;
  readonly auto?: boolean;
  readonly fullAccess?: boolean;
}): ReadonlyArray<RuntimeMode> {
  return ALL_RUNTIME_MODES.filter((mode) => {
    switch (mode) {
      case "approval-required":
        return input.approvalRequired ?? true;
      case "auto-accept-edits":
        return input.autoAcceptEdits ?? true;
      case "auto":
        return input.auto ?? false;
      case "full-access":
        return input.fullAccess ?? false;
    }
  });
}

export function withSupportedRuntimeModes(
  capabilities: ModelCapabilities | null | undefined,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode>,
): ModelCapabilities {
  if (!capabilities) {
    return { supportedRuntimeModes };
  }
  return {
    ...capabilities,
    supportedRuntimeModes,
  };
}

export function attachSupportedRuntimeModes(
  models: ReadonlyArray<ServerProviderModel>,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode>,
): ReadonlyArray<ServerProviderModel> {
  return models.map((model) => ({
    ...model,
    capabilities: withSupportedRuntimeModes(model.capabilities, supportedRuntimeModes),
  }));
}
