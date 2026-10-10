// @effect-diagnostics globalProcess:off -- The helper runs only inside a Linux Coder workspace.
import {
  EnvironmentId,
  type ExecutionEnvironmentCapabilities,
  type ExecutionEnvironmentDescriptor,
  ORCHESTRATION_PROTOCOL_VERSION,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import packageJson from "../package.json" with { type: "json" };
import * as ServerConfig from "./config.ts";

export class CoderEnvironment extends Context.Service<
  CoderEnvironment,
  { readonly descriptor: ExecutionEnvironmentDescriptor }
>()("t3/coderEnvironment") {}

// Coder: upstream's capabilities minus the cut surfaces in CODER_OMITTED_CAPABILITIES. Every
// key of ExecutionEnvironmentCapabilities must appear in exactly one of the two.
export const CODER_ENVIRONMENT_CAPABILITIES = {
  repositoryIdentity: true,
  connectionProbe: true,
  // Composer images and files stage through the gateway's SCP path.
  attachmentUploads: true,
  questionAttachments: true,
  fileAttachments: { maxUploadBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES },
  pullRequests: true,
  pullRequestChecks: true,
  inlineMessageContext: true,
  requiredWorktreeBootstrap: true,
  threadSettlement: true,
  threadAutoSettlement: true,
  storageCleanup: true,
  storageCleanupRun: true,
  projectWorktreeCleanup: true,
  worktreesDirectory: true,
  threadRestartContinuation: true,
  projectSettingsOverrides: true,
  threadSnooze: true,
  environmentThemes: true,
  threadPinning: true,
  threadPinReorder: true,
  threadActiveReorder: true,
  threadAutoSettleOptOut: true,
  threadTitleRegeneration: true,
  threadVisitedTracking: true,
  threadPullRequests: true,
  threadPullRequestWatch: true,
  threadPullRequestLinking: true,
  serverResolvedCommandContext: true,
  environmentIcon: true,
  projectCloneTracking: true,
} satisfies ExecutionEnvironmentCapabilities;

export const CODER_OMITTED_CAPABILITIES = {
  usageLimitSources: "No usage dashboard or usage-limit sources (API usage only).",
  usagePriceOverrides: "No usage dashboard.",
  usageModelAliases: "No usage dashboard.",
  pullRequestStackActions: "GitLab has no native stack actions.",
  serverSelfUpdate: "No server self-update; the gateway installs the helper from the checkout.",
  serverInstallation: "No server self-update.",
  serverSelfUpdateProgress: "No server self-update.",
  serverUpdateThreadContinuation: "No server self-update.",
  agentActivityPublishing: "No relay, push notifications, or Live Activities.",
  desktopAppUpdate: "No desktop app.",
  serverBrowser: "No browser preview.",
} satisfies Partial<Record<keyof ExecutionEnvironmentCapabilities, string>>;

const platformArch = (): ExecutionEnvironmentDescriptor["platform"]["arch"] => {
  if (process.arch === "arm64" || process.arch === "x64") return process.arch;
  return "other";
};

export const layer = Layer.effect(
  CoderEnvironment,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const existing = yield* fileSystem.readFileString(config.environmentIdPath).pipe(
      Effect.map((value) => value.trim()),
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
      ),
    );
    const environmentId = EnvironmentId.make(
      existing.length > 0 ? existing : yield* crypto.randomUUIDv4,
    );
    const configuredLabel = process.env.T3_CODER_WORKSPACE_LABEL?.trim();
    if (existing.length === 0) {
      yield* fileSystem.writeFileString(config.environmentIdPath, `${environmentId}\n`);
    }
    return CoderEnvironment.of({
      descriptor: {
        environmentId,
        label: configuredLabel || path.basename(config.cwd) || "Coder workspace",
        platform: { os: "linux", arch: platformArch() },
        serverVersion: process.env.T3_CODER_BUILD_VERSION?.trim() || packageJson.version,
        orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
        capabilities: CODER_ENVIRONMENT_CAPABILITIES,
      },
    });
  }),
);
