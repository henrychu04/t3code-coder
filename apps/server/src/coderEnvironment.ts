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
import * as Schema from "effect/Schema";

import packageJson from "../package.json" with { type: "json" };
import * as ServerConfig from "./config.ts";

export class CoderEnvironment extends Context.Service<
  CoderEnvironment,
  { readonly descriptor: ExecutionEnvironmentDescriptor }
>()("t3/coderEnvironment") {}

// Coder: upstream's `environment/ServerEnvironment.ts` identity service and its persisted id
// (`makeIdentity`, ported as is). That module's descriptor service is not carried;
// `CoderEnvironment` builds the descriptor from this identity.
export class ServerEnvironmentIdPersistenceError extends Schema.TaggedError<ServerEnvironmentIdPersistenceError>()(
  "ServerEnvironmentIdPersistenceError",
  {
    operation: Schema.Literals(["check", "read", "write", "initialize"]),
    environmentIdPath: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.operation === "initialize") {
      return `Server environment ID file is missing or empty after initialization at '${this.environmentIdPath}'.`;
    }
    return `Server environment ID ${this.operation} failed at '${this.environmentIdPath}'.`;
  }
}

export class ServerEnvironmentIdentity extends Context.Service<
  ServerEnvironmentIdentity,
  {
    readonly getEnvironmentId: Effect.Effect<EnvironmentId>;
  }
>()("t3/environment/ServerEnvironment/ServerEnvironmentIdentity") {}

// Coder: upstream's capabilities minus the cut surfaces in CODER_OMITTED_CAPABILITIES. Every
// key of ExecutionEnvironmentCapabilities must appear in exactly one of the two.
export const CODER_ENVIRONMENT_CAPABILITIES = {
  repositoryIdentity: true,
  connectionProbe: true,
  // Composer images and files reach the workspace through the gateway's Coder CLI transfer.
  attachmentUploads: true,
  questionAttachments: true,
  fileAttachments: { maxUploadBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES },
  pullRequests: true,
  pullRequestChecks: true,
  sideChats: true,
  inlineMessageContext: true,
  requiredWorktreeBootstrap: true,
  threadSettlement: true,
  threadAutoSettlement: true,
  storageCleanup: true,
  storageCleanupRun: true,
  settledWorktreeCleanup: true,
  threadAutoSettlementScope: true,
  commandOutputStreaming: true,
  projectWorktreeCleanup: true,
  worktreesDirectory: true,
  threadRestartContinuation: true,
  projectSettingsOverrides: true,
  projectProviderInstanceOverrides: true,
  threadSnooze: true,
  threadForceStop: true,
  environmentThemes: true,
  providerWorkspaceSnapshotsOnDemand: true,
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
  threadStop: true,
  environmentIcon: true,
  projectCloneTracking: true,
  projectOrganization: true,
  threadProjectFromScratch: true,
  // Links are the gateway's workspace link rules; calls between workspaces go through its hub.
  peerLinks: true,
  linkFence: true,
} satisfies ExecutionEnvironmentCapabilities;

export const CODER_OMITTED_CAPABILITIES = {
  usageLimitSources: "No usage dashboard or usage-limit sources (API usage only).",
  usagePriceOverrides: "No usage dashboard.",
  usageModelAliases: "No usage dashboard.",
  pullRequestStackActions: "GitLab has no native stack actions.",
  otlpEndpointCheck: "No OpenTelemetry export settings or trace export.",
  serverSelfUpdate: "No server self-update; the gateway installs the helper from the checkout.",
  npmReleaseLookup: "No server self-update, the only reader of `server.getNpmRelease`.",
  serverInstallation: "No server self-update.",
  serverSelfUpdateProgress: "No server self-update.",
  serverUpdateThreadContinuation: "No server self-update.",
  agentActivityPublishing: "No relay, push notifications, or Live Activities.",
  desktopAppUpdate: "No desktop app.",
  desktopAppChannelSwitch: "No desktop app.",
  serverBrowser: "No browser preview.",
  databaseStorage: "No `t3 doctor` in the workspace helper; it compacts and reclaims space itself.",
  ignoredFileListing:
    "No Add to another machine: ignored files such as .env would pass through the laptop browser.",
  mcpModeLimitHeader:
    "No /mcp HTTP server; the gateway hub carries a linked call's mode limits with the call.",
  localServerStop: "No dev-server port discovery: the browser preview is not carried.",
  triage: "No in-app triage: it clones upstream T3 Code to help file upstream issues.",
} satisfies Partial<Record<keyof ExecutionEnvironmentCapabilities, string>>;

const makeIdentity = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;

  const readPersistedEnvironmentId = Effect.gen(function* () {
    const exists = yield* fileSystem.exists(serverConfig.environmentIdPath).pipe(
      Effect.mapError(
        (cause) =>
          new ServerEnvironmentIdPersistenceError({
            operation: "check",
            environmentIdPath: serverConfig.environmentIdPath,
            cause,
          }),
      ),
    );
    if (!exists) {
      return null;
    }

    const raw = yield* fileSystem.readFileString(serverConfig.environmentIdPath).pipe(
      Effect.map((value) => value.trim()),
      Effect.mapError(
        (cause) =>
          new ServerEnvironmentIdPersistenceError({
            operation: "read",
            environmentIdPath: serverConfig.environmentIdPath,
            cause,
          }),
      ),
    );

    return raw.length > 0 ? raw : null;
  });

  const persistEnvironmentId = Effect.fn("ServerEnvironmentIdentity.persistEnvironmentId")(
    function* (value: string, mode: "create" | "recover") {
      const destinationPath =
        mode === "recover"
          ? `${serverConfig.environmentIdPath}.recovery`
          : serverConfig.environmentIdPath;
      const tempPath = yield* fileSystem.makeTempFileScoped({
        directory: serverConfig.stateDir,
        prefix: ".environment-id-",
      });
      yield* fileSystem.writeFileString(tempPath, `${value}\n`);
      // Publish the completed file without replacing an ID created by another process.
      yield* fileSystem.link(tempPath, destinationPath).pipe(
        Effect.catchIf(
          (cause) => cause.reason._tag === "AlreadyExists",
          () => Effect.void,
        ),
      );
      if (mode === "recover") {
        // Keep the recovery ID so delayed initializers also publish the same winner.
        yield* fileSystem.remove(tempPath);
        yield* fileSystem.copyFile(destinationPath, tempPath);
        yield* fileSystem.rename(tempPath, serverConfig.environmentIdPath);
      }
    },
    Effect.scoped,
    Effect.mapError(
      (cause) =>
        new ServerEnvironmentIdPersistenceError({
          operation: "write",
          environmentIdPath: serverConfig.environmentIdPath,
          cause,
        }),
    ),
  );

  const environmentIdRaw = yield* Effect.gen(function* () {
    const persisted = yield* readPersistedEnvironmentId;
    if (persisted) {
      return persisted;
    }

    const generated = yield* crypto.randomUUIDv4();
    yield* persistEnvironmentId(generated, "create");
    let winner = yield* readPersistedEnvironmentId;
    if (winner === null) {
      yield* persistEnvironmentId(generated, "recover");
      winner = yield* readPersistedEnvironmentId;
    }
    if (winner === null) {
      return yield* new ServerEnvironmentIdPersistenceError({
        operation: "initialize",
        environmentIdPath: serverConfig.environmentIdPath,
      });
    }
    return winner;
  });

  const environmentId = EnvironmentId.make(environmentIdRaw);
  return ServerEnvironmentIdentity.of({
    getEnvironmentId: Effect.succeed(environmentId),
  });
});

export const layerIdentity = Layer.effect(ServerEnvironmentIdentity, makeIdentity);

const platformArch = (): ExecutionEnvironmentDescriptor["platform"]["arch"] => {
  if (process.arch === "arm64" || process.arch === "x64") return process.arch;
  return "other";
};

/** The workspace descriptor; provides upstream's identity service with it, as upstream's `layer`. */
export const layer = Layer.effect(
  CoderEnvironment,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const environmentId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
    const configuredLabel = process.env.T3_CODER_WORKSPACE_LABEL?.trim();
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
).pipe(Layer.provideMerge(layerIdentity));
