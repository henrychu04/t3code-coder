import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

export interface ServerDerivedPaths {
  readonly stateDir: string;
  readonly dbPath: string;
  readonly keybindingsConfigPath: string;
  readonly settingsPath: string;
  readonly providerStatusCacheDir: string;
  readonly worktreesDir: string;
  readonly logsDir: string;
  readonly terminalLogsDir: string;
  readonly environmentIdPath: string;
  readonly screenshotArtifactsDir: string;
}

export class ServerConfig extends Context.Service<
  ServerConfig,
  ServerDerivedPaths & {
    readonly cwd: string;
    readonly baseDir: string;
  }
>()("t3/config/ServerConfig") {
  static readonly layerTest = (
    cwd: string,
    baseDirOrPrefix: string | { readonly prefix: string },
  ) => layerTest(cwd, baseDirOrPrefix);
}

export const deriveServerPaths = Effect.fn(function* (baseDir: string) {
  const path = yield* Path.Path;
  const stateDir = path.join(baseDir, "userdata");
  const logsDir = path.join(stateDir, "logs");
  return {
    stateDir,
    dbPath: path.join(stateDir, "state.sqlite"),
    keybindingsConfigPath: path.join(stateDir, "keybindings.json"),
    settingsPath: path.join(stateDir, "settings.json"),
    providerStatusCacheDir: path.join(baseDir, "caches"),
    worktreesDir: path.join(baseDir, "worktrees"),
    logsDir,
    terminalLogsDir: path.join(logsDir, "terminals"),
    environmentIdPath: path.join(stateDir, "environment-id"),
    screenshotArtifactsDir: path.join(baseDir, "artifacts"),
  } satisfies ServerDerivedPaths;
});

export const ensureServerDirectories = Effect.fn(function* (paths: ServerDerivedPaths) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* Effect.all(
    [
      paths.stateDir,
      paths.logsDir,
      paths.terminalLogsDir,
      paths.providerStatusCacheDir,
      paths.worktreesDir,
      paths.screenshotArtifactsDir,
    ].map((directory) => fileSystem.makeDirectory(directory, { recursive: true })),
    { concurrency: "unbounded" },
  );
});

export const layer = (config: ServerConfig["Service"]) =>
  Layer.succeed(ServerConfig, ServerConfig.of(config));

const makeTest = Effect.fn(function* (
  cwd: string,
  baseDirOrPrefix: string | { readonly prefix: string },
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const baseDir =
    typeof baseDirOrPrefix === "string"
      ? baseDirOrPrefix
      : yield* fileSystem.makeTempDirectoryScoped({ prefix: baseDirOrPrefix.prefix });
  const paths = yield* deriveServerPaths(baseDir);
  yield* ensureServerDirectories(paths);
  return ServerConfig.of({ cwd, baseDir, ...paths });
});

export const layerTest = (cwd: string, baseDirOrPrefix: string | { readonly prefix: string }) =>
  Layer.effect(ServerConfig, makeTest(cwd, baseDirOrPrefix));
