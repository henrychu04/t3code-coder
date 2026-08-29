import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type { SourceControlWriteAccess, SourceControlWriteAccessStatus } from "@t3tools/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";

const PROBE_TIMEOUT_MS = 15_000;
const PROBE_MAX_OUTPUT_BYTES = 16 * 1024;

export interface GitLabWriteProbeBehavior {
  readonly request: (cwd: string) => {
    readonly args: ReadonlyArray<string>;
    readonly stdin?: string;
  };
  readonly classifyProbe: (
    output: VcsProcess.VcsProcessOutput,
  ) => Exclude<SourceControlWriteAccessStatus, "unchecked">;
  readonly isPolicyBlockedWriteFailure: (stderr: string) => boolean;
}

const AUTH_FAILURE_PATTERNS = [
  /authentication failed/i,
  /not logged in/i,
  /glab auth login/i,
  /no oauth token/i,
  /unauthorized/i,
] as const;

const POLICY_BLOCK_PATTERNS = [
  /write (?:api |http )?endpoints?.*(?:blocked|disabled)/i,
  /write operations?.*(?:blocked|disabled)/i,
  /(?:blocked|denied) by (?:workspace|network|security) policy/i,
  /workspace.*(?:read[- ]only|writes? disabled)/i,
] as const;

const EXPECTED_GITLAB_REJECTION = /HTTP (?:400|404|405|422)\b/i;

function matchesAny(value: string, patterns: ReadonlyArray<RegExp>): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function access(status: SourceControlWriteAccessStatus): SourceControlWriteAccess {
  return { status, writable: status === "writable" };
}

/**
 * A mutation-shaped POST against an impossible project ID with no required MR fields. GitLab must
 * reject it without changing state; reaching that rejection proves the workspace allowed the
 * request to leave. The behavior stays replaceable as GS policy responses become better known.
 */
export const workspacePolicyWriteProbe: GitLabWriteProbeBehavior = {
  request: () => ({
    args: [
      "api",
      "projects/0/merge_requests",
      "--method",
      "POST",
      "--input",
      "-",
      "--header",
      "Content-Type: application/json",
    ],
    stdin: "{}",
  }),
  classifyProbe: (output) => {
    if (output.exitCode === 0) return "writable";
    if (matchesAny(output.stderr, AUTH_FAILURE_PATTERNS)) return "unauthenticated";
    if (matchesAny(output.stderr, POLICY_BLOCK_PATTERNS)) return "policy-blocked";
    if (EXPECTED_GITLAB_REJECTION.test(output.stderr)) return "writable";
    return "indeterminate";
  },
  isPolicyBlockedWriteFailure: (stderr) => matchesAny(stderr, POLICY_BLOCK_PATTERNS),
};

export type GitLabWriteProbeResult = SourceControlWriteAccess;

export class GitLabWriteProbe extends Context.Service<
  GitLabWriteProbe,
  {
    readonly check: (input: { readonly cwd: string }) => Effect.Effect<GitLabWriteProbeResult>;
    readonly current: Effect.Effect<GitLabWriteProbeResult>;
    readonly reprobe: (input: { readonly cwd: string }) => Effect.Effect<GitLabWriteProbeResult>;
    readonly markPolicyBlocked: Effect.Effect<void>;
    readonly isPolicyBlockedWriteFailure: (stderr: string) => boolean;
  }
>()("t3/sourceControl/GitLabWriteProbe") {}

export function make(behavior: GitLabWriteProbeBehavior = workspacePolicyWriteProbe) {
  return Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    const state = yield* SynchronizedRef.make<GitLabWriteProbeResult>(access("unchecked"));

    const runProbe = (input: { readonly cwd: string }) => {
      const request = behavior.request(input.cwd);
      return process
        .run({
          operation: "GitLabWriteProbe.check",
          command: "glab",
          args: request.args,
          cwd: input.cwd,
          allowNonZeroExit: true,
          timeoutMs: PROBE_TIMEOUT_MS,
          maxOutputBytes: PROBE_MAX_OUTPUT_BYTES,
          ...(request.stdin === undefined ? {} : { stdin: request.stdin }),
        })
        .pipe(
          Effect.map((output) => access(behavior.classifyProbe(output))),
          // A missing CLI, timeout, blocked process, or unreadable response all fail closed. The
          // underlying output is intentionally not carried into the result or logged here.
          Effect.catch(() => Effect.succeed(access("indeterminate"))),
        );
    };

    // Startup settles this once for the workspace. The synchronized ref also makes an early RPC
    // or write racing startup share that process rather than spawning a second canary.
    const check: GitLabWriteProbe["Service"]["check"] = (input) =>
      SynchronizedRef.updateAndGetEffect(state, (current) =>
        current.status === "unchecked" ? runProbe(input) : Effect.succeed(current),
      );

    const reprobe: GitLabWriteProbe["Service"]["reprobe"] = (input) =>
      SynchronizedRef.updateAndGetEffect(state, () => runProbe(input));

    return GitLabWriteProbe.of({
      check,
      current: SynchronizedRef.get(state),
      reprobe,
      markPolicyBlocked: SynchronizedRef.set(state, access("policy-blocked")),
      isPolicyBlockedWriteFailure: behavior.isPolicyBlockedWriteFailure,
    });
  });
}

export function layerWithBehavior(behavior: GitLabWriteProbeBehavior) {
  return Layer.effect(GitLabWriteProbe, make(behavior));
}

export const layer = Layer.effect(GitLabWriteProbe, make());
