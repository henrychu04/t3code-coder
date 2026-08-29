import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ProcessRunner from "../../processRunner.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { codexMcpListArgs } from "./codexLaunchArgs.ts";

const CODEX_MCP_DISCOVERY_MAX_OUTPUT_BYTES = 1024 * 1024;
const CODEX_MCP_DISCOVERY_TIMEOUT = "15 seconds" as const;

const CodexMcpList = Schema.Array(
  Schema.Struct({
    name: Schema.String,
  }),
);
const decodeCodexMcpList = Schema.decodeUnknownEffect(CodexMcpList);

export class CodexIntegrationPolicyError extends Error {
  readonly unavailable: boolean;

  constructor(message: string, options: ErrorOptions & { readonly unavailable?: boolean } = {}) {
    super(message, options);
    this.name = "CodexIntegrationPolicyError";
    this.unavailable = options.unavailable ?? false;
  }
}

export type CodexMcpServerNameResolver = (
  cwd: string,
) => Effect.Effect<ReadonlyArray<string>, CodexIntegrationPolicyError>;

/**
 * Read configured MCP names without starting the servers. Codex merges config
 * tables, so an empty `mcp_servers` override cannot clear user or plugin MCPs;
 * every discovered name must receive a final `enabled=false` override instead.
 */
export const discoverCodexMcpServerNames = Effect.fn("discoverCodexMcpServerNames")(
  function* (input: {
    readonly binaryPath: string;
    readonly launchArgs?: string;
    readonly cwd: string;
    readonly homePath?: string;
    readonly environment?: NodeJS.ProcessEnv;
  }) {
    const runner = yield* ProcessRunner.make();
    const resolvedHomePath = input.homePath ? expandHomePath(input.homePath) : undefined;
    const environment = {
      ...input.environment,
      ...(resolvedHomePath ? { CODEX_HOME: resolvedHomePath } : {}),
    };
    const output = yield* runner
      .run({
        command: input.binaryPath,
        args: codexMcpListArgs(input.launchArgs),
        cwd: input.cwd,
        env: environment,
        timeout: CODEX_MCP_DISCOVERY_TIMEOUT,
        maxOutputBytes: CODEX_MCP_DISCOVERY_MAX_OUTPUT_BYTES,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new CodexIntegrationPolicyError("Codex MCP policy discovery failed.", {
              cause,
              unavailable: cause instanceof ProcessRunner.ProcessSpawnError,
            }),
        ),
      );

    if (output.code !== 0 || output.stdoutInvalidUtf8) {
      return yield* Effect.fail(
        new CodexIntegrationPolicyError("Codex MCP policy discovery returned an invalid result."),
      );
    }

    const parsed = yield* Effect.try({
      try: () => JSON.parse(output.stdout) as unknown,
      catch: () =>
        new CodexIntegrationPolicyError("Codex MCP policy discovery returned invalid JSON."),
    }).pipe(
      Effect.flatMap(decodeCodexMcpList),
      Effect.mapError((cause) =>
        cause instanceof CodexIntegrationPolicyError
          ? cause
          : new CodexIntegrationPolicyError(
              "Codex MCP policy discovery returned an invalid payload.",
            ),
      ),
    );

    return Array.from(new Set(parsed.map(({ name }) => name).filter((name) => name.length > 0)));
  },
);

export const makeCodexMcpServerNameResolver = (input: {
  readonly binaryPath: string;
  readonly launchArgs?: string;
  readonly homePath?: string;
  readonly environment?: NodeJS.ProcessEnv;
}): Effect.Effect<CodexMcpServerNameResolver, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return (cwd) =>
      discoverCodexMcpServerNames({ ...input, cwd }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
  });
