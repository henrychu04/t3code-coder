// Coder: the driver runs only Kilo Code from its local command. Upstream's registry readiness
// states, registry icons, agent sign-in (its auth controller, confirmed-authentication cache, and
// URL authentication action), native session deletion, logout, and provider management are not
// carried; native session listing is.
import {
  ProviderDriverKind,
  TextGenerationError,
  type AcpRegistryOperationError,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { AcpRegistrySettings } from "../settings.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { AcpRegistryAdapterV2Driver, type AcpRegistryAdapterV2DriverEnv } from "./adapter.ts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { providerModelsFromSettings } from "@t3tools/provider-core/server/snapshotProbe";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import {
  type AcpRegistryAvailableCommands,
  type AcpRegistryConfigurationProbe,
  type AcpRegistryConfigurationProbeResult,
  type AcpRegistryLiveConfiguration,
  listAcpRegistrySessions,
  probeAcpRegistryConfiguration,
} from "./probe.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import * as AcpRegistryRuntimeCoordinator from "./AcpRegistryRuntimeCoordinator.ts";

const DRIVER_KIND = ProviderDriverKind.make("acpRegistry");
const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
// Cache only successful authenticated probes so sign-in changes remain visible.
const PROBE_SUCCESS_TTL_MS = 15 * 60 * 1_000;
const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

const makeUnsupportedTextGeneration = (): ProviderTextGeneration => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "Kilo Code instances do not provide application text generation.",
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
    generateReviewGuide: () => unsupported("generateReviewGuide"),
  };
};

function modelsFromDiscovery(
  discovery:
    | Pick<AcpRegistryLiveConfiguration, "models" | "currentModelId" | "configOptions">
    | undefined,
  customModels: ReadonlyArray<string>,
): ReadonlyArray<ServerProviderModel> {
  const discovered = discovery?.models ?? [];
  const capabilities =
    discovery === undefined || discovery.configOptions.length === 0
      ? EMPTY_CAPABILITIES
      : createModelCapabilities({ optionDescriptors: discovery.configOptions });
  const builtInModels: ReadonlyArray<ServerProviderModel> =
    discovered.length === 0
      ? [
          {
            slug: "default",
            name: "Default",
            isCustom: false,
            isDefault: true,
            capabilities,
          },
        ]
      : discovered.map((model) => ({
          slug: model.id,
          name: model.name,
          isCustom: false,
          ...(model.id === discovery?.currentModelId ? { isDefault: true } : {}),
          capabilities,
        }));
  return providerModelsFromSettings(builtInModels, customModels, capabilities);
}

// Coder: exported for the Kilo Code readiness test in driver.test.ts.
export function acpRegistrySnapshotReadiness(
  inspection:
    | AcpRegistrySupport.AcpRegistryInspection
    | { readonly status: "failed"; readonly message: string },
): Pick<ServerProvider, "installed" | "version" | "status" | "message"> {
  switch (inspection.status) {
    case "ready":
      return { installed: true, version: inspection.version, status: "ready" };
    case "unconfigured":
      return {
        installed: false,
        version: null,
        status: "warning",
        message: "Configure the Kilo Code executable before starting a thread.",
      };
    case "missing_runner":
      return {
        installed: false,
        version: null,
        status: "error",
        message: "Kilo Code is not available on this workspace's PATH.",
      };
    case "failed":
      return {
        installed: false,
        version: null,
        status: "error",
        message: inspection.message,
      };
  }
}

interface SnapshotIdentity {
  readonly instanceId: ProviderInstance["instanceId"];
  readonly displayName: string | undefined;
  readonly accentColor: string | undefined;
  readonly continuationKey: string;
}

function baseSnapshot(
  input: SnapshotIdentity & {
    readonly settings: AcpRegistrySettings;
    readonly checkedAt: string;
    readonly installed: boolean;
    readonly version: string | null;
    readonly status: ServerProvider["status"];
    readonly auth: ServerProvider["auth"];
    readonly message?: string;
    readonly probe?: AcpRegistryConfigurationProbeResult;
    readonly probeError?: AcpRegistryOperationError;
  },
): ServerProvider {
  return {
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationKey },
    supportsTextGeneration: false,
    enabled: input.settings.enabled,
    installed: input.installed,
    version: input.version,
    status: input.settings.enabled ? input.status : "disabled",
    auth: { ...input.auth, canLogout: input.auth.canLogout ?? false },
    checkedAt: input.checkedAt,
    setup: { canInstall: false, canAuthenticate: false },
    ...(input.message ? { message: input.message } : {}),
    models: modelsFromDiscovery(input.probe?.probe, input.settings.customModels),
    // Coder: no provider configuration, so no `configurableProviders`.
    ...(input.probe === undefined
      ? {}
      : {
          nativeSessions: {
            canList: input.probe.probe.sessionManagement.canList,
            canLoad: input.probe.probe.sessionManagement.canLoad,
            canResume: input.probe.probe.sessionManagement.canResume,
            canDelete: input.probe.probe.sessionManagement.canDelete,
          },
        }),
    slashCommands: input.probe?.slashCommands ?? [],
    skills: input.probe?.skills ?? [],
  };
}

export function applyAcpRegistryAvailableCommands(
  provider: ServerProvider,
  commands: Option.Option<AcpRegistryAvailableCommands>,
): ServerProvider {
  return Option.match(commands, {
    onNone: () => provider,
    onSome: ({ slashCommands, skills }) => ({ ...provider, slashCommands, skills }),
  });
}

export function applyAcpRegistryLiveConfiguration(
  provider: ServerProvider,
  configuration: AcpRegistryLiveConfiguration,
  customModels: ReadonlyArray<string>,
): ServerProvider {
  const { message: _staleProbeMessage, ...snapshot } = provider;
  return {
    ...snapshot,
    status: provider.enabled ? "ready" : provider.status,
    models: modelsFromDiscovery(configuration, customModels),
  };
}

const buildInitialAcpRegistrySnapshot = Effect.fn("AcpRegistryDriver.buildInitialSnapshot")(
  function* (input: SnapshotIdentity & { readonly settings: AcpRegistrySettings }) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return baseSnapshot({
      ...input,
      checkedAt,
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: input.settings.enabled
        ? "Checking Kilo Code readiness..."
        : "Kilo Code is disabled in T3 Code settings.",
    });
  },
);

export function buildCheckedAcpRegistrySnapshot(
  input: SnapshotIdentity & {
    readonly settings: AcpRegistrySettings;
    readonly checkedAt: string;
    readonly inspection:
      | AcpRegistrySupport.AcpRegistryInspection
      | { readonly status: "failed"; readonly message: string };
    readonly probe?: AcpRegistryConfigurationProbeResult;
    readonly probeError?: AcpRegistryOperationError;
  },
): ServerProvider {
  const readiness = acpRegistrySnapshotReadiness(input.inspection);
  const probeFailed = input.probeError !== undefined;
  const advertisedAuthMethod =
    input.probeError?.reason === "authentication_failed"
      ? input.probeError.authMethods?.[0]
      : undefined;
  const authenticationMessage =
    input.probeError?.reason === "authentication_failed"
      ? "Kilo Code is not signed in. Sign in to Kilo Code in the workspace, then refresh."
      : undefined;
  return baseSnapshot({
    ...input,
    installed: readiness.installed,
    version: readiness.version,
    // Failed discovery is a warning: an installed agent may still run real turns.
    status: probeFailed ? "warning" : readiness.status,
    auth: input.probe
      ? {
          // Discovery sessions and an empty auth-method list do not prove sign-in.
          status: "unknown",
          canLogout: input.probe.probe.sessionManagement.canLogout,
        }
      : input.probeError?.reason === "authentication_failed"
        ? {
            status: "unauthenticated",
            ...(advertisedAuthMethod
              ? { type: advertisedAuthMethod.type, label: advertisedAuthMethod.name }
              : {}),
          }
        : { status: "unknown" },
    ...(input.probeError
      ? { message: authenticationMessage ?? input.probeError.message }
      : readiness.message
        ? { message: readiness.message }
        : {}),
  });
}

export const checkAcpRegistryProviderStatus = Effect.fn("AcpRegistryDriver.checkProviderStatus")(
  function* <Requirements>(
    input: SnapshotIdentity & {
      readonly settings: AcpRegistrySettings;
      readonly cwd: string;
      readonly environment: NodeJS.ProcessEnv;
    },
    probeConfiguration: AcpRegistryConfigurationProbe<Requirements>,
  ): Effect.fn.Return<ServerProvider, never, AcpRegistrySupport.AcpRegistryCatalog | Requirements> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (!input.settings.enabled) {
      return yield* buildInitialAcpRegistrySnapshot(input);
    }
    const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
    const inspected = yield* Effect.result(catalog.inspect(input.settings, input.environment));
    if (Result.isFailure(inspected)) {
      return buildCheckedAcpRegistrySnapshot({
        ...input,
        checkedAt,
        inspection: {
          status: "failed",
          message: `Could not inspect Kilo Code: ${inspected.failure.message}`,
        },
      });
    }
    if (inspected.success.status !== "ready") {
      return buildCheckedAcpRegistrySnapshot({
        ...input,
        checkedAt,
        inspection: inspected.success,
      });
    }
    const probed = yield* Effect.result(
      probeConfiguration({
        instanceId: input.instanceId,
        settings: input.settings,
        cwd: input.cwd,
        environment: input.environment,
      }),
    );
    return Result.isFailure(probed)
      ? buildCheckedAcpRegistrySnapshot({
          ...input,
          checkedAt,
          inspection: inspected.success,
          probeError: probed.failure,
        })
      : buildCheckedAcpRegistrySnapshot({
          ...input,
          checkedAt,
          inspection: inspected.success,
          probe: probed.success,
        });
  },
);

export const checkAcpRegistryProviderReadiness = Effect.fn(
  "AcpRegistryDriver.checkProviderReadiness",
)(function* (
  input: SnapshotIdentity & {
    readonly settings: AcpRegistrySettings;
    readonly environment: NodeJS.ProcessEnv;
  },
): Effect.fn.Return<ServerProvider, never, AcpRegistrySupport.AcpRegistryCatalog> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!input.settings.enabled) {
    return yield* buildInitialAcpRegistrySnapshot(input);
  }
  const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
  const inspected = yield* Effect.result(catalog.inspect(input.settings, input.environment));
  const snapshot = buildCheckedAcpRegistrySnapshot({
    ...input,
    checkedAt,
    inspection: Result.isFailure(inspected)
      ? {
          status: "failed",
          message: `Could not inspect Kilo Code: ${inspected.failure.message}`,
        }
      : inspected.success,
  });
  return inspected._tag === "Success" && inspected.success.status === "ready"
    ? {
        ...snapshot,
        message: "Checking Kilo Code authentication, models, and commands in the background...",
      }
    : snapshot;
});

export type AcpRegistryDriverEnv = AcpRegistryAdapterV2DriverEnv | ProviderHost.ProviderHost;

export const AcpRegistryDriver: ProviderDriver<AcpRegistrySettings, AcpRegistryDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Kilo Code",
    supportsMultipleInstances: true,
  },
  configSchema: AcpRegistrySettings,
  defaultConfig: () => decodeSettings({}),
  create: Effect.fn("AcpRegistryDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
    const runtimeCoordinator = yield* Effect.serviceOption(
      AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
    );
    if (Option.isSome(runtimeCoordinator)) {
      yield* runtimeCoordinator.value.clearAvailableCommands(instanceId);
      yield* runtimeCoordinator.value.clearLiveConfiguration(instanceId);
      yield* Effect.addFinalizer(() =>
        runtimeCoordinator.value
          .clearAvailableCommands(instanceId)
          .pipe(Effect.andThen(runtimeCoordinator.value.clearLiveConfiguration(instanceId))),
      );
    }
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const hostEnvironment = yield* HostProcess.Environment;
    const host = yield* ProviderHost.ProviderHost;
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    const identity = {
      instanceId,
      displayName,
      accentColor,
      continuationKey: continuationIdentity.continuationKey,
    };
    const effectiveConfig = { ...config, enabled } satisfies AcpRegistrySettings;
    const processEnvironment = yield* mergeProviderInstanceEnvironment(
      environment,
      hostEnvironment,
    );
    const orchestrationAdapter = yield* AcpRegistryAdapterV2Driver.create({
      instanceId,
      displayName,
      accentColor,
      environment,
      enabled,
      config,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build the Kilo Code orchestration adapter.",
            cause,
          }),
      ),
    );
    const readinessInput = {
      ...identity,
      settings: effectiveConfig,
      environment: processEnvironment,
    };
    const withLiveRuntimeState = Effect.fn("AcpRegistryDriver.withLiveRuntimeState")(function* (
      provider: ServerProvider,
    ) {
      return yield* Option.isNone(runtimeCoordinator)
        ? Effect.succeed(provider)
        : Effect.all({
            commands: runtimeCoordinator.value.getAvailableCommands(instanceId),
            configuration: runtimeCoordinator.value.getLiveConfiguration(instanceId),
          }).pipe(
            Effect.map(({ commands, configuration }) => {
              const withCommands = applyAcpRegistryAvailableCommands(provider, commands);
              return Option.match(configuration, {
                onNone: () => withCommands,
                onSome: (liveConfiguration) =>
                  applyAcpRegistryLiveConfiguration(
                    withCommands,
                    liveConfiguration,
                    effectiveConfig.customModels,
                  ),
              });
            }),
          );
    });
    const checkProvider = checkAcpRegistryProviderReadiness(readinessInput).pipe(
      Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
      Effect.flatMap(withLiveRuntimeState),
    );
    const enrichProvider = checkAcpRegistryProviderStatus(
      {
        ...readinessInput,
        cwd: host.paths.cwd,
      },
      probeAcpRegistryConfiguration,
    ).pipe(
      Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(Crypto.Crypto, crypto),
    );
    const enrichmentCache = yield* Ref.make<{
      readonly generation: number;
      readonly entry: {
        readonly provider: ServerProvider;
        readonly expiresAt: number;
      } | null;
    }>({ generation: 0, entry: null });
    const liveSnapshotSemaphore = yield* Semaphore.make(1);
    const enrichProviderCached = Effect.fn("AcpRegistryDriver.enrichProviderCached")(function* (
      baseSnapshot: ServerProvider,
    ) {
      const now = yield* Clock.currentTimeMillis;
      const cacheState = yield* Ref.get(enrichmentCache);
      const cached = cacheState.entry;
      if (
        cached !== null &&
        cached.expiresAt > now &&
        cached.provider.version === baseSnapshot.version
      ) {
        return {
          provider: { ...cached.provider, checkedAt: baseSnapshot.checkedAt },
          generation: cacheState.generation,
        };
      }
      const enriched = yield* enrichProvider;
      if (enriched.status === "ready") {
        yield* Ref.update(enrichmentCache, (current) =>
          current.generation === cacheState.generation
            ? {
                ...current,
                entry: {
                  provider: enriched,
                  expiresAt: now + PROBE_SUCCESS_TTL_MS,
                },
              }
            : current,
        );
      }
      return { provider: enriched, generation: cacheState.generation };
    });
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<
      ProviderSnapshotSettings<AcpRegistrySettings>
    >({
      resolveMaintenance: () => Effect.succeed(MAINTENANCE),
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: () => checkProvider,
      checkProvider,
      enrichSnapshot: Effect.fn("enrichSnapshot")(function ({
        snapshot,
        getSnapshot,
        publishSnapshot,
      }) {
        if (!snapshot.installed) return Effect.void;
        const publishEnrichment = (
          Option.isSome(runtimeCoordinator)
            ? runtimeCoordinator.value.runBackgroundProbe(
                `local:${instanceId}`,
                enrichProviderCached(snapshot),
              )
            : enrichProviderCached(snapshot).pipe(Effect.asSome)
        ).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: ({ provider, generation }) =>
                liveSnapshotSemaphore.withPermit(
                  Ref.get(enrichmentCache).pipe(
                    Effect.flatMap((current) =>
                      current.generation === generation
                        ? withLiveRuntimeState(provider).pipe(Effect.flatMap(publishSnapshot))
                        : Effect.void,
                    ),
                  ),
                ),
            }),
          ),
        );
        if (Option.isNone(runtimeCoordinator)) return publishEnrichment;

        const publishLiveCommands = runtimeCoordinator.value.watchAvailableCommands(
          instanceId,
          ({ slashCommands, skills }) =>
            liveSnapshotSemaphore.withPermit(
              getSnapshot.pipe(
                Effect.flatMap((current) =>
                  publishSnapshot({
                    ...current,
                    slashCommands,
                    skills,
                  }),
                ),
              ),
            ),
        );
        const publishLiveConfiguration = runtimeCoordinator.value.watchLiveConfiguration(
          instanceId,
          (configuration) =>
            liveSnapshotSemaphore.withPermit(
              getSnapshot.pipe(
                Effect.flatMap((current) =>
                  publishSnapshot(
                    applyAcpRegistryLiveConfiguration(
                      current,
                      configuration,
                      effectiveConfig.customModels,
                    ),
                  ),
                ),
              ),
            ),
        );
        return Effect.all([publishEnrichment, publishLiveCommands, publishLiveConfiguration], {
          concurrency: "unbounded",
          discard: true,
        });
      }),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build the Kilo Code provider snapshot.",
            cause,
          }),
      ),
    );

    // Coder: the session manager needs no runtime coordinator, since it offers no URL elicitation.
    const provideAcpManagementServices = <A, E>(
      effect: Effect.Effect<
        A,
        E,
        | AcpRegistrySupport.AcpRegistryCatalog
        | ChildProcessSpawner.ChildProcessSpawner
        | Crypto.Crypto
      >,
    ): Effect.Effect<A, E> =>
      effect.pipe(
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Crypto.Crypto, crypto),
      );

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      orchestrationAdapter,
      textGeneration: makeUnsupportedTextGeneration(),
      acpSessionManagement: {
        listSessions: ({ cwd, cursor }) =>
          provideAcpManagementServices(
            listAcpRegistrySessions({
              instanceId,
              settings: effectiveConfig,
              cwd,
              environment: processEnvironment,
              ...(cursor === undefined ? {} : { cursor }),
            }),
          ),
      },
    } satisfies ProviderInstance;
  }),
};
