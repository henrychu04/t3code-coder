// Coder: the adapter runs only Kilo Code from its local command. Upstream's per-agent flavors
// (Devin, GitHub Copilot, Mistral Vibe), URL authentication, and native protocol logging are not
// carried, and T3 tools reach the agent over the workspace file bridge rather than a
// self-invoked MCP bridge.
import { defaultInstanceIdForDriver, ProviderDriverKind } from "@t3tools/contracts";
import { readCustomModelEntries } from "@t3tools/shared/model";
import { AcpRegistrySettings } from "../settings.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { normalizeAcpRegistryCommands, normalizeAcpRegistryLiveConfiguration } from "./probe.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import * as AcpRegistryRuntimeCoordinator from "./AcpRegistryRuntimeCoordinator.ts";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";

export const ACP_REGISTRY_PROVIDER = ProviderDriverKind.make("acpRegistry");
export const ACP_REGISTRY_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(ACP_REGISTRY_PROVIDER);

const DEFAULT_ACP_REGISTRY_SETTINGS = Schema.decodeSync(AcpRegistrySettings)({});
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

export interface AcpRegistryAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: AcpRegistrySettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
  >;
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
  readonly assertComplete?: Effect.Effect<void, EffectAcpErrors.AcpError>;
}

export function acpRegistryPromptFailure(cause: unknown) {
  return makeProviderFailure({
    cause,
    ...(isAcpRequestError(cause)
      ? {
          message: cause.errorMessage,
          code: String(cause.code),
          class: "provider_error" as const,
        }
      : { class: "provider_error" as const }),
  });
}

function makeAcpRegistryRuntime(
  options: AcpRegistryAdapterV2Options,
  catalog: AcpRegistrySupport.AcpRegistryCatalog["Service"],
) {
  return (
    input: AcpAdapterV2RuntimeInput,
  ): Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
  > =>
    Effect.gen(function* () {
      const { processEnvironment, ...runtimeInput } = input;
      const resolved = yield* catalog
        .resolve(options.settings, input.cwd, options.environment)
        .pipe(
          Effect.mapError(
            (cause) =>
              new EffectAcpErrors.AcpSpawnError({
                command: options.settings.commandPath || ACP_REGISTRY_PROVIDER,
                cause,
              }),
          ),
        );
      const context = yield* Layer.build(
        AcpSessionRuntime.layer({
          ...runtimeInput,
          spawn:
            processEnvironment === undefined
              ? resolved.spawn
              : {
                  ...resolved.spawn,
                  env: { ...resolved.spawn.env, ...processEnvironment },
                },
          customModels: readCustomModelEntries(options.settings.customModels).map(
            (entry) => entry.slug,
          ),
          // Coder: T3 starts no agent sign-in; an unauthenticated Kilo Code fails the session.
          authenticateOnAuthRequired: false,
        }),
      );
      return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
        Effect.provide(context),
      );
    });
}

export const makeAcpRegistryAdapterV2 = Effect.fn("makeAcpRegistryAdapterV2")(function* (
  options: AcpRegistryAdapterV2Options,
) {
  const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
  const runtimeCoordinator = Option.getOrUndefined(
    yield* Effect.serviceOption(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator),
  );
  const startupKey = `local:${options.instanceId}`;
  const flavor: AcpAdapterV2Flavor = {
    driver: ACP_REGISTRY_PROVIDER,
    capabilities: AcpProviderCapabilitiesV2,
    customModels: readCustomModelEntries(options.settings.customModels).map((entry) => entry.slug),
    promptFailure: acpRegistryPromptFailure,
    makeRuntime: options.makeRuntime ?? makeAcpRegistryRuntime(options, catalog),
    ...(runtimeCoordinator === undefined
      ? {}
      : {
          onAvailableCommandsUpdate: (commands) =>
            runtimeCoordinator.publishAvailableCommands(
              options.instanceId,
              normalizeAcpRegistryCommands(commands),
            ),
          onSessionConfigurationUpdate: (configOptions, modeState, modelState) =>
            runtimeCoordinator.publishLiveConfiguration(
              options.instanceId,
              normalizeAcpRegistryLiveConfiguration(configOptions, modeState, modelState),
            ),
          withRuntimeStartup: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            runtimeCoordinator.withForegroundStartup(startupKey, effect),
        }),
    ...(options.assertComplete === undefined ? {} : { assertComplete: options.assertComplete }),
  };
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor,
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
  });
});

export type AcpRegistryAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | AcpRegistrySupport.AcpRegistryCatalog
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderHost.ProviderHost;

export const AcpRegistryAdapterV2Driver: ProviderAdapterDriver<
  AcpRegistrySettings,
  AcpRegistryAdapterV2DriverEnv
> = {
  driverKind: ACP_REGISTRY_PROVIDER,
  configSchema: AcpRegistrySettings,
  defaultConfig: (): AcpRegistrySettings => DEFAULT_ACP_REGISTRY_SETTINGS,
  create: Effect.fn("AcpRegistryAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<AcpRegistrySettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      return yield* makeAcpRegistryAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        continuationRequests: yield* ProviderContinuationRequests.ProviderContinuationRequests,
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: ACP_REGISTRY_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create the Kilo Code adapter.",
              cause,
            }),
        ),
      ),
  ),
};
