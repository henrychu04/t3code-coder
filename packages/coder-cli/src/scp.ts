// @effect-diagnostics nodeBuiltinImport:off
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimers from "node:timers";

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
  "--disable-network-telemetry",
  "--disable-direct-connections",
  "--no-version-warning",
] as const;
const IMAGE_PATH_SENTINEL = "T3_CODER_IMAGE_PATH=";

export type CoderClipboardImageExtension = "jpg" | "png" | "webp";

function appendOutput(current: Buffer, chunk: Buffer): Buffer {
  if (current.byteLength >= MAX_PROCESS_OUTPUT_BYTES) return current;
  return Buffer.concat([current, chunk.subarray(0, MAX_PROCESS_OUTPUT_BYTES - current.byteLength)]);
}

export function runProcess(
  invocation: CoderInvocation,
  label: string,
  timeoutMs: number,
  terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, invocation.args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout: Buffer = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;
    let forceKillTimeout: NodeJS.Timeout | undefined;
    const timeout = NodeTimers.setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimeout = NodeTimers.setTimeout(() => {
        if (!settled && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, terminationGraceMs);
    }, timeoutMs);
    const clearTimers = () => {
      NodeTimers.clearTimeout(timeout);
      if (forceKillTimeout !== undefined) NodeTimers.clearTimeout(forceKillTimeout);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendOutput(stdout, chunk);
    });
    // Drain stderr without retaining local paths or transfer details.
    child.stderr.resume();
    child.once("error", (cause) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(
        timedOut
          ? new Error(`${label} timed out.`)
          : new Error(`${label} could not start.`, { cause }),
      );
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (timedOut) {
        reject(new Error(`${label} timed out.`));
        return;
      }
      if (code === 0) {
        resolve(stdout.toString("utf8"));
        return;
      }
      reject(new Error(`${label} failed (code ${String(code)}, signal ${String(signal)}).`));
    });
  });
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

async function withCoderScpConfig<T>(input: {
  readonly deployment: CoderDeploymentProfile;
  readonly workspace: CoderWorkspaceProfile;
  readonly invocationOptions?: CoderInvocationOptions;
  readonly action: (config: { readonly path: string; readonly host: string }) => Promise<T>;
}): Promise<T> {
  const workspace = normalizeCoderWorkspaceProfile(input.workspace);
  const workspaceName = workspace.workspace.split("/").at(-1);
  if (!workspaceName) throw new Error("Coder workspace name is unavailable.");
  const transferId = randomUUID();
  const hostPrefix = `t3-coder-${transferId}-`;
  const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-coder-scp-"));
  const configPath = NodePath.join(directory, "ssh-config");
  try {
    await runProcess(
      buildCoderScpConfigInvocation(
        input.deployment,
        configPath,
        hostPrefix,
        input.invocationOptions,
      ),
      "Coder SSH configuration",
      DEFAULT_COMMAND_TIMEOUT_MS,
    );
    const generatedConfig = await NodeFS.readFile(configPath, "utf8");
    await NodeFS.writeFile(configPath, scopeCoderScpConfig(generatedConfig, hostPrefix), {
      mode: 0o600,
    });
    return await input.action({ path: configPath, host: `${hostPrefix}${workspaceName}` });
  } finally {
    await NodeFS.rm(directory, { recursive: true, force: true });
  }
}

async function copyWithCoderScp(input: {
  readonly deployment: CoderDeploymentProfile;
  readonly workspace: CoderWorkspaceProfile;
  readonly invocationOptions?: CoderInvocationOptions;
  readonly localPath: string;
  readonly remotePath: string;
  readonly platform?: NodeJS.Platform;
  readonly scpExecutable?: string;
}): Promise<void> {
  await withCoderScpConfig({
    deployment: input.deployment,
    workspace: input.workspace,
    ...(input.invocationOptions ? { invocationOptions: input.invocationOptions } : {}),
    action: async ({ path, host }) => {
      await runProcess(
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
      );
    },
  });
}

async function cleanupRemoteTransfer(
  deployment: CoderDeploymentProfile,
  workspace: CoderWorkspaceProfile,
  remotePath: string,
  invocationOptions?: CoderInvocationOptions,
): Promise<void> {
  const command = `rm -f "$HOME/${remotePath}"`;
  try {
    await runProcess(
      buildCoderWorkspaceShellInvocation(deployment, workspace, command, invocationOptions),
      "Coder transfer cleanup",
      DEFAULT_COMMAND_TIMEOUT_MS,
    );
  } catch {
    // Cleanup is best-effort after the authoritative transfer failure.
  }
}

export async function installCoderHelperWithScp(input: {
  readonly deployment: CoderDeploymentProfile;
  readonly workspace: CoderWorkspaceProfile;
  readonly helperBundlePath: string;
  readonly invocationOptions?: CoderInvocationOptions;
  readonly platform?: NodeJS.Platform;
  readonly scpExecutable?: string;
}): Promise<void> {
  const remotePath = `.t3-coder/bin/workspace-helper.tmp.${randomUUID()}`;
  try {
    await copyWithCoderScp({
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
    await runProcess(
      buildCoderWorkspaceShellInvocation(
        input.deployment,
        input.workspace,
        command,
        input.invocationOptions,
      ),
      "Coder helper finalization",
      DEFAULT_COMMAND_TIMEOUT_MS,
    );
  } catch (cause) {
    await cleanupRemoteTransfer(
      input.deployment,
      input.workspace,
      remotePath,
      input.invocationOptions,
    );
    throw cause;
  }
}

export async function uploadCoderClipboardImageWithScp(input: {
  readonly deployment: CoderDeploymentProfile;
  readonly workspace: CoderWorkspaceProfile;
  readonly localPath: string;
  readonly extension: CoderClipboardImageExtension;
  readonly invocationOptions?: CoderInvocationOptions;
  readonly platform?: NodeJS.Platform;
  readonly scpExecutable?: string;
}): Promise<string> {
  const imageId = randomUUID();
  const filename = `${imageId}.${input.extension}`;
  const remotePath = `.t3-coder/attachments/${filename}.tmp`;
  const finalRemotePath = `.t3-coder/attachments/${filename}`;
  try {
    await copyWithCoderScp({
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
    const stdout = await runProcess(
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
      throw new Error("Coder image finalization did not return a workspace path.");
    }
    return workspacePath;
  } catch (cause) {
    await cleanupRemoteTransfer(
      input.deployment,
      input.workspace,
      remotePath,
      input.invocationOptions,
    );
    await cleanupRemoteTransfer(
      input.deployment,
      input.workspace,
      finalRemotePath,
      input.invocationOptions,
    );
    throw cause;
  }
}
