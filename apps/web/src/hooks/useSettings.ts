/**
 * Environment-scoped settings hooks.
 *
 * Abstracts the split between server-authoritative settings (persisted in
 * `settings.json` on the server, fetched via `server.getConfig`) and
 * client-only settings (persisted in localStorage).
 *
 * Live server settings always require an environment id. Primary-environment
 * access is intentionally named as such so environment-sensitive consumers
 * cannot silently read the wrong server's settings.
 */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  AuthSettingsWriteScope,
  requiredScopesForServerSettingsPatch,
  type EnvironmentId,
  type ProviderInstanceMutation,
  ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import {
  type ClientSettingsPatch,
  type ClientSettings,
  DEFAULT_CLIENT_SETTINGS,
  type EnvironmentIdentificationMode,
  type UnifiedSettings,
} from "@t3tools/contracts/settings";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  filterSharedServerPatch,
  splitSharedServerPatch,
  supportsSharedSettingsSync,
} from "@t3tools/client-runtime/state/shared-settings";
import { ensureLocalApi } from "~/localApi";
import {
  getThemeDefinition,
  getThemePreviewSidebarArtwork,
  resolveThemeHalf,
  subscribeToThemePreview,
  themeAllowsSidebarArtwork,
} from "~/themePalette";
import * as Struct from "effect/Struct";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { toastManager } from "~/components/ui/toast";
import { primaryServerSettingsAtom, serverEnvironment } from "~/state/server";
import { useEnvironments, usePrimaryEnvironment } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { useTheme } from "./useTheme";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { appAtomRegistry } from "~/rpc/atomRegistry";

const CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE = "[CLIENT_SETTINGS]";

type UnifiedSettingsPatch = ServerSettingsPatch & ClientSettingsPatch;

const clientSettingsListeners = new Set<() => void>();
const clientSettingsHydrationListeners = new Set<() => void>();
type ClientSettingsHydrationStatus = "pending" | "ready" | "failed" | "retrying";
let clientSettingsSnapshot = DEFAULT_CLIENT_SETTINGS;
let clientSettingsHydrationStatus: ClientSettingsHydrationStatus = "pending";
let clientSettingsHydrationPromise: Promise<void> | null = null;
let clientSettingsHydrationGeneration = 0;
let clientSettingsPersistenceQueue: Promise<void> = Promise.resolve();
let deferredClientSettingsPatchCount = 0;

function emitClientSettingsChange() {
  for (const listener of clientSettingsListeners) {
    listener();
  }
}

function emitClientSettingsHydrationChange() {
  for (const listener of clientSettingsHydrationListeners) {
    listener();
  }
}

function getClientSettingsSnapshot(): ClientSettings {
  return clientSettingsSnapshot;
}

function replaceClientSettingsSnapshot(settings: ClientSettings): void {
  clientSettingsSnapshot = settings;
  emitClientSettingsChange();
}

function setClientSettingsHydrationStatus(nextStatus: ClientSettingsHydrationStatus): void {
  if (clientSettingsHydrationStatus === nextStatus) {
    return;
  }
  clientSettingsHydrationStatus = nextStatus;
  emitClientSettingsHydrationChange();
}

function subscribeClientSettings(listener: () => void): () => void {
  clientSettingsListeners.add(listener);
  void hydrateClientSettings().catch(() => undefined);
  return () => {
    clientSettingsListeners.delete(listener);
  };
}

function getClientSettingsHydratedSnapshot(): boolean {
  return clientSettingsHydrationStatus === "ready";
}

function getClientSettingsHydrationStatusSnapshot(): ClientSettingsHydrationStatus {
  return clientSettingsHydrationStatus;
}

function subscribeClientSettingsHydration(listener: () => void): () => void {
  clientSettingsHydrationListeners.add(listener);
  void hydrateClientSettings().catch(() => undefined);
  return () => {
    clientSettingsHydrationListeners.delete(listener);
  };
}

async function hydrateClientSettings(): Promise<void> {
  if (clientSettingsHydrationStatus === "ready") {
    return;
  }
  if (clientSettingsHydrationPromise) {
    return clientSettingsHydrationPromise;
  }

  const hydrationGeneration = clientSettingsHydrationGeneration;
  setClientSettingsHydrationStatus(
    clientSettingsHydrationStatus === "failed" || clientSettingsHydrationStatus === "retrying"
      ? "retrying"
      : "pending",
  );
  const nextHydration = (async () => {
    try {
      const persistedSettings = await ensureLocalApi().persistence.getClientSettings();
      if (hydrationGeneration !== clientSettingsHydrationGeneration) {
        return;
      }
      if (persistedSettings) {
        replaceClientSettingsSnapshot({ ...DEFAULT_CLIENT_SETTINGS, ...persistedSettings });
      }
      setClientSettingsHydrationStatus("ready");
    } catch (error) {
      if (hydrationGeneration === clientSettingsHydrationGeneration) {
        setClientSettingsHydrationStatus("failed");
      }
      console.error(`${CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE} hydrate failed`, {
        operation: "hydrate",
        ...safeErrorLogAttributes(error),
      });
      throw error;
    }
  })();

  const hydrationPromise = nextHydration.finally(() => {
    if (clientSettingsHydrationPromise === hydrationPromise) {
      clientSettingsHydrationPromise = null;
    }
  });
  clientSettingsHydrationPromise = hydrationPromise;

  return clientSettingsHydrationPromise;
}

const defaultClientSettingsPersistence = (settings: ClientSettings): Promise<void> =>
  ensureLocalApi().persistence.setClientSettings(settings);

function enqueueClientSettingsPersistence<A>(work: () => Promise<A>): Promise<A> {
  const result = clientSettingsPersistenceQueue.then(work);
  clientSettingsPersistenceQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function persistClientSettingsPatch(
  patch: ClientSettingsPatch,
  persist: (settings: ClientSettings) => Promise<void> = defaultClientSettingsPersistence,
): Promise<void> {
  // Patches queued before hydration must publish before newer optimistic patches.
  const deferPatch =
    clientSettingsHydrationStatus !== "ready" || deferredClientSettingsPatchCount > 0;
  if (deferPatch) {
    deferredClientSettingsPatchCount += 1;
  } else {
    replaceClientSettingsSnapshot({ ...getClientSettingsSnapshot(), ...patch });
  }
  return enqueueClientSettingsPersistence(async () => {
    if (deferPatch) {
      try {
        if (clientSettingsHydrationStatus !== "ready") {
          await hydrateClientSettings();
        }
        replaceClientSettingsSnapshot({ ...getClientSettingsSnapshot(), ...patch });
      } finally {
        deferredClientSettingsPatchCount -= 1;
      }
    }
    await persist(getClientSettingsSnapshot());
  }).catch((error) => {
    console.error(`${CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE} persist failed`, {
      operation: "persist",
      ...safeErrorLogAttributes(error),
    });
  });
}

/**
 * Persists a client-settings update before publishing it to the in-memory
 * snapshot. If another settings write lands while persistence is pending, the
 * updater is reapplied to that newer snapshot and persisted again so neither
 * change is lost.
 */
export async function persistClientSettingsUpdate(
  update: (current: ClientSettings) => ClientSettings,
  persist: (settings: ClientSettings) => Promise<void> = defaultClientSettingsPersistence,
): Promise<ClientSettings> {
  return enqueueClientSettingsPersistence(async () => {
    if (clientSettingsHydrationStatus !== "ready") {
      await hydrateClientSettings();
    }
    for (;;) {
      const current = getClientSettingsSnapshot();
      const next = update(current);
      await persist(next);
      if (getClientSettingsSnapshot() === current) {
        replaceClientSettingsSnapshot(next);
        return next;
      }
    }
  });
}

// ── Key sets for routing patches ─────────────────────────────────────

const SERVER_SETTINGS_KEYS = new Set<string>(Struct.keys(ServerSettings.fields));

function splitPatch(patch: UnifiedSettingsPatch): {
  serverPatch: ServerSettingsPatch;
  clientPatch: ClientSettingsPatch;
} {
  const serverPatch: Record<string, unknown> = {};
  const clientPatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (SERVER_SETTINGS_KEYS.has(key)) {
      serverPatch[key] = value;
    } else {
      clientPatch[key] = value;
    }
  }
  return {
    serverPatch: serverPatch as ServerSettingsPatch,
    clientPatch: clientPatch as ClientSettingsPatch,
  };
}

// ── Hooks ────────────────────────────────────────────────────────────

/**
 * Non-hook accessor for the current merged client settings snapshot.
 * Used by non-React code paths (e.g. runtime services) that need the latest
 * settings without subscribing.
 */
export function getClientSettings(): ClientSettings {
  return getClientSettingsSnapshot();
}

/**
 * Resolves after settings load or storage confirms no saved settings exist.
 * Failed reads reject and remain retryable. They must not allow defaults to
 * overwrite saved preferences.
 *
 * The pre-hydration snapshot is just the schema defaults, so imperative paths
 * that open a preview must await this or they bake the built-in viewport, zoom
 * and appearance into a tab that never picks up the user's saved values.
 */
export function ensureClientSettingsHydrated(): Promise<void> {
  return hydrateClientSettings();
}

export function useClientSettingsHydrated(): boolean {
  return useSyncExternalStore(
    subscribeClientSettingsHydration,
    getClientSettingsHydratedSnapshot,
    () => false,
  );
}

export function useClientSettingsHydrationStatus(): ClientSettingsHydrationStatus {
  return useSyncExternalStore(
    subscribeClientSettingsHydration,
    getClientSettingsHydrationStatusSnapshot,
    () => "pending",
  );
}

function useClientSettingsValue(): ClientSettings {
  return useSyncExternalStore(
    subscribeClientSettings,
    getClientSettingsSnapshot,
    () => DEFAULT_CLIENT_SETTINGS,
  );
}

export function mergeEnvironmentSettings(
  serverSettings: ServerSettings,
  clientSettings: ClientSettings,
  environmentId: EnvironmentId | null = null,
): UnifiedSettings {
  // Coder: each workspace keeps its own favorites and model preferences, falling back to the
  // global ones until it has its own.
  const providerPreferences =
    environmentId === null
      ? undefined
      : clientSettings.providerPreferencesByEnvironment[environmentId];
  // Decode drops retired client keys, but older untyped persistence adapters
  // can still return them. Server-owned values must always win.
  return {
    ...clientSettings,
    ...serverSettings,
    favorites: providerPreferences?.favorites ?? clientSettings.favorites,
    providerModelPreferences:
      providerPreferences?.providerModelPreferences ?? clientSettings.providerModelPreferences,
  };
}

/**
 * Coder: applies a client patch, scoping favorites and model preferences to `environmentId` when
 * one is given. Other keys stay global.
 */
export function applyEnvironmentClientSettingsPatch(
  current: ClientSettings,
  patch: ClientSettingsPatch,
  environmentId: EnvironmentId | null,
): ClientSettings {
  if (
    environmentId === null ||
    (!("favorites" in patch) && !("providerModelPreferences" in patch))
  ) {
    return { ...current, ...patch };
  }

  const existing = current.providerPreferencesByEnvironment[environmentId];
  const scoped = {
    favorites: existing?.favorites ?? current.favorites,
    providerModelPreferences:
      existing?.providerModelPreferences ?? current.providerModelPreferences,
  };
  const unscopedPatch = { ...patch };
  delete unscopedPatch.favorites;
  delete unscopedPatch.providerModelPreferences;

  return {
    ...current,
    ...unscopedPatch,
    providerPreferencesByEnvironment: {
      ...current.providerPreferencesByEnvironment,
      [environmentId]: {
        favorites: patch.favorites ?? scoped.favorites,
        providerModelPreferences: patch.providerModelPreferences ?? scoped.providerModelPreferences,
      },
    },
  };
}

/** Coder: persists a client patch, scoping provider preferences to `environmentId`. */
function persistEnvironmentClientSettingsPatch(
  patch: ClientSettingsPatch,
  environmentId: EnvironmentId | null,
): Promise<unknown> {
  if (
    environmentId === null ||
    (!("favorites" in patch) && !("providerModelPreferences" in patch))
  ) {
    return persistClientSettingsPatch(patch);
  }
  return persistClientSettingsUpdate((current) =>
    applyEnvironmentClientSettingsPatch(current, patch, environmentId),
  ).catch((error) => {
    console.error(`${CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE} persist failed`, {
      operation: "persist",
      ...safeErrorLogAttributes(error),
    });
  });
}

function useMergedSettings<T>(
  serverSettings: ServerSettings,
  selector: ((settings: UnifiedSettings) => T) | undefined,
  environmentId: EnvironmentId | null = null,
): T {
  const clientSettings = useClientSettingsValue();

  const merged = useMemo<UnifiedSettings>(
    () => mergeEnvironmentSettings(serverSettings, clientSettings, environmentId),
    [clientSettings, environmentId, serverSettings],
  );

  return useMemo(() => (selector ? selector(merged) : (merged as T)), [merged, selector]);
}

export function useClientSettings<T = ClientSettings>(
  selector?: (settings: ClientSettings) => T,
): T {
  const settings = useClientSettingsValue();
  return useMemo(() => (selector ? selector(settings) : (settings as T)), [selector, settings]);
}

export function resolveEnvironmentIdentificationMode(input: {
  mode: EnvironmentIdentificationMode;
  settingsHydrated: boolean;
  paletteThemeActive?: boolean;
  paletteThemeAllowsArtwork?: boolean;
}): EnvironmentIdentificationMode {
  // Avoid briefly rendering the default artwork before a persisted pill/none choice loads.
  if (!input.settingsHydrated) return "none";
  // Artwork palettes are maintained for built-ins only. Keep an explicit
  // "none", but use the theme-aware pill for user-controlled palettes.
  return input.paletteThemeActive && !input.paletteThemeAllowsArtwork && input.mode === "artwork"
    ? "pill"
    : input.mode;
}

export function useEnvironmentIdentificationMode(): EnvironmentIdentificationMode {
  const settingsHydrated = useClientSettingsHydrated();
  const mode = useClientSettingsValue().environmentIdentificationMode;
  const { resolvedTheme, theme, themeHalves } = useTheme();
  const previewSidebarArtwork = useSyncExternalStore(
    subscribeToThemePreview,
    getThemePreviewSidebarArtwork,
    () => null,
  );
  const activeTheme = resolveThemeHalf(theme, themeHalves, resolvedTheme);
  const activeThemeDefinition = getThemeDefinition(activeTheme);
  return resolveEnvironmentIdentificationMode({
    mode,
    settingsHydrated,
    paletteThemeActive: previewSidebarArtwork !== null || activeThemeDefinition !== null,
    paletteThemeAllowsArtwork: previewSidebarArtwork ?? themeAllowsSidebarArtwork(activeTheme),
  });
}

// Coder: no legacy sidebar, so there is no `useLegacySidebarEnabled`.

/** Read current settings for one environment, merged with client-local preferences. */
export function useEnvironmentSettings<T = UnifiedSettings>(
  environmentId: EnvironmentId,
  selector?: (settings: UnifiedSettings) => T,
): T {
  const serverSettings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  return useMergedSettings(serverSettings ?? DEFAULT_SERVER_SETTINGS, selector, environmentId);
}

/** Atomically mutate one provider instance against the server's latest settings snapshot. */
export function usePersistEnvironmentProviderInstanceMutation(environmentId: EnvironmentId) {
  const mutateProviderInstance = useAtomCommand(serverEnvironment.mutateProviderInstance, {
    reportFailure: false,
  });
  return useCallback(
    (providerInstanceMutation: ProviderInstanceMutation, patch: ServerSettingsPatch = {}) =>
      mutateProviderInstance({
        environmentId,
        input: { patch, providerInstanceMutation },
      }),
    [environmentId, mutateProviderInstance],
  );
}

/** Primary-only settings access for the settings UI and other explicitly global surfaces. */
export function usePrimarySettings<T = UnifiedSettings>(
  selector?: (settings: UnifiedSettings) => T,
): T {
  // Coder: the primary environment is the active workspace, whose provider preferences apply.
  return useMergedSettings(
    useAtomValue(primaryServerSettingsAtom),
    selector,
    usePrimaryEnvironment()?.environmentId ?? null,
  );
}

export const PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE =
  "This setting is saved in a workspace. Connect a Coder workspace to change it.";

/**
 * Whether primary-scoped server settings have a server to live on. Coder: the active workspace
 * is the primary environment, so settings wait for a workspace to connect; there is no hosted app.
 */
export function usePrimarySettingsAvailable(): boolean {
  return usePrimaryEnvironment() !== null;
}

/** Connected sync targets, excluding grants already known to forbid settings writes. */
function useSharedSettingsSyncTargetIds(includePending = false): ReadonlyArray<EnvironmentId> {
  const { environments } = useEnvironments();
  const writableTargetsAtom = useMemo(
    () =>
      Atom.make(() =>
        // Coder: every workspace grants the settings write scope to its owner.
        environments
          .filter(supportsSharedSettingsSync)
          .map((environment) => environment.environmentId),
      ),
    // Coder: `includePending` matters only while a session grant loads, which never happens here.
    [environments, includePending],
  );
  return useAtomValue(writableTargetsAtom);
}

/**
 * Returns an updater that routes each key to the correct backing store.
 *
 * Server keys are optimistically patched in atom-backed server state, then
 * persisted via RPC. Shared server keys (see `SHARED_SERVER_SETTING_KEYS`)
 * are written to every eligible sync target, not only the selected target, so
 * a user preference does not silently drift between machines. Client keys go
 * through client persistence.
 */
function useUpdateSettingsTarget(environmentId: EnvironmentId | null) {
  // Mount this session even on pages without a visible permission-gated control.
  useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const persist = useAtomCommand(serverEnvironment.updateSettings, {
    label: "server settings update",
    reportFailure: false,
  });
  const { environments } = useEnvironments();
  const persistServerSettings = useCallback(
    async (request: Parameters<typeof persist>[0]) => {
      const result = await persist(request);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const label =
          environments.find((environment) => environment.environmentId === request.environmentId)
            ?.label ?? request.environmentId;
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Setting not saved",
          description: `Could not save on ${label}: ${error instanceof Error ? error.message : "The save failed. Try reconnecting and saving again."}`,
        });
      }
      return result;
    },
    [environments, persist],
  );
  const sharedSettingsSyncTargetIds = useSharedSettingsSyncTargetIds(true);
  const updateSettings = useCallback(
    (patch: UnifiedSettingsPatch) => {
      const { serverPatch, clientPatch } = splitPatch(patch);

      const canWriteServerPatch =
        environmentId === null ||
        requiredScopesForServerSettingsPatch(serverPatch).every((scope) =>
          readEnvironmentScope(environmentId, scope),
        );
      if (Object.keys(serverPatch).length > 0 && !canWriteServerPatch) {
        toastManager.add({
          type: "warning",
          title: "Setting not saved",
          description: `This connection lacks permission to change settings on ${environments.find((target) => target.environmentId === environmentId)?.label ?? "the selected environment"}.`,
        });
      }
      if (Object.keys(serverPatch).length > 0 && canWriteServerPatch) {
        const { sharedPatch, localPatch } = splitSharedServerPatch(serverPatch);
        // Dropping the write silently leaves the control looking saved.
        const warnUnsaved = (description = PRIMARY_SETTINGS_UNAVAILABLE_MESSAGE) =>
          toastManager.add({
            type: "warning",
            title: "Setting not saved",
            description,
          });
        if (Object.keys(localPatch).length > 0) {
          if (environmentId) {
            void persistServerSettings({
              environmentId,
              input: { patch: localPatch },
            });
          } else {
            warnUnsaved();
          }
        }
        if (Object.keys(sharedPatch).length > 0) {
          const sourceSettings = environments.find(
            (target) => target.environmentId === environmentId,
          )?.serverConfig?.settings;
          const targets = new Set(sharedSettingsSyncTargetIds);
          if (environmentId) {
            targets.add(environmentId);
          }
          const writes: Array<Parameters<typeof persist>[0]> = [];
          const deniedLabels: string[] = [];
          for (const targetId of targets) {
            const target = environments.find((candidate) => candidate.environmentId === targetId);
            const targetPatch = filterSharedServerPatch(
              sharedPatch,
              target?.serverConfig?.environment.capabilities,
              target?.serverConfig?.settings,
              sourceSettings,
              targetId === environmentId,
            );
            if (Object.keys(targetPatch).length === 0) continue;
            if (
              !requiredScopesForServerSettingsPatch(sharedPatch).every((scope) =>
                readEnvironmentScope(targetId, scope),
              )
            ) {
              deniedLabels.push(target?.label ?? targetId);
              continue;
            }
            writes.push({
              environmentId: targetId,
              input: { patch: targetPatch },
            });
          }
          if (writes.length === 0) {
            warnUnsaved(
              deniedLabels.length > 0
                ? `This connection lacks permission to change settings on ${deniedLabels.join(", ")}.`
                : targets.size > 0
                  ? "Update older servers to save this setting."
                  : undefined,
            );
          } else {
            void Promise.all(
              writes.map(async (request) => ({
                label:
                  environments.find((target) => target.environmentId === request.environmentId)
                    ?.label ?? request.environmentId,
                result: await persist(request),
              })),
            ).then((outcomes) => {
              const failures = outcomes.flatMap(({ label, result }) => {
                if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return [];
                const error = squashAtomCommandFailure(result);
                return [
                  `Could not save on ${label}: ${error instanceof Error ? error.message : "The save failed. Try reconnecting and saving again."}`,
                ];
              });
              if (failures.length === 0) return;
              const saved = outcomes
                .filter(({ result }) => result._tag === "Success")
                .map(({ label }) => label);
              toastManager.add({
                type: "error",
                title:
                  saved.length > 0 ? "Setting saved on some environments" : "Setting not saved",
                description: [
                  ...failures,
                  ...(saved.length > 0 ? [`Saved on ${saved.join(", ")}.`] : []),
                ].join("\n"),
              });
            });
          }
        }
      }
      if (Object.keys(clientPatch).length > 0) {
        void persistEnvironmentClientSettingsPatch(clientPatch, environmentId);
      }
    },
    [environmentId, environments, persist, persistServerSettings, sharedSettingsSyncTargetIds],
  );

  return updateSettings;
}

export function useUpdateEnvironmentSettings(environmentId: EnvironmentId) {
  return useUpdateSettingsTarget(environmentId);
}

export function useUpdatePrimarySettings() {
  return useUpdateSettingsTarget(usePrimaryEnvironment()?.environmentId ?? null);
}

/** Coder: with an `environmentId`, favorites and model preferences are saved for that workspace. */
export function useUpdateClientSettings(environmentId: EnvironmentId | null = null) {
  return useCallback(
    (patch: ClientSettingsPatch) => persistEnvironmentClientSettingsPatch(patch, environmentId),
    [environmentId],
  );
}

export function __resetClientSettingsPersistenceForTests(): void {
  clientSettingsHydrationGeneration += 1;
  clientSettingsSnapshot = DEFAULT_CLIENT_SETTINGS;
  clientSettingsHydrationStatus = "pending";
  clientSettingsHydrationPromise = null;
  clientSettingsPersistenceQueue = Promise.resolve();
  deferredClientSettingsPatchCount = 0;
  clientSettingsListeners.clear();
  clientSettingsHydrationListeners.clear();
}

export function __setClientSettingsForTests(settings: ClientSettings): void {
  clientSettingsHydrationGeneration += 1;
  clientSettingsSnapshot = settings;
  clientSettingsHydrationStatus = "ready";
  clientSettingsHydrationPromise = null;
}
