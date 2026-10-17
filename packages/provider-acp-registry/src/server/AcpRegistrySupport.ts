// Coder: only upstream's local-command source is carried. The ACP Registry index, its search,
// and its binary, npx, and uvx installs are not: Kilo Code is already installed in the workspace.
import { AcpRegistryOperationError, AcpRegistryOperationErrorReason } from "@t3tools/contracts";
import type { AcpRegistrySettings } from "../settings.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AcpRegistryRuntimeCoordinator from "./AcpRegistryRuntimeCoordinator.ts";
import * as Schema from "effect/Schema";

import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

export const AcpRegistryErrorReason = AcpRegistryOperationErrorReason;
export type AcpRegistryErrorReason = typeof AcpRegistryErrorReason.Type;

export class AcpRegistryError extends Schema.TaggedError<AcpRegistryError>()("AcpRegistryError", {
  reason: AcpRegistryErrorReason,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

export function toAcpRegistryOperationError(error: AcpRegistryError): AcpRegistryOperationError {
  return new AcpRegistryOperationError({
    reason: error.reason,
    message: error.detail,
    cause: error,
  });
}

export interface ResolvedAcpRegistryAgent {
  readonly distribution: "local";
  readonly spawn: AcpSessionRuntime.AcpSpawnInput;
}

export type AcpRegistryInspection =
  | { readonly status: "unconfigured" }
  | {
      readonly status: "missing_runner";
      readonly version: null;
      readonly distribution: "local";
    }
  | {
      readonly status: "ready";
      readonly agentId: string;
      readonly version: string | null;
      readonly distribution: "local";
    };

export class AcpRegistryCatalog extends Context.Service<
  AcpRegistryCatalog,
  {
    readonly inspect: (
      settings: AcpRegistrySettings,
      environment?: NodeJS.ProcessEnv,
    ) => Effect.Effect<AcpRegistryInspection, AcpRegistryError>;
    readonly resolve: (
      settings: AcpRegistrySettings,
      cwd: string,
      environment?: NodeJS.ProcessEnv,
    ) => Effect.Effect<ResolvedAcpRegistryAgent, AcpRegistryError>;
  }
>()("@t3tools/provider-acp-registry/server/AcpRegistrySupport/AcpRegistryCatalog") {}

export const makeAcpRegistryCatalog = Effect.fn("AcpRegistryCatalog.make")(function* () {
  const platform = yield* HostProcess.Platform;
  const hostEnvironment = yield* HostProcess.Environment;
  const resolveExecutable = yield* SpawnExecutableResolution;

  const validateLocalExecutable = (command: string) =>
    platform === "win32" && /\.(?:cmd|bat)$/iu.test(command)
      ? Effect.fail(
          new AcpRegistryError({
            reason: "runner_unavailable",
            detail:
              "Local ACP commands launch without a shell. For a Windows batch wrapper, configure the underlying executable (for example node.exe) and pass the script path as an argument.",
          }),
        )
      : Effect.void;

  const inspect: AcpRegistryCatalog["Service"]["inspect"] = (settings, environment) =>
    Effect.gen(function* () {
      const command = settings.commandPath.trim();
      if (!command) return { status: "unconfigured" } as const;
      const executable = resolveExecutable(command, platform, environment ?? hostEnvironment);
      if (executable !== undefined) yield* validateLocalExecutable(executable);
      return executable === undefined
        ? ({
            status: "missing_runner",
            version: null,
            distribution: "local",
          } as const)
        : ({ status: "ready", agentId: command, version: null, distribution: "local" } as const);
    });

  const resolve: AcpRegistryCatalog["Service"]["resolve"] = (settings, cwd, environment) =>
    Effect.gen(function* () {
      const executable = settings.commandPath.trim();
      if (!executable) {
        return yield* new AcpRegistryError({
          reason: "agent_not_configured",
          detail: "Local ACP provider requires an executable.",
        });
      }
      const env = environment ?? hostEnvironment;
      const command = resolveExecutable(executable, platform, env);
      if (command === undefined) {
        return yield* new AcpRegistryError({
          reason: "runner_unavailable",
          detail: "Local ACP executable is not available on this environment's PATH.",
        });
      }
      yield* validateLocalExecutable(command);
      return {
        distribution: "local",
        spawn: { command, args: settings.commandArgs, cwd, env, shell: false },
      } satisfies ResolvedAcpRegistryAgent;
    });

  return AcpRegistryCatalog.of({ inspect, resolve });
});

export const layerFromHost = Layer.merge(
  Layer.effect(AcpRegistryCatalog, makeAcpRegistryCatalog()),
  AcpRegistryRuntimeCoordinator.layer,
);
