// Coder: no server self-update flow; the Coder helper is versioned by the gateway.
import {
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerLifecycleWelcomePayload,
  type ServerProviderWorkspaceSnapshot,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import * as Persistence from "../platform/persistence.ts";
import { requestGuarded, subscribe, type EnvironmentRpcInput } from "../rpc/client.ts";
import { runCachePersistence } from "./cachePersistence.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  followStreamInEnvironment,
} from "./runtime.ts";
import {
  applyServerConfigProjection,
  reuseUnchanged,
  withoutEnvironmentThemes,
  type ServerConfigProjection,
} from "./serverConfigProjection.ts";

export { type ServerConfigProjection };

const cachedConfigSnapshotEvent = (config: ServerConfig): ServerConfigStreamEvent => ({
  version: 1,
  type: "snapshot",
  config,
});

// Configs are JSON-shaped. Missing and undefined object fields persist identically.
function sameCacheValue(previous: unknown, next: unknown): boolean {
  if (previous === next) return true;
  if (
    previous === null ||
    next === null ||
    typeof previous !== "object" ||
    typeof next !== "object"
  ) {
    return false;
  }
  if (Array.isArray(previous) || Array.isArray(next)) {
    if (!Array.isArray(previous) || !Array.isArray(next) || previous.length !== next.length) {
      return false;
    }
    for (let index = 0; index < previous.length; index += 1) {
      if (!sameCacheValue(previous[index], next[index])) return false;
    }
    return true;
  }
  if (
    Object.getPrototypeOf(previous) !== Object.prototype ||
    Object.getPrototypeOf(next) !== Object.prototype
  ) {
    return false;
  }
  const before = previous as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  return (
    Object.keys(before).every((key) =>
      sameCacheValue(before[key], Object.hasOwn(after, key) ? after[key] : undefined),
    ) && Object.keys(after).every((key) => Object.hasOwn(before, key) || after[key] === undefined)
  );
}

const makeEnvironmentServerConfigState = Effect.fn("EnvironmentServerConfigState.make")(
  function* () {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const cache = yield* Persistence.EnvironmentCacheStore;
    const environmentId = supervisor.target.environmentId;
    const cachedConfig = yield* cache
      .loadServerConfig(environmentId)
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not load cached server configuration.").pipe(
            Effect.annotateLogs({ environmentId, ...safeErrorLogAttributes(error) }),
            Effect.as(Option.none<ServerConfig>()),
          ),
        ),
      );
    const state = yield* SubscriptionRef.make<Option.Option<ServerConfigProjection>>(
      Option.map(cachedConfig, (cached) => ({
        config: withoutEnvironmentThemes(cached),
        latestEvent: cachedConfigSnapshotEvent(withoutEnvironmentThemes(cached)),
        source: "cache" as const,
      })),
    );
    const persistence = yield* Queue.sliding<ServerConfig>(1);
    const pendingPersistence = yield* Ref.make<Option.Option<ServerConfig>>(Option.none());
    let lastPersisted: ServerConfig | undefined;

    const persist = Effect.fn("EnvironmentServerConfigState.persist")(function* (
      config: ServerConfig,
    ) {
      // A cached stall would read as a fresh freeze on the next launch.
      const {
        environmentThemes: _themes,
        usageLimitSources: _sources,
        lastEventLoopStall: _stall,
        ...cacheable
      } = config;
      if (lastPersisted !== undefined && sameCacheValue(lastPersisted, cacheable)) {
        return true;
      }
      const saved = yield* cache.saveServerConfig(environmentId, cacheable).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("Could not persist cached server configuration.").pipe(
            Effect.annotateLogs({
              environmentId,
              ...safeErrorLogAttributes(error),
            }),
            Effect.as(false),
          ),
        ),
      );
      if (saved) lastPersisted = cacheable;
      return saved;
    });

    const persistPending = Effect.fn("EnvironmentServerConfigState.persistPending")(function* (
      config: ServerConfig,
    ) {
      if (!(yield* persist(config))) {
        return;
      }
      yield* Ref.update(pendingPersistence, (pending) =>
        Option.isSome(pending) && pending.value === config ? Option.none() : pending,
      );
    });

    yield* Effect.addFinalizer(() =>
      Ref.get(pendingPersistence).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (config) => persist(config).pipe(Effect.asVoid),
          }),
        ),
      ),
    );

    yield* runCachePersistence(persistence, persistPending).pipe(Effect.forkScoped);

    yield* subscribe(WS_METHODS.subscribeServerConfig, { environmentThemes: true }).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          const next = applyServerConfigProjection(yield* SubscriptionRef.get(state), event);
          if (Option.isNone(next)) return;
          yield* Ref.set(pendingPersistence, Option.some(next.value.config));
          yield* SubscriptionRef.set(state, next);
          yield* Queue.offer(persistence, next.value.config);
        }),
      ),
      Effect.forkScoped,
    );

    return state;
  },
);

function serverConfigStateChanges(environmentId: EnvironmentId) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(
      makeEnvironmentServerConfigState().pipe(
        Effect.map((state) =>
          SubscriptionRef.changes(state).pipe(
            Stream.filterMap((projection) =>
              Option.match(projection, {
                onNone: () => Result.failVoid,
                onSome: Result.succeed,
              }),
            ),
          ),
        ),
      ),
    ),
  );
}

function projectServerWelcome(
  current: Option.Option<ServerLifecycleWelcomePayload>,
  event: {
    readonly type: "welcome" | "ready" | "legacyThreadMigration";
    readonly payload: unknown;
  },
): readonly [
  Option.Option<ServerLifecycleWelcomePayload>,
  ReadonlyArray<ServerLifecycleWelcomePayload>,
] {
  if (event.type !== "welcome") return [current, []];
  const welcome = event.payload as ServerLifecycleWelcomePayload;
  return [Option.some(welcome), [welcome]];
}

function resolveServerConfigValue(
  projection: ServerConfigProjection | null,
  initialConfig: ServerConfig | null,
): ServerConfig | null {
  if (
    projection?.source === "live" &&
    (initialConfig === null ||
      projection.config.environment.serverVersion === initialConfig.environment.serverVersion)
  ) {
    return projection.config;
  }
  return initialConfig ?? projection?.config ?? null;
}

type ServerProviderEntry = ServerConfig["providers"][number];

/**
 * The provider-wide fields a workspace snapshot builds on. A live session, a sign-out, or a
 * /usage-limits change shows up here, so a snapshot fetched before it no longer applies.
 */
const snapshotBasis = (provider: ServerProviderEntry | undefined) =>
  provider && {
    enabled: provider.enabled,
    slashCommands: provider.slashCommands,
    skills: provider.skills,
  };

interface FetchedWorkspaceSnapshot {
  readonly instanceId: ProviderInstanceId;
  readonly snapshot: ServerProviderWorkspaceSnapshot;
  readonly basis: ReturnType<typeof snapshotBasis>;
}

const MAX_FETCHED_WORKSPACE_SNAPSHOTS = 32;

/**
 * Servers with `providerWorkspaceSnapshotsOnDemand` leave per-cwd snapshots out of the config,
 * so the ones this client fetched are merged back in. Older servers send every snapshot and
 * their drops, so their config is used as is.
 */
export function withFetchedWorkspaceSnapshots(
  config: ServerConfig,
  fetched: ReadonlyArray<FetchedWorkspaceSnapshot>,
): ServerConfig {
  if (
    fetched.length === 0 ||
    config.environment.capabilities.providerWorkspaceSnapshotsOnDemand !== true
  ) {
    return config;
  }
  return {
    ...config,
    providers: config.providers.map((provider) => {
      // A dropped snapshot reads as lost, and the composer fetches it again.
      const own = fetched.filter(
        (entry) =>
          entry.instanceId === provider.instanceId &&
          Equal.equals(entry.basis, snapshotBasis(provider)),
      );
      return own.length === 0
        ? provider
        : { ...provider, workspaceSnapshots: own.map((entry) => entry.snapshot) };
    }),
  };
}

export function recordFetchedWorkspaceSnapshot(
  current: ReadonlyArray<FetchedWorkspaceSnapshot>,
  input: { readonly instanceId: ProviderInstanceId; readonly cwd: string; readonly fresh: boolean },
  providers: ServerConfig["providers"],
  configProvider: ServerProviderEntry | undefined,
): ReadonlyArray<FetchedWorkspaceSnapshot> {
  const basis = snapshotBasis(configProvider);
  const snapshot = providers
    .find((provider) => provider.instanceId === input.instanceId)
    ?.workspaceSnapshots?.find((candidate) => candidate.cwd === input.cwd);
  const stored = current.find(
    (entry) => entry.instanceId === input.instanceId && entry.snapshot.cwd === input.cwd,
  );
  // A cached answer from the server would otherwise re-render every config reader.
  if (
    !input.fresh &&
    snapshot &&
    stored &&
    Equal.equals(stored.snapshot, snapshot) &&
    Equal.equals(stored.basis, basis)
  ) {
    return current;
  }
  // A fresh scan drops the cwd's snapshots for every provider, as the server does.
  const kept = current.filter(
    (entry) =>
      entry.snapshot.cwd !== input.cwd || (!input.fresh && entry.instanceId !== input.instanceId),
  );
  if (!snapshot) return kept.length === current.length ? current : kept;
  return [...kept, { instanceId: input.instanceId, snapshot, basis }].slice(
    -MAX_FETCHED_WORKSPACE_SNAPSHOTS,
  );
}

export function createServerEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry.EnvironmentRegistry | Persistence.EnvironmentCacheStore | R,
    E
  >,
  options: {
    readonly initialConfigValueAtom: (
      environmentId: EnvironmentId,
    ) => Atom.Atom<ServerConfig | null>;
  },
) {
  const configScheduler = createAtomCommandScheduler();
  const configConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  const configProjectionFamily = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom(serverConfigStateChanges(environmentId))
      .pipe(
        Atom.setIdleTTL(5 * 60_000),
        Atom.withLabel(`environment-data:server:config-projection:${environmentId}`),
      ),
  );
  const configProjection = (target: {
    readonly environmentId: EnvironmentId;
    readonly input: EnvironmentRpcInput<typeof WS_METHODS.subscribeServerConfig>;
  }) => configProjectionFamily(target.environmentId);
  const fetchedWorkspaceSnapshotsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make<ReadonlyArray<FetchedWorkspaceSnapshot>>([]).pipe(
      Atom.keepAlive,
      Atom.withLabel(`environment-data:server:fetched-workspace-snapshots:${environmentId}`),
    ),
  );
  const emptyConfigAtom = Atom.make<ServerConfig | null>(null).pipe(
    Atom.withLabel("environment-data:server:config:empty"),
  );
  const configValueAtom = Atom.family((environmentId: EnvironmentId | null) => {
    if (environmentId === null) {
      return emptyConfigAtom;
    }
    let previousProviders: ServerConfig["providers"] | undefined;
    return Atom.make((get): ServerConfig | null => {
      const projection = AsyncResult.getOrElse(
        get(configProjection({ environmentId, input: {} })),
        () => null,
      );
      const config = resolveServerConfigValue(
        projection,
        get(options.initialConfigValueAtom(environmentId)),
      );
      if (config === null) return null;
      const merged = withFetchedWorkspaceSnapshots(
        config,
        get(fetchedWorkspaceSnapshotsAtom(environmentId)),
      );
      if (merged === config) return config;
      // Keep provider identities stable across config events; the projection already reuses the rest.
      previousProviders = reuseUnchanged(previousProviders, merged.providers);
      return { ...merged, providers: previousProviders };
    }).pipe(Atom.withLabel(`environment-data:server:config:${environmentId}`));
  });
  const settingsValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(configValueAtom(environmentId))?.settings ?? null).pipe(
      Atom.withLabel(`environment-data:server:settings:${environmentId}`),
    ),
  );
  const providersValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(configValueAtom(environmentId))?.providers ?? null).pipe(
      Atom.withLabel(`environment-data:server:providers:${environmentId}`),
    ),
  );

  const updateSettings = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:server:update-settings",
    tag: WS_METHODS.serverUpdateSettings,
    scheduler: configScheduler,
    concurrency: configConcurrency,
  });

  return {
    configValueAtom,
    runStorageCleanup: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:run-storage-cleanup",
      tag: WS_METHODS.serverRunStorageCleanup,
      concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
    }),
    storageCleanupReport: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:storage-cleanup-report",
      tag: WS_METHODS.serverGetStorageCleanupReport,
      idleTtlMs: 0,
    }),
    settingsValueAtom,
    providersValueAtom,
    updateProvider: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:update-provider",
      tag: WS_METHODS.serverUpdateProvider,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.instanceId ?? input.provider]),
      },
    }),
    refreshProviders: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:refresh-providers",
      tag: WS_METHODS.serverRefreshProviders,
      execute: (input) =>
        requestGuarded(WS_METHODS.serverRefreshProviders, {
          ...input,
          workspaceSnapshotsOnDemand: true,
        }),
      onSuccess: ({ environmentId, input }, registry, result) =>
        Effect.sync(() => {
          const { instanceId, cwd } = input;
          if (instanceId === undefined || cwd === undefined) return;
          registry.update(fetchedWorkspaceSnapshotsAtom(environmentId), (current) =>
            recordFetchedWorkspaceSnapshot(
              current,
              { instanceId, cwd, fresh: input.fresh === true },
              result.providers,
              registry
                .get(configValueAtom(environmentId))
                ?.providers.find((provider) => provider.instanceId === instanceId),
            ),
          );
        }),
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([
            environmentId,
            input.instanceId ?? null,
            input.cwd ?? null,
            input.fresh ?? false,
          ]),
      },
    }),
    scheduledTasksLive: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:scheduled-tasks:live",
      tag: WS_METHODS.scheduledTasksSubscribe,
    }),
    configProjection,
    welcome: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:welcome",
      tag: WS_METHODS.subscribeServerLifecycle,
      transform: (stream) =>
        stream.pipe(
          Stream.mapAccum(Option.none<ServerLifecycleWelcomePayload>, projectServerWelcome),
        ),
    }),
    legacyThreadMigration: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:legacy-thread-migration",
      tag: WS_METHODS.subscribeServerLifecycle,
      transform: (stream) =>
        stream.pipe(
          Stream.filterMap((event) =>
            event.type === "legacyThreadMigration"
              ? Result.succeed(event.payload)
              : Result.failVoid,
          ),
        ),
    }),
    updateSettings,
    mutateProviderInstance: updateSettings,
    // Coder: of upstream's ACP Registry commands, only Kilo Code's native session list and
    // import are carried.
    listAcpRegistrySessions: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:acp-registry:list-sessions",
      tag: WS_METHODS.serverListAcpRegistrySessions,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          `${environmentId}:${input.instanceId}:${input.projectId}:${input.cursor ?? "first"}`,
      },
    }),
    importAcpRegistrySession: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:acp-registry:import-session",
      tag: WS_METHODS.serverImportAcpRegistrySession,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          `${environmentId}:${input.instanceId}:${input.projectId}:${input.sessionId}`,
      },
    }),
    upsertKeybinding: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:upsert-keybinding",
      tag: WS_METHODS.serverUpsertKeybinding,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    removeKeybinding: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:remove-keybinding",
      tag: WS_METHODS.serverRemoveKeybinding,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    upsertScheduledTask: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:scheduled-task:upsert",
      tag: WS_METHODS.scheduledTasksUpsert,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    setScheduledTaskEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:scheduled-task:set-enabled",
      tag: WS_METHODS.scheduledTasksSetEnabled,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    deleteScheduledTask: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:scheduled-task:delete",
      tag: WS_METHODS.scheduledTasksDelete,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    // Deliberately not on the config lane: run-now blocks until the run is
    // dispatched, and a slow run must not stall settings/keybinding/provider
    // mutations (or other scheduled-task edits) queued behind it.
    // Off the config lane: answering a card must not queue behind settings
    // edits. One answer per card at a time.
    answerSecretRequest: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:secrets:answer-request",
      tag: WS_METHODS.secretsAnswerRequest,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.turnItemId]),
      },
    }),
    runScheduledTaskNow: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:scheduled-task:run-now",
      tag: WS_METHODS.scheduledTasksRunNow,
    }),
  };
}
