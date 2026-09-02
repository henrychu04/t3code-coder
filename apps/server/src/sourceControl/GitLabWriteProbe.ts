import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type {
  SourceControlWriteAccess,
  SourceControlWriteAccessStatus,
  VcsError,
} from "@t3tools/contracts";

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
  /HTTP(?:\/\d(?:\.\d)?)?\s+401\b|glab:\s*401\b/i,
] as const;

const POLICY_BLOCK_PATTERNS = [
  /write (?:api |http )?endpoints?.*(?:blocked|disabled)/i,
  /write operations?.*(?:blocked|disabled)/i,
  /(?:blocked|denied) by (?:workspace|network|security) policy/i,
  /workspace.*(?:read[- ]only|writes? disabled)/i,
] as const;

const EXPECTED_GITLAB_REJECTION =
  /HTTP(?:\/\d(?:\.\d)?)?\s+(?:400|404|405|422)\b|glab:\s*(?:400|404|405|422)\b/i;
const GITLAB_RESPONSE_FINGERPRINTS = [
  /\bx-gitlab-(?:feature-category|meta|version)\s*:/i,
  /"message"\s*:\s*"(?:404 )?project not found"/i,
  /glab:\s*(?:400 bad request|404 project not found|405 method not allowed|422 unprocessable entity)\b/i,
] as const;
const NETWORK_FAILURE_PATTERNS = [
  /could not resolve host/i,
  /connection refused/i,
  /network is unreachable/i,
  /no route to host/i,
  /proxyconnect tcp/i,
  /i\/o timeout/i,
] as const;
const TLS_FAILURE_PATTERNS = [
  /certificate signed by unknown authority/i,
  /certificate verify failed/i,
  /tls handshake/i,
  /x509:/i,
] as const;
const CLI_USAGE_FAILURE_PATTERNS = [
  /accepts?\s+\d+\s+arg(?:ument)?\(s\), received \d+/i,
  /unknown (?:shorthand )?flag:/i,
] as const;
const RATE_LIMIT_PATTERN = /HTTP(?:\/\d(?:\.\d)?)?\s+429\b|glab:\s*429\b|too many requests/i;
const FORBIDDEN_PATTERN = /HTTP(?:\/\d(?:\.\d)?)?\s+403\b|glab:\s*403\b|\bforbidden\b/i;
const SERVER_FAILURE_PATTERN =
  /HTTP(?:\/\d(?:\.\d)?)?\s+5\d\d\b|glab:\s*5\d\d\b|bad gateway|service unavailable/i;

function matchesAny(value: string, patterns: ReadonlyArray<RegExp>): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function access(status: SourceControlWriteAccessStatus, detail?: string): SourceControlWriteAccess {
  return {
    status,
    writable: status === "writable",
    ...(detail === undefined ? {} : { detail }),
  };
}

/** Returns only fixed text derived from coarse result categories, never command output. */
function unrecognizedResponseDetail(output: VcsProcess.VcsProcessOutput): string {
  if (output.stdoutInvalidUtf8 === true || output.stderrInvalidUtf8 === true) {
    return "The GitLab CLI returned output that was not valid UTF-8, so the probe could not verify it.";
  }
  if (output.stdoutTruncated || output.stderrTruncated) {
    return "The GitLab CLI response exceeded the probe output limit and was truncated.";
  }
  const response = `${output.stdout}\n${output.stderr}`;
  if (matchesAny(response, NETWORK_FAILURE_PATTERNS)) {
    return "The GitLab CLI could not reach GitLab because of a network, DNS, or proxy failure.";
  }
  if (matchesAny(response, TLS_FAILURE_PATTERNS)) {
    return "The GitLab CLI could not establish a trusted TLS connection to GitLab.";
  }
  if (matchesAny(response, CLI_USAGE_FAILURE_PATTERNS)) {
    return "The installed GitLab CLI rejected the write probe command syntax. Reconnect after updating T3 Coder, or update glab in the workspace.";
  }
  if (RATE_LIMIT_PATTERN.test(response)) {
    return "GitLab rate-limited the write probe. Writes remain disabled until a later probe succeeds.";
  }
  if (FORBIDDEN_PATTERN.test(response)) {
    return "GitLab or an intermediary rejected the write-shaped request with HTTP 403. Writes remain disabled.";
  }
  if (SERVER_FAILURE_PATTERN.test(response)) {
    return "GitLab or an intermediary returned a server error while handling the write probe.";
  }
  if (output.exitCode === 0) {
    return "The invalid write canary unexpectedly reported success, so the probe could not verify the result safely.";
  }
  return `The GitLab CLI exited with status ${output.exitCode}, but its response did not match a known GitLab, authentication, or workspace-policy result.`;
}

/** Maps typed process failures to safe UI diagnostics without inspecting their causes. */
function processFailureDetail(error: VcsError): string {
  switch (error._tag) {
    case "VcsProcessSpawnError":
      return "The workspace could not start the GitLab CLI. Confirm that glab is installed and executable.";
    case "VcsProcessTimeoutError":
      return `The GitLab write probe timed out after ${Math.round(error.timeoutMs / 1_000)} seconds.`;
    case "VcsProcessStdinWriteError":
      return "The workspace could not send the write canary to the GitLab CLI.";
    case "VcsProcessOutputReadError":
    case "VcsProcessMissingExitCodeError":
      return "The workspace could not read a complete probe result from the GitLab CLI.";
    case "VcsProcessOutputLimitError":
      return "The GitLab CLI response exceeded the probe output limit.";
    case "VcsProcessExitError":
    case "VcsRepositoryDetectionError":
    case "VcsUnsupportedOperationError":
      return "The workspace could not complete the GitLab write probe.";
  }
}

/**
 * A mutation-shaped POST against an impossible project ID with no required MR fields. GitLab must
 * reject it without changing state; reaching that rejection proves the workspace allowed the
 * request to leave. The behavior stays replaceable as GS policy responses become better known.
 */
export const workspacePolicyWriteProbe: GitLabWriteProbeBehavior = {
  request: () => ({
    args: ["api", "--method", "POST", "projects/0/merge_requests"],
  }),
  classifyProbe: (output) => {
    const response = `${output.stdout}\n${output.stderr}`;
    if (matchesAny(response, AUTH_FAILURE_PATTERNS)) return "unauthenticated";
    if (matchesAny(response, POLICY_BLOCK_PATTERNS)) return "policy-blocked";
    if (
      output.exitCode !== 0 &&
      EXPECTED_GITLAB_REJECTION.test(response) &&
      matchesAny(response, GITLAB_RESPONSE_FINGERPRINTS)
    ) {
      return "writable";
    }
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
          Effect.map((output) => {
            const outputIncomplete =
              output.stdoutInvalidUtf8 === true ||
              output.stderrInvalidUtf8 === true ||
              output.stdoutTruncated ||
              output.stderrTruncated;
            const status = outputIncomplete ? "indeterminate" : behavior.classifyProbe(output);
            return access(
              status,
              status === "indeterminate" ? unrecognizedResponseDetail(output) : undefined,
            );
          }),
          // Fail closed with a bounded explanation. Causes and command output remain inside the
          // workspace process boundary and are neither transported nor logged.
          Effect.catch((error) =>
            Effect.succeed(access("indeterminate", processFailureDetail(error))),
          ),
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
