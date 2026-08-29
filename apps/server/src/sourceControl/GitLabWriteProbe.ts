import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as VcsProcess from "../vcs/VcsProcess.ts";

const PROBE_TIMEOUT_MS = 15_000;
const PROBE_MAX_OUTPUT_BYTES = 16 * 1024;

export interface GitLabWriteProbeBehavior {
  readonly request: (cwd: string) => {
    readonly args: ReadonlyArray<string>;
    readonly stdin?: string;
  };
  readonly accepts: (output: VcsProcess.VcsProcessOutput) => boolean;
}

/**
 * A POST that validates input without creating or changing a GitLab resource. Keeping the
 * behavior behind this value lets a deployment replace the canary once its workspace policy is
 * understood without changing any of the commands guarded by it.
 */
export const ciLintWriteProbe: GitLabWriteProbeBehavior = {
  request: () => ({
    args: [
      "api",
      "projects/:fullpath/ci/lint",
      "--method",
      "POST",
      "--input",
      "-",
      "--header",
      "Content-Type: application/json",
    ],
    stdin: JSON.stringify({ content: "t3_write_probe:\n  script: echo ok\n" }),
  }),
  accepts: (output) => output.exitCode === 0,
};

export interface GitLabWriteProbeResult {
  readonly writable: boolean;
}

export class GitLabWriteProbe extends Context.Service<
  GitLabWriteProbe,
  {
    readonly check: (input: {
      readonly cwd: string;
    }) => Effect.Effect<GitLabWriteProbeResult>;
  }
>()("t3/sourceControl/GitLabWriteProbe") {}

export function make(behavior: GitLabWriteProbeBehavior = ciLintWriteProbe) {
  return Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    const firstInput = yield* Deferred.make<{ readonly cwd: string }>();

    const cachedResult = yield* Effect.cached(
      Deferred.await(firstInput).pipe(
        Effect.flatMap((input) => {
          const request = behavior.request(input.cwd);
          return process.run({
            operation: "GitLabWriteProbe.check",
            command: "glab",
            args: request.args,
            cwd: input.cwd,
            allowNonZeroExit: true,
            timeoutMs: PROBE_TIMEOUT_MS,
            maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
            ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
          });
        }),
        Effect.map((output) => ({ writable: behavior.accepts(output) })),
        // A missing CLI, timeout, blocked process, or unreadable response all fail closed. The
        // underlying output is intentionally not carried into the result or logged here.
        Effect.catch(() => Effect.succeed({ writable: false })),
      ),
    );

    // This service lives for the workspace helper runtime. The first caller supplies a repository
    // cwd for glab's :fullpath expansion; every later caller shares the same settled result.
    const check: GitLabWriteProbe["Service"]["check"] = (input) =>
      Deferred.succeed(firstInput, input).pipe(Effect.andThen(cachedResult));

    return GitLabWriteProbe.of({ check });
  });
}

export function layerWithBehavior(behavior: GitLabWriteProbeBehavior) {
  return Layer.effect(GitLabWriteProbe, make(behavior));
}

export const layer = Layer.effect(GitLabWriteProbe, make());
