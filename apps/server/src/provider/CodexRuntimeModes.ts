import type { RuntimeMode } from "@t3tools/contracts";
import type * as CodexSchema from "effect-codex-app-server/schema";

import { ALL_RUNTIME_MODES, SAFE_RUNTIME_MODES } from "./runtimeModeCapabilities.ts";

export type CodexRuntimeModeConfig = {
  readonly approvalPolicy: CodexSchema.V2ThreadStartParams__AskForApproval;
  readonly sandbox: CodexSchema.V2ThreadStartParams__SandboxMode;
  readonly approvalsReviewer: CodexSchema.V2ThreadStartParams__ApprovalsReviewer;
  readonly turnSandboxPolicy: CodexSchema.V2TurnStartParams__SandboxPolicy;
};

export const CODEX_RUNTIME_MODE_CONFIG = {
  "approval-required": {
    approvalPolicy: "untrusted",
    sandbox: "read-only",
    approvalsReviewer: "user",
    turnSandboxPolicy: { type: "readOnly" },
  },
  "auto-accept-edits": {
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    approvalsReviewer: "user",
    turnSandboxPolicy: { type: "workspaceWrite" },
  },
  auto: {
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    approvalsReviewer: "auto_review",
    turnSandboxPolicy: { type: "workspaceWrite" },
  },
  "full-access": {
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    approvalsReviewer: "user",
    turnSandboxPolicy: { type: "dangerFullAccess" },
  },
} as const satisfies Readonly<Record<RuntimeMode, CodexRuntimeModeConfig>>;

export function getCodexRuntimeModeConfig(runtimeMode: RuntimeMode): CodexRuntimeModeConfig {
  return CODEX_RUNTIME_MODE_CONFIG[runtimeMode];
}

export function resolveCodexSupportedRuntimeModes(
  response: CodexSchema.V2ConfigRequirementsReadResponse | undefined,
): ReadonlyArray<RuntimeMode> {
  if (response === undefined) return SAFE_RUNTIME_MODES;
  const requirements = response.requirements;
  if (!requirements) return ALL_RUNTIME_MODES;

  return ALL_RUNTIME_MODES.filter((mode) => {
    const config = CODEX_RUNTIME_MODE_CONFIG[mode];
    const approvalAllowed =
      requirements.allowedApprovalPolicies == null ||
      requirements.allowedApprovalPolicies.includes(config.approvalPolicy);
    const sandboxAllowed =
      requirements.allowedSandboxModes == null ||
      requirements.allowedSandboxModes.includes(config.sandbox);
    return approvalAllowed && sandboxAllowed;
  });
}
