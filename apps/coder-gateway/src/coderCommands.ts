import type { DiscoveredCoderWorkspace } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { CoderInvocation } from "@t3tools/coder-cli/command";
import { GatewayProcessError, runGatewayProcess } from "./process.ts";

const MAX_CODER_LIST_BYTES = 2 * 1024 * 1024;
const MAX_CODER_AUTH_STATUS_BYTES = 64 * 1024;
const MAX_CODER_WORKSPACE_ACTION_BYTES = 64 * 1024;
const DEFAULT_CODER_AUTH_STATUS_TIMEOUT_MS = 15_000;
const DEFAULT_PROCESS_TERMINATION_GRACE_MS = 5_000;
const DEFAULT_CODER_WORKSPACE_LIST_TIMEOUT_MS = 30_000;

export const runCoderLogin = Effect.fn("coderGateway.runCoderLogin")(function* (
  executable: string,
  args: readonly string[],
) {
  const result = yield* runGatewayProcess(
    { executable, args },
    {
      label: "Coder login",
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      windowsHide: false,
    },
  );
  if (result.code !== 0) {
    return yield* Effect.fail(
      new GatewayProcessError(
        `Coder login exited with code ${String(result.code)} (${String(result.signal)}).`,
      ),
    );
  }
});

export type CoderAuthenticationStatus = "authenticated" | "unauthenticated" | "unavailable";

export function checkCoderAuthStatus(
  invocation: CoderInvocation,
  timeoutMs = DEFAULT_CODER_AUTH_STATUS_TIMEOUT_MS,
  terminationGraceMs = DEFAULT_PROCESS_TERMINATION_GRACE_MS,
): Effect.Effect<CoderAuthenticationStatus> {
  return runGatewayProcess(invocation, {
    label: "Coder authentication check",
    timeoutMs,
    terminationGraceMs,
    stdout: "ignore",
    stderrMode: "tail",
    maxStderrBytes: MAX_CODER_AUTH_STATUS_BYTES,
  }).pipe(
    Effect.map((result): CoderAuthenticationStatus => {
      if (result.code === 0) return "authenticated";
      return /\bStatus code 401\b/.test(result.stderr.toString("utf8"))
        ? "unauthenticated"
        : "unavailable";
    }),
    Effect.catch(() => Effect.succeed("unavailable" as const)),
  );
}

export function runCoderAuthStatus(
  invocation: CoderInvocation,
  timeoutMs = DEFAULT_CODER_AUTH_STATUS_TIMEOUT_MS,
  terminationGraceMs = DEFAULT_PROCESS_TERMINATION_GRACE_MS,
): Promise<CoderAuthenticationStatus> {
  return Effect.runPromise(checkCoderAuthStatus(invocation, timeoutMs, terminationGraceMs));
}

function discoveredWorkspace(value: unknown): DiscoveredCoderWorkspace | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const owner =
    typeof record.owner_name === "string"
      ? record.owner_name.trim()
      : typeof record.ownerName === "string"
        ? record.ownerName.trim()
        : "";
  const latestBuild =
    typeof record.latest_build === "object" &&
    record.latest_build !== null &&
    !Array.isArray(record.latest_build)
      ? (record.latest_build as Record<string, unknown>)
      : undefined;
  const rawStatus = latestBuild?.status;
  const status =
    rawStatus === "running" || rawStatus === "starting" || rawStatus === "stopped"
      ? rawStatus
      : "unknown";
  if (name.length === 0) return null;
  const health =
    typeof record.health === "object" && record.health !== null && !Array.isArray(record.health)
      ? (record.health as Record<string, unknown>)
      : undefined;
  const rawDeadline = latestBuild?.deadline;
  const deadlineMs = typeof rawDeadline === "string" ? Date.parse(rawDeadline) : Number.NaN;
  const rawMaxDeadline = latestBuild?.max_deadline;
  const maxDeadlineMs =
    typeof rawMaxDeadline === "string" ? Date.parse(rawMaxDeadline) : Number.NaN;
  const activeStartBuild =
    latestBuild?.transition === "start" && (status === "running" || status === "starting");
  const autostopAt =
    activeStartBuild && Number.isFinite(deadlineMs) ? new Date(deadlineMs).toISOString() : null;
  return {
    name,
    target: owner.length === 0 ? name : `${owner}/${name}`,
    status,
    updateAvailable: record.outdated === true,
    healthy: typeof health?.healthy === "boolean" ? health.healthy : null,
    autostopAt,
    requiredStopAt:
      autostopAt !== null && Number.isFinite(maxDeadlineMs)
        ? new Date(maxDeadlineMs).toISOString()
        : null,
  };
}

export function discoveredWorkspaceMatches(
  discovered: DiscoveredCoderWorkspace,
  workspace: { readonly workspace: string },
): boolean {
  return (
    discovered.target === workspace.workspace ||
    (!workspace.workspace.includes("/") && discovered.name === workspace.workspace)
  );
}

/** Fails once `signal` aborts; racing it interrupts the other effect, which stops its child. */
export function failWhenAborted(signal: AbortSignal): Effect.Effect<never, Error> {
  return Effect.callback<never, Error>((resume) => {
    const onAbort = () =>
      resume(Effect.fail(new Error("Coder workspace connection was cancelled.")));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });
}

export function runCoderWorkspaceList(
  invocation: CoderInvocation,
): Effect.Effect<readonly DiscoveredCoderWorkspace[], GatewayProcessError, never> {
  return runGatewayProcess(invocation, {
    label: "Coder workspace discovery",
    timeoutMs: DEFAULT_CODER_WORKSPACE_LIST_TIMEOUT_MS,
    maxStdoutBytes: MAX_CODER_LIST_BYTES,
    maxStderrBytes: MAX_CODER_LIST_BYTES,
    stdoutMode: "error",
  }).pipe(
    Effect.flatMap((result) => {
      if (result.code !== 0) {
        const detail = result.stderr.toString("utf8").trim();
        return Effect.fail(
          new GatewayProcessError(
            `Coder workspace discovery exited with code ${String(result.code)} (${String(result.signal)}).${detail.length === 0 ? "" : ` ${detail}`}`,
          ),
        );
      }
      return Effect.try({
        try: () => {
          const parsed = JSON.parse(result.stdout.toString("utf8")) as unknown;
          if (!Array.isArray(parsed)) throw new Error("Coder returned a non-array workspace list.");
          return parsed
            .map(discoveredWorkspace)
            .filter((workspace): workspace is DiscoveredCoderWorkspace => workspace !== null);
        },
        catch: (cause) =>
          new GatewayProcessError(
            cause instanceof Error ? cause.message : "Coder returned an invalid workspace list.",
            { cause },
          ),
      });
    }),
  );
}

export function runCoderWorkspaceAction(
  invocation: CoderInvocation,
  action: WorkspaceAction,
): Effect.Effect<void, GatewayProcessError> {
  return runGatewayProcess(invocation, {
    label: `Coder workspace ${action}`,
    maxStdoutBytes: MAX_CODER_WORKSPACE_ACTION_BYTES,
    maxStderrBytes: MAX_CODER_WORKSPACE_ACTION_BYTES,
    stdoutMode: "tail",
    stderrMode: "tail",
  }).pipe(
    Effect.flatMap((result) => {
      if (result.code === 0) return Effect.void;
      const detail = [result.stdout, result.stderr]
        .map((output) => output.toString("utf8").trim())
        .filter((output) => output.length > 0)
        .join("\n");
      return Effect.fail(
        new GatewayProcessError(
          `Coder workspace ${action} exited with code ${String(result.code)} (${String(result.signal)}).${detail.length === 0 ? "" : ` ${detail}`}`,
        ),
      );
    }),
  );
}

export type WorkspaceAction = "start" | "stop" | "restart" | "update";
