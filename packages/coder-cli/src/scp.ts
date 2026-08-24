// @effect-diagnostics nodeBuiltinImport:off
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  buildCoderScpConfigInvocation,
  buildCoderWorkspaceShellInvocation,
  type CoderInvocation,
  type CoderInvocationOptions,
} from "./command.ts";
import {
  normalizeCoderWorkspaceProfile,
  type CoderDeploymentProfile,
  type CoderWorkspaceProfile,
} from "./profile.ts";

const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_SCP_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_TERMINATION_GRACE_MS = 5_000;
const REQUIRED_CODER_PROXY_FLAGS = [
  "--no-version-warning",
] as const;
const IMAGE_PATH_SENTINEL = "T3_CODER_IMAGE_PATH=";

export type CoderClipboardImageExtension = "jpg" | "png" | "webp";

export class CoderProcessError extends Error {
  readonly _tag = "CoderProcessError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CoderProcessError";
  }
}

function appendOutput(current: Buffer, chunk: Buffer): Buffer {
  if (current.byteLength >= MAX_PROCESS_OUTPUT_BYTES) return current;
  return Buffer.concat([current, chunk.subarray(0, MAX_PROCESS_OUTPUT_BYTES - current.byteLength)]);
}

export function runProcess(
  invocation: CoderInvocation,
  label: string,
  timeoutMs: number,
  terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
): Effect.Effect<string, CoderProcessError> {
  return Effect.scoped(
    Effect.gen(function* () {
      const exit = yield* Deferred.make<
        | {
            readonly _tag: "Exit";
            readonly code: number | null;
            readonly signal: NodeJS.Signals | null;
          }
        | { readonly _tag: "Error"; readonly cause: Error }
      >();
      let stdout: Buffer = Buffer.alloc(0);
      yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            const child = spawn(invocation.executable, invocation.args, {
              shell: false,
              stdio: ["ignore", "pipe", "pipe"],
              windowsHide: true,
            });
            child.stdout.on("data", (chunk: Buffer) => {
              stdout = appendOutput(stdout, chunk);
            });
            // Drain stderr without retaining local paths or transfer details.
            child.stderr.resume();
            child.once("error", (cause) => {
              Deferred.doneUnsafe(exit, Effect.succeed({ _tag: "Error", cause }));
            });
            child.once("exit", (code, signal) => {
              Deferred.doneUnsafe(exit, Effect.succeed({ _tag: "Exit", code, signal }));
            });
            return child;
          },
          catch: (cause) => new CoderProcessError(`${label} could not start.`, { cause }),
        }),
        (child) =>
          Effect.uninterruptible(
            Effect.suspend(() => {
              if (Deferred.isDoneUnsafe(exit)) return Effect.void;
              child.kill("SIGTERM");
              return Deferred.await(exit).pipe(
                Effect.timeoutOption(terminationGraceMs),
                Effect.flatMap((result) => {
                  if (Option.isSome(result)) return Effect.void;
                  if (child.exitCode === null && child.signalCode === null) {
                    child.kill("SIGKILL");
                  }
                  return Deferred.await(exit).pipe(Effect.asVoid);
                }),
              );
            }),
          ).pipe(Effect.catchCause(() => Effect.void)),
      );

      const result = yield* Deferred.await(exit).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () => Effect.fail(new CoderProcessError(`${label} timed out.`)),
        }),
      );
      if (result._tag === "Error") {
        return yield* Effect.fail(
          new CoderProcessError(`${label} could not start.`, { cause: result.cause }),
        );
      }
      if (result.code !== 0) {
        return yield* Effect.fail(
          new CoderProcessError(
            `${label} failed (code ${String(result.code)}, signal ${String(result.signal)}).`,
          ),
        );
      }
      return stdout.toString("utf8");
    }),
  );
}

export function scopeCoderScpConfig(generatedConfig: string, hostPrefix: string): string {
  const lines = generatedConfig.split(/\r?\n/u);
  const hostHeader = `Host ${hostPrefix}*`;
  const start = lines.findIndex((line) => line.trim() === hostHeader);
  if (start < 0) {
    throw new Error("Coder did not generate the expected temporary SSH host entry.");
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (line.startsWith("Host ") || line.startsWith("Match ")) {
      end = index;
      break;
    }
  }
  let proxyCount = 0;
  const scoped = lines.slice(start, end).map((line) => {
    if (!line.trimStart().startsWith("ProxyCommand ")) return line;
    proxyCount += 1;
    const marker = " ssh --stdio";
    if (!line.includes(marker)) {
      throw new Error("Coder generated an unsupported SSH ProxyCommand.");
    }
    if (REQUIRED_CODER_PROXY_FLAGS.every((flag) => line.includes(flag))) {
      return line;
    }
    return line.replace(marker, ` ${REQUIRED_CODER_PROXY_FLAGS.join(" ")}${marker}`);
  });
  if (proxyCount !== 1) {
    throw new Error("Coder did not generate exactly one temporary SSH ProxyCommand.");
  }
  return `${scoped.join(NodeOS.EOL).trimEnd()}${NodeOS.EOL}`;
}

export function buildCoderScpInvocation(input: {
  readonly platform: NodeJS.Platform;
  readonly sshConfigPath: string;
  readonly localPath: string;
  readonly sshHost: string;
  readonly remotePath: string;
  readonly scpExecutable?: string;
}): CoderInvocation {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(input.sshHost)) {
    throw new Error("Temporary SCP host contains unsupported characters.");
  }
  if (!/^\.t3-coder\/(?:bin|attachments)\/[a-zA-Z0-9._-]+$/.test(input.remotePath)) {
    throw new Error("SCP destination must be a generated T3 Coder transfer path.");
  }
  return {
    executable: input.scpExecutable ?? (input.platform === "win32" ? "scp.exe" : "scp"),
    args: [
      "-F",
      input.sshConfigPath,
      "-B",
      input.localPath,
      `${input.sshHost}:${input.remotePath}`,
    ],
  };
}

function withCoderScpConfig<T, E, R>(input: {
  readonly deployment: CoderDeploymentProfile;
  readonly workspace: CoderWorkspaceProfile;
  readonly invocationOptions?: CoderInvocationOptions;
  readonly action: (config: {
    readonly path: string;
    readonly host: string;
  }) => Effect.Effect<T, E, R>;
}): Effect.Effect<T, E | CoderProcessError, R> {
  return Effect.scoped(
    Effect.gen(function* () {
      const workspace = normalizeCoderWorkspaceProfile(input.workspace);
      const workspaceName = workspace.workspace.split("/").at(-1);
      if (!workspaceName) {
        return yield* Effect.fail(new CoderProcessError("Coder workspace name is unavailable."));
      }
      const transferId = randomUUID();
      const hostPrefix = `t3-coder-${transferId}-`;
      const directory = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-scp-")),
          catch: (cause) =>
            new CoderProcessError("Temporary SSH configuration directory could not be created.", {
              cause,
            }),
        }),
        (directory) =>
          Effect.tryPromise({
            try: () => NodeFS.rm(directory, { recursive: true, force: true }),
            catch: (cause) =>
              new CoderProcessError("Temporary SSH configuration directory could not be removed.", {
                cause,
              }),
          }).pipe(Effect.orDie),
      );
      const configPath = NodePath.join(directory, "ssh-config");
      yield* runProcess(
        buildCoderScpConfigInvocation(
          input.deployment,
          configPath,
          hostPrefix,
          input.invocationOptions,
        ),
        "Coder SSH configuration",
        DEFAULT_COMMAND_TIMEOUT_MS,
      );
      const generatedConfig = yield* Effect.tryPromise({
        try: () => NodeFS.readFile(configPath, "utf8"),
        catch: (cause) =>
          new CoderProcessError("Temporary SSH configuration could not be read.", { cause }),
      });
      yield* Effect.tryPromise({
        try: () =>
          NodeFS.writeFile(configPath, scopeCoderScpConfig(generatedConfig, hostPrefix), {
            mode: 0o600,
          }),
        catch: (cause) =>
          new CoderProcessError("Temporary SSH configuration could not be secured.", { cause }),
      });
      return yield* input.action({ path: configPath, host: `${hostPrefix}${workspaceName}` });
    }),
  );
}

function copyWithCoderScp(input: {
  readonly deployment: CoderDeploymentProfile;
  readonly workspace: CoderWorkspaceProfile;
  readonly invocationOptions?: CoderInvocationOptions;
  readonly localPath: string;
  readonly remotePath: string;
  readonly platform?: NodeJS.Platform;
  readonly scpExecutable?: string;
}): Effect.Effect<void, CoderProcessError> {
  return withCoderScpConfig({
    deployment: input.deployment,
    workspace: input.workspace,
    ...(input.invocationOptions ? { invocationOptions: input.invocationOptions } : {}),
    action: ({ path, host }) =>
      runProcess(
        buildCoderScpInvocation({
          platform: input.platform ?? process.platform,
          sshConfigPath: path,
          localPath: input.localPath,
          sshHost: host,
          remotePath: input.remotePath,
          ...(input.scpExecutable ? { scpExecutable: input.scpExecutable } : {}),
        }),
        "Coder SCP transfer",
        DEFAULT_SCP_TIMEOUT_MS,
      ),
  });
}

function cleanupRemoteTransfer(
  deployment: CoderDeploymentProfile,
  workspace: CoderWorkspaceProfile,
  remotePath: string,
  invocationOptions?: CoderInvocationOptions,
): Effect.Effect<void> {
  const command = `rm -f "$HOME/${remotePath}"`;
  return runProcess(
    buildCoderWorkspaceShellInvocation(deployment, workspace, command, invocationOptions),
    "Coder transfer cleanup",
    DEFAULT_COMMAND_TIMEOUT_MS,
  ).pipe(
    // Cleanup is best-effort after the authoritative transfer failure.
    Effect.ignore,
  );
}

export function installCoderHelperWithScp(input: {
  readonly deployment: CoderDeploymentProfile;
  readonly workspace: CoderWorkspaceProfile;
  readonly helperBundlePath: string;
  readonly invocationOptions?: CoderInvocationOptions;
  readonly platform?: NodeJS.Platform;
  readonly scpExecutable?: string;
}): Effect.Effect<void, CoderProcessError> {
  return Effect.gen(function* () {
    const remotePath = `.t3-coder/bin/workspace-helper.tmp.${randomUUID()}`;
    const install = Effect.gen(function* () {
      yield* copyWithCoderScp({
        deployment: input.deployment,
        workspace: input.workspace,
        localPath: input.helperBundlePath,
        remotePath,
        ...(input.invocationOptions ? { invocationOptions: input.invocationOptions } : {}),
        ...(input.platform ? { platform: input.platform } : {}),
        ...(input.scpExecutable ? { scpExecutable: input.scpExecutable } : {}),
      });
      const command = [
        "set -eu",
        `temporary="$HOME/${remotePath}"`,
        '[ -f "$temporary" ]',
        'chmod 700 "$temporary"',
        'mv "$temporary" "$HOME/.t3-coder/bin/workspace-helper"',
      ].join("; ");
      yield* runProcess(
        buildCoderWorkspaceShellInvocation(
          input.deployment,
          input.workspace,
          command,
          input.invocationOptions,
        ),
        "Coder helper finalization",
        DEFAULT_COMMAND_TIMEOUT_MS,
      );
    });
    yield* install.pipe(
      Effect.onError(() =>
        cleanupRemoteTransfer(
          input.deployment,
          input.workspace,
          remotePath,
          input.invocationOptions,
        ),
      ),
    );
  });
}

export function uploadCoderClipboardImageWithScp(input: {
  readonly deployment: CoderDeploymentProfile;
  readonly workspace: CoderWorkspaceProfile;
  readonly localPath: string;
  readonly extension: CoderClipboardImageExtension;
  readonly invocationOptions?: CoderInvocationOptions;
  readonly platform?: NodeJS.Platform;
  readonly scpExecutable?: string;
}): Effect.Effect<string, CoderProcessError> {
  return Effect.gen(function* () {
    const imageId = randomUUID();
    const filename = `${imageId}.${input.extension}`;
    const remotePath = `.t3-coder/attachments/${filename}.tmp`;
    const finalRemotePath = `.t3-coder/attachments/${filename}`;
    const upload = Effect.gen(function* () {
      yield* copyWithCoderScp({
        deployment: input.deployment,
        workspace: input.workspace,
        localPath: input.localPath,
        remotePath,
        ...(input.invocationOptions ? { invocationOptions: input.invocationOptions } : {}),
        ...(input.platform ? { platform: input.platform } : {}),
        ...(input.scpExecutable ? { scpExecutable: input.scpExecutable } : {}),
      });
      const command = [
        "set -eu",
        `temporary="$HOME/${remotePath}"`,
        `final="$HOME/.t3-coder/attachments/${filename}"`,
        '[ -f "$temporary" ]',
        'chmod 600 "$temporary"',
        'mv "$temporary" "$final"',
        `printf '${IMAGE_PATH_SENTINEL}%s\\n' "$final"`,
      ].join("; ");
      const stdout = yield* runProcess(
        buildCoderWorkspaceShellInvocation(
          input.deployment,
          input.workspace,
          command,
          input.invocationOptions,
        ),
        "Coder image finalization",
        DEFAULT_COMMAND_TIMEOUT_MS,
      );
      const pathLine = stdout.split(/\r?\n/u).find((line) => line.startsWith(IMAGE_PATH_SENTINEL));
      const workspacePath = pathLine?.slice(IMAGE_PATH_SENTINEL.length).trim();
      if (!workspacePath?.startsWith("/")) {
        return yield* Effect.fail(
          new CoderProcessError("Coder image finalization did not return a workspace path."),
        );
      }
      return workspacePath;
    });
    return yield* upload.pipe(
      Effect.onError(() =>
        Effect.gen(function* () {
          yield* cleanupRemoteTransfer(
            input.deployment,
            input.workspace,
            remotePath,
            input.invocationOptions,
          );
          yield* cleanupRemoteTransfer(
            input.deployment,
            input.workspace,
            finalRemotePath,
            input.invocationOptions,
          );
        }),
      ),
    );
  });
}
