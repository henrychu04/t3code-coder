import { HttpClient, FetchHttpClient } from "effect/unstable/http";
import {
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
  enrichProviderSnapshotWithVersionAdvisory,
} from "../providerMaintenance.ts";
import { normalizeCommandPath } from "../providerMaintenance.ts";
import { discoverClaudeSkills } from "./ClaudeSkills.ts";
/**
 * ClaudeDriver — `ProviderDriver` for the workspace Claude Code CLI runtime.
 *
 * A plain value whose `create()` returns one `ProviderInstance` bundling
 * `snapshot` / `orchestrationAdapter` / `textGeneration`
 * closures captured over the per-instance `ClaudeSettings`.
 *
 * The Claude snapshot probe may invoke a secondary probe
 * (`probeClaudeCapabilities`) to read Anthropic account + slash-command
 * metadata. That probe is per-instance and keyed by binary + resolved HOME so
 * two concurrent Claude instances don't cross-contaminate account metadata.
 *
 * @module provider/Drivers/ClaudeDriver
 */
import { ClaudeSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeClaudeTextGeneration } from "../../textGeneration/ClaudeTextGeneration.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  createClaudeAdapterV2,
  type ClaudeAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import {
  checkClaudeProviderStatus,
  makePendingClaudeProvider,
  probeClaudeCapabilities,
} from "../Layers/ClaudeProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { resolveClaudeModelCatalog } from "../ClaudeModelCatalog.ts";
import * as ModelManifest from "../ModelManifest.ts";
import { applyBundledModelManifest } from "../ModelManifest.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeClaudeCapabilitiesCacheKey, makeClaudeContinuationGroupKey } from "./ClaudeHome.ts";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
const CAPABILITIES_PROBE_TTL = Duration.minutes(5);

function isClaudeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.local/bin/claude") ||
    normalized.endsWith("/.local/bin/claude.exe") ||
    normalized.includes("/.local/share/claude/")
  );
}

const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "@anthropic-ai/claude-code",
  nativeUpdate: {
    args: ["update"],
    isCommandPath: isClaudeNativeCommandPath,
  },
});

export type ClaudeDriverEnv =
  | ClaudeAdapterV2DriverEnv
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | ModelManifest.ModelManifest
  | Path.Path
  | ServerConfig
  | ServerSettingsService;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const ClaudeDriver: ProviderDriver<ClaudeSettings, ClaudeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Claude",
    supportsMultipleInstances: true,
  },
  configSchema: ClaudeSettings,
  defaultConfig: (): ClaudeSettings => decodeClaudeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const serverSettings = yield* ServerSettingsService;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { cwd } = yield* ServerConfig;
      const modelManifest = yield* ModelManifest.ModelManifest;
      const modelCatalog = modelManifest.current.pipe(Effect.map(resolveClaudeModelCatalog));
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const fallbackContinuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const effectiveConfig = { ...config, enabled } satisfies ClaudeSettings;
      const continuationGroupKey = yield* makeClaudeContinuationGroupKey(
        effectiveConfig,
        processEnv,
      );
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey,
      });
      const classifyAndStamp = (draft: ServerProviderDraft): ServerProvider =>
        stampIdentity(applyBundledModelManifest(draft, DRIVER_KIND));

      // Coder: there are no subscription usage-limit snapshots to update.
      const orchestrationAdapter = yield* createClaudeAdapterV2(
        {
          instanceId,
          displayName,
          accentColor,
          environment,
          enabled,
          config,
        },
        {},
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build Claude orchestration adapter.",
              cause,
            }),
        ),
      );
      const textGeneration = yield* makeClaudeTextGeneration(
        effectiveConfig,
        processEnv,
        modelCatalog,
      );

      // Per-instance capabilities cache: keyed on binary + resolved HOME so
      // account-specific probes never share auth metadata across instances.
      const capabilitiesProbeCache = yield* Cache.make({
        capacity: 1,
        timeToLive: CAPABILITIES_PROBE_TTL,
        lookup: () =>
          probeClaudeCapabilities(effectiveConfig, processEnv, cwd).pipe(
            Effect.provideService(Path.Path, path),
          ),
      });
      const capabilitiesCacheKey = yield* makeClaudeCapabilitiesCacheKey(
        effectiveConfig,
        cwd,
        processEnv,
      );
      const slashCommandsByCwd = yield* Cache.make({
        capacity: 32,
        timeToLive: CAPABILITIES_PROBE_TTL,
        lookup: (commandCwd: string) =>
          probeClaudeCapabilities(effectiveConfig, processEnv, commandCwd).pipe(
            Effect.provideService(Path.Path, path),
            Effect.map((capabilities) => capabilities?.slashCommands ?? []),
          ),
      });

      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
          binaryPath: effectiveConfig.binaryPath || "claude",
          env: processEnv,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, yield* FileSystem.FileSystem),
          Effect.provideService(Path.Path, yield* Path.Path),
        ),
      );
      const checkProvider = modelManifest.current.pipe(
        Effect.flatMap((manifest) =>
          checkClaudeProviderStatus(
            effectiveConfig,
            () => Cache.get(capabilitiesProbeCache, capabilitiesCacheKey),
            processEnv,
            cwd,
            resolveClaudeModelCatalog(manifest),
          ),
        ),
        Effect.map(classifyAndStamp),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<ClaudeSettings>>({
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingClaudeProvider(settings.provider).pipe(Effect.map(classifyAndStamp)),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((capabilities) =>
              enrichProviderSnapshotWithVersionAdvisory(snapshot, capabilities, {
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              }),
            ),
            Effect.provide(FetchHttpClient.layer),
            Effect.flatMap(publishSnapshot),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Claude snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity: {
          ...fallbackContinuationIdentity,
          continuationKey: continuationGroupKey,
        },
        displayName,
        accentColor,
        enabled,
        invalidateCaches: Effect.all(
          [Cache.invalidateAll(capabilitiesProbeCache), Cache.invalidateAll(slashCommandsByCwd)],
          { discard: true },
        ),
        snapshot: { ...snapshot, resolveMaintenance },
        snapshotForCwd: (commandCwd) =>
          Effect.all([
            snapshot.getSnapshot,
            discoverClaudeSkills(effectiveConfig, commandCwd, processEnv).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
            ),
            Cache.get(slashCommandsByCwd, commandCwd),
          ]).pipe(
            Effect.map(([current, skills, slashCommands]) => ({
              ...current,
              skills,
              slashCommands,
            })),
          ),
        listSlashCommands: (commandCwd) => Cache.get(slashCommandsByCwd, commandCwd),
        orchestrationAdapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
