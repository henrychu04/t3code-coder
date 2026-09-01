import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  CODEX_RUNTIME_MODE_CONFIG,
  decodeCodexRuntimeRequirementsResponse,
  resolveCodexSupportedRuntimeModes,
} from "./CodexRuntimeModes.ts";

it("uses the exact Codex runtime configuration for each access mode", () => {
  assert.deepStrictEqual(CODEX_RUNTIME_MODE_CONFIG, {
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
  });
});

it("shows all modes when Codex reports no managed requirements", () => {
  assert.deepStrictEqual(resolveCodexSupportedRuntimeModes({ requirements: null }), [
    "approval-required",
    "auto-accept-edits",
    "auto",
    "full-access",
  ]);
});

it("filters modes using Codex approval and sandbox requirements", () => {
  assert.deepStrictEqual(
    resolveCodexSupportedRuntimeModes({
      requirements: {
        allowedApprovalPolicies: ["on-request"],
        allowedSandboxModes: ["workspace-write"],
      },
    }),
    ["auto-accept-edits", "auto"],
  );
});

it.effect("preserves and enforces Codex's experimental reviewer requirements", () =>
  Effect.gen(function* () {
    const response = yield* decodeCodexRuntimeRequirementsResponse({
      requirements: {
        allowedApprovalPolicies: ["on-request"],
        allowedApprovalsReviewers: ["user"],
        allowedSandboxModes: ["workspace-write"],
        ignoredFutureRequirement: true,
      },
    });

    assert.deepStrictEqual(response.requirements?.allowedApprovalsReviewers, ["user"]);
    assert.deepStrictEqual(resolveCodexSupportedRuntimeModes(response), ["auto-accept-edits"]);
  }),
);

it("fails closed when requirements cannot be read", () => {
  assert.deepStrictEqual(resolveCodexSupportedRuntimeModes(undefined), [
    "approval-required",
    "auto-accept-edits",
  ]);
});

it("returns no modes when policy excludes every supported configuration", () => {
  assert.deepStrictEqual(
    resolveCodexSupportedRuntimeModes({
      requirements: {
        allowedApprovalPolicies: [],
        allowedSandboxModes: [],
      },
    }),
    [],
  );
});
