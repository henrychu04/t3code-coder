// @effect-diagnostics nodeBuiltinImport:off - the guarded file read needs open
// flags (O_NOFOLLOW, O_NONBLOCK) the FileSystem service does not expose.
/** Coder: see "Workspace themes" in docs/internals/coder-only.md.
 * Workspace-published palettes, delivered as decoded metadata through helper stdio.
 * The filename is a stable ID, so selected themes follow subsequent recolors.
 * Invalid or inaccessible files are skipped without exposing paths or contents.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  EnvironmentTheme,
  EnvironmentThemeFile,
  EnvironmentThemeId,
  environmentThemeFileHasColors,
} from "@t3tools/contracts";
import { UNPUBLISHABLE_THEME_IDS } from "@t3tools/shared/themePalettes";
import { readConfigMetadata } from "./project/configMetadata.ts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "./config.ts";

const decodeEnvironmentThemeFileJsonExit = Schema.decodeUnknownExit(
  Schema.fromJsonString(EnvironmentThemeFile),
);
const isEnvironmentThemeId = Schema.is(EnvironmentThemeId);

const THEME_FILE_SUFFIX = ".json";

const MAX_THEME_FILES = 32;
/** Exported so the publish path cannot accept a file the watcher will skip. */
export const MAX_THEME_FILE_BYTES = 32 * 1024;
const MAX_THEME_TOTAL_BYTES = 192 * 1024;

interface PublishedThemes {
  readonly seq: number;
  readonly themes: ReadonlyArray<EnvironmentTheme>;
}

export class EnvironmentThemeService extends Context.Service<
  EnvironmentThemeService,
  {
    readonly current: Effect.Effect<ReadonlyArray<EnvironmentTheme>>;

    /**
     * The subscription is acquired before the current set is read, so a publish
     * landing while a client connects is delivered rather than lost.
     */
    readonly streamChanges: Stream.Stream<ReadonlyArray<EnvironmentTheme>>;
  }
>()("t3/environmentTheme/EnvironmentThemeService") {}

/** Fixed metadata files must be bounded, regular UTF-8 files, never symlinks. */
export const readThemeFileGuarded = readConfigMetadata;

export const readPublishedThemes = Effect.fn(function* (themesDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const expectedDirectory = yield* Effect.sync(() => {
    try {
      if (!NodeFS.lstatSync(themesDir).isDirectory()) return null;
      const expected = NodePath.join(
        NodeFS.realpathSync(NodePath.dirname(themesDir)),
        NodePath.basename(themesDir),
      );
      return NodeFS.realpathSync(themesDir) === expected ? expected : null;
    } catch {
      return null;
    }
  });
  if (expectedDirectory === null) return [];
  const entries = yield* fs
    .readDirectory(themesDir)
    .pipe(Effect.orElseSucceed((): Array<string> => []));

  const themes: Array<EnvironmentTheme> = [];
  let examined = 0;
  let totalBytes = 0;
  for (const entry of entries.toSorted()) {
    if (!entry.endsWith(THEME_FILE_SUFFIX)) continue;
    const id = entry.slice(0, -THEME_FILE_SUFFIX.length);
    // A reserved id is either shadowed by a built-in on the client or captures
    // clients that never chose it, so it is not publishable.
    if (!isEnvironmentThemeId(id) || UNPUBLISHABLE_THEME_IDS.has(id)) continue;

    // Counts files examined, not themes accepted: capping the output would
    // let a directory of malformed files be opened, read, and decoded in full
    // on every refresh and every client connect.
    examined += 1;
    if (examined > MAX_THEME_FILES) {
      yield* Effect.logWarning(
        "A workspace theme was skipped because it is invalid or exceeds a limit.",
      );
      break;
    }

    const filePath = `${themesDir}/${entry}`;
    const raw = readThemeFileGuarded(filePath, MAX_THEME_FILE_BYTES, expectedDirectory);
    if (raw === null) {
      yield* Effect.logWarning(
        "A workspace theme was skipped because it is invalid or exceeds a limit.",
      );
      continue;
    }
    if (raw.trim().length === 0) continue;

    const decoded = decodeEnvironmentThemeFileJsonExit(raw);
    if (decoded._tag === "Failure") {
      yield* Effect.logWarning(
        "A workspace theme was skipped because it is invalid or exceeds a limit.",
      );
      continue;
    }
    const file = decoded.value;
    if (!environmentThemeFileHasColors(file)) {
      yield* Effect.logWarning(
        "A workspace theme was skipped because it is invalid or exceeds a limit.",
      );
      continue;
    }

    totalBytes += Buffer.byteLength(raw);
    if (totalBytes > MAX_THEME_TOTAL_BYTES) {
      yield* Effect.logWarning(
        "A workspace theme was skipped because it is invalid or exceeds a limit.",
      );
      break;
    }

    themes.push({ id, ...file });
  }
  return themes;
});

const make = Effect.gen(function* () {
  const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  /**
   * Every observed set carries a sequence number, so a subscriber can drop
   * queued events that predate the snapshot it started from. Without it a
   * publish landing between subscribing and reading replays after the newer
   * value and walks clients backwards onto stale colors.
   */
  const changes = yield* PubSub.sliding<PublishedThemes>(1);
  const published = yield* Ref.make<PublishedThemes>({ seq: 0, themes: [] });
  /**
   * Guards the whole read/compare/publish, not just the state update. The
   * directory read is async, so two concurrent refreshes can finish out of
   * order and a slower read of an older set would publish under a higher
   * sequence -- which the subscriber filter, ordering publications rather than
   * observations, could not then drop.
   */
  const refreshSemaphore = yield* Semaphore.make(1);
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));

  const refresh = refreshSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const themes = yield* readPublishedThemes(environmentThemesDir).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      );
      // Structural equality over the whole decoded value: a hand-rolled field
      // list here silently drops republishes for any field it forgets.
      const [changed, next] = yield* Ref.modify(
        published,
        (previous): readonly [readonly [boolean, PublishedThemes], PublishedThemes] => {
          if (Equal.equals(previous.themes, themes)) return [[false, previous], previous];
          const updated: PublishedThemes = { seq: previous.seq + 1, themes };
          return [[true, updated], updated];
        },
      );
      if (changed) yield* PubSub.publish(changes, next).pipe(Effect.asVoid);
      return next;
    }),
  );

  // The directory is created up front so the watcher has something to attach
  // to before the first publisher writes into it.
  yield* fs.makeDirectory(environmentThemesDir, { recursive: true }).pipe(Effect.ignoreCause());

  const watchable = yield* Effect.sync(() => {
    try {
      return (
        NodeFS.lstatSync(environmentThemesDir).isDirectory() &&
        !NodeFS.lstatSync(environmentThemesDir).isSymbolicLink()
      );
    } catch {
      return false;
    }
  });

  // Debounced for the same reason settings watching is: a theme script emits
  // several events per save and `fs.watch` can fire before the content is
  // flushed.
  const watchEvents = watchable
    ? fs.watch(environmentThemesDir).pipe(Stream.debounce(Duration.millis(100)))
    : Stream.empty;

  yield* refresh;
  yield* Stream.runForEach(watchEvents, () => refresh.pipe(Effect.ignoreCause())).pipe(
    Effect.ignoreCause(),
    Effect.forkIn(watcherScope),
    Effect.asVoid,
  );

  return {
    current: Effect.map(refresh, (state) => state.themes),
    get streamChanges() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const snapshot = yield* refresh;
          return Stream.concat(
            Stream.make(snapshot.themes),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((update) => update.seq > snapshot.seq),
              Stream.map((update) => update.themes),
            ),
          );
        }),
      );
    },
  } satisfies EnvironmentThemeService["Service"];
});

export const layer = Layer.effect(EnvironmentThemeService, make);
