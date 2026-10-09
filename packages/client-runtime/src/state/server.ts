// Coder: no server self-update flow; the Coder helper is versioned by the gateway.
import {
  type EnvironmentId,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerLifecycleWelcomePayload,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import * as Persistence from "../platform/persistence.ts";
import { subscribe, type EnvironmentRpcInput } from "../rpc/client.ts";
import { runCachePersistence } from "./cachePersistence.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  followStreamInEnvironment,
} from "./runtime.ts";
import {
  applyServerConfigProjection,
  withoutEnvironmentThemes,
  type ServerConfigProjection,
} from "./serverConfigProjection.ts";

export { type ServerConfigProjection };

function projectServerConfig(
  current: Option.Option<ServerConfigProjection>,
  event: ServerConfigStreamEvent,
): readonly [Option.Option<ServerConfigProjection>, ReadonlyArray<ServerConfigProjection>] {
  const next = applyServerConfigProjection(current, event);
  return [next, Option.toArray(next)];
}

const cachedConfigSnapshotEvent = (config: ServerConfig): ServerConfigStreamEvent => ({
  version: 1,
  type: "snapshot",
  config,
});

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
      // Stripped on load as well as on save: a cache written by an earlier
      // build can still carry published themes.
      Option.map(cachedConfig, (cached) => ({
        config: withoutEnvironmentThemes(cached),
        latestEvent: cachedConfigSnapshotEvent(withoutEnvironmentThemes(cached)),
        source: "cache" as const,
      })),
    );
    const persistence = yield* Queue.sliding<ServerConfig>(1);
    const pendingPersistence = yield* Ref.make<Option.Option<ServerConfig>>(Option.none());
    const persist = (config: ServerConfig) =>
      cache.saveServerConfig(environmentId, withoutEnvironmentThemes(config)).pipe(
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
  const emptyConfigAtom = Atom.make<ServerConfig | null>(null).pipe(
    Atom.withLabel("environment-data:server:config:empty"),
  );
  const configValueAtom = Atom.family((environmentId: EnvironmentId | null) => {
    if (environmentId === null) return emptyConfigAtom;
    return Atom.make((get): ServerConfig | null => {
      const projection = Option.getOrNull(
        AsyncResult.value(get(configProjection({ environmentId, input: {} }))),
      );
      return resolveServerConfigValue(
        projection,
        get(options.initialConfigValueAtom(environmentId)),
      );
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
    /** Live scheduled-task list: snapshot on subscribe, fresh list after every server-side change. */
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
    // Provider-instance mutations share the settings command and its
    // environment-serial scheduler. The named boundary keeps clients on the
    // atomic map-entry payload instead of rebuilding a stale whole map.
    mutateProviderInstance: updateSettings,
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
    runScheduledTaskNow: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:scheduled-task:run-now",
      tag: WS_METHODS.scheduledTasksRunNow,
    }),
  };
}
