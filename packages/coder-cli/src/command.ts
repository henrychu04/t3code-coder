import {
  normalizeCoderDeploymentProfile,
  normalizeCoderPortForwardProfile,
  normalizeCoderWorkspaceProfile,
  type CoderDeploymentProfile,
  type CoderPortForwardProfile,
  type CoderWorkspaceProfile,
} from "./profile.ts";

export interface CoderInvocation {
  readonly executable: string;
  readonly args: readonly string[];
}

const CODER_GLOBAL_ARGS = ["--no-version-warning"] as const;

export interface CoderInvocationOptions {
  readonly globalConfig?: string;
}

export const REMOTE_NODE_COMMAND = '"$HOME/.t3-coder/node24/bin/node"';
export const REMOTE_HELPER_COMMAND = '"$HOME/.t3-coder/bin/workspace-helper"';
export const REMOTE_HELPER_READY_SENTINEL = "T3_CODER_HELPER_READY";
export const REMOTE_WORKSPACE_STATS_COMMAND = [
  "set -eu",
  'cpu="$(coder stat cpu --output=json)"',
  'memory="$(coder stat mem --output=json)"',
  'disk="$(coder stat disk --path "$HOME" --output=json)"',
  `printf '{"cpu":%s,"memory":%s,"disk":%s}\\n' "$cpu" "$memory" "$disk"`,
].join("; ");
const REMOTE_NODE_VERSION_CHECK = `${REMOTE_NODE_COMMAND} -e 'const major = Number(process.versions.node.split(".")[0]); process.exit(major >= 24 ? 0 : 1)'`;
export const REMOTE_WORKSPACE_PROBE_COMMAND = [
  "set -eu",
  'fail() { printf "%s\\n" "$1" >&2; exit 1; }',
  '[ "$(uname -s)" = "Linux" ] || fail "T3 Coder requires a Linux workspace."',
  '[ "$(uname -m)" = "x86_64" ] || fail "T3 Coder requires an x86-64 workspace."',
  '[ -n "${HOME:-}" ] || fail "T3 Coder requires a workspace HOME directory."',
  '[ -d "$HOME" ] && [ -r "$HOME" ] && [ -x "$HOME" ] || fail "The workspace HOME directory is not accessible."',
  'mkdir -p "$HOME/.t3-coder/bin" "$HOME/.t3-coder/attachments" || fail "T3 Coder cannot create its workspace state directories."',
  'chmod 700 "$HOME/.t3-coder" "$HOME/.t3-coder/bin" "$HOME/.t3-coder/attachments" || fail "T3 Coder cannot secure its workspace state directories."',
  '[ -w "$HOME/.t3-coder/bin" ] && [ -w "$HOME/.t3-coder/attachments" ] || fail "T3 Coder workspace state directories are not writable."',
  `if ! [ -x ${REMOTE_NODE_COMMAND} ] || ! ${REMOTE_NODE_VERSION_CHECK}; then command -v nix-env >/dev/null 2>&1 || fail "T3 Coder requires nix-env to provision Node.js 24."; nix-env --profile "$HOME/.t3-coder/node24" -iA nixpkgs.nodejs_24 || fail "T3 Coder could not provision Node.js 24 from the workspace's configured nixpkgs."; fi`,
  `[ -x ${REMOTE_NODE_COMMAND} ] || fail "T3 Coder's Nix-provisioned Node.js runtime is not executable."`,
  `${REMOTE_NODE_VERSION_CHECK} || fail "T3 Coder requires Node.js 24 or newer from its Nix runtime."`,
  'command -v git >/dev/null 2>&1 || fail "T3 Coder requires Git."',
  'command -v claude >/dev/null 2>&1 || fail "T3 Coder requires Claude Code in the workspace PATH."',
  'command -v script >/dev/null 2>&1 || fail "T3 Coder requires util-linux script(1)."',
  'script -qefc true /dev/null >/dev/null 2>&1 || fail "T3 Coder requires util-linux script(1) with -qefc support."',
  'printf "T3_CODER_PREFLIGHT_OK\\n"',
].join("; ");
export function quotePosixShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function invocation(
  deploymentInput: CoderDeploymentProfile,
  args: readonly string[],
  options?: CoderInvocationOptions,
): CoderInvocation {
  const deployment = normalizeCoderDeploymentProfile(deploymentInput);
  const globalConfig = options?.globalConfig?.trim();
  if (options?.globalConfig !== undefined && !globalConfig) {
    throw new Error("Coder global config path must not be empty.");
  }
  return {
    executable: deployment.executable ?? "coder",
    args: [...(globalConfig ? ["--global-config", globalConfig] : []), ...args],
  };
}

export function buildCoderLoginInvocation(
  deploymentInput: CoderDeploymentProfile,
  options?: CoderInvocationOptions,
): CoderInvocation {
  const deployment = normalizeCoderDeploymentProfile(deploymentInput);
  return invocation(
    deployment,
    [...CODER_GLOBAL_ARGS, "--no-open", "login", deployment.url],
    options,
  );
}

export function buildCoderAuthStatusInvocation(
  deploymentInput: CoderDeploymentProfile,
  options?: CoderInvocationOptions,
): CoderInvocation {
  const deployment = normalizeCoderDeploymentProfile(deploymentInput);
  return invocation(
    deployment,
    [...CODER_GLOBAL_ARGS, "--verbose", "--url", deployment.url, "whoami"],
    options,
  );
}

export function buildCoderListWorkspacesInvocation(
  deploymentInput: CoderDeploymentProfile,
  options?: CoderInvocationOptions,
): CoderInvocation {
  const deployment = normalizeCoderDeploymentProfile(deploymentInput);
  return invocation(
    deployment,
    [...CODER_GLOBAL_ARGS, "--url", deployment.url, "list", "--output", "json"],
    options,
  );
}

export function buildCoderPingWorkspaceInvocation(
  deploymentInput: CoderDeploymentProfile,
  workspaceInput: CoderWorkspaceProfile,
  options?: CoderInvocationOptions,
): CoderInvocation {
  const deployment = normalizeCoderDeploymentProfile(deploymentInput);
  const workspace = normalizeCoderWorkspaceProfile(workspaceInput);
  if (workspace.deploymentId !== deployment.id) {
    throw new Error("Coder workspace does not belong to the selected deployment.");
  }
  return invocation(
    deployment,
    [...CODER_GLOBAL_ARGS, "--url", deployment.url, "ping", workspace.workspace],
    options,
  );
}

export function buildCoderWorkspaceProbeInvocation(
  deploymentInput: CoderDeploymentProfile,
  workspaceInput: CoderWorkspaceProfile,
  options?: CoderInvocationOptions,
): CoderInvocation {
  const deployment = normalizeCoderDeploymentProfile(deploymentInput);
  const workspace = normalizeCoderWorkspaceProfile(workspaceInput);
  if (workspace.deploymentId !== deployment.id) {
    throw new Error("Coder workspace does not belong to the selected deployment.");
  }
  return invocation(
    deployment,
    [
      ...CODER_GLOBAL_ARGS,
      "--url",
      deployment.url,
      "ssh",
      workspace.workspace,
      "--",
      "sh",
      "-c",
      quotePosixShellArgument(REMOTE_WORKSPACE_PROBE_COMMAND),
    ],
    options,
  );
}

function buildCoderWorkspaceActionInvocation(
  deploymentInput: CoderDeploymentProfile,
  workspaceInput: CoderWorkspaceProfile,
  actionArgs: readonly string[],
  options?: CoderInvocationOptions,
): CoderInvocation {
  const deployment = normalizeCoderDeploymentProfile(deploymentInput);
  const workspace = normalizeCoderWorkspaceProfile(workspaceInput);
  if (workspace.deploymentId !== deployment.id) {
    throw new Error("Coder workspace does not belong to the selected deployment.");
  }
  return invocation(
    deployment,
    [...CODER_GLOBAL_ARGS, "--url", deployment.url, ...actionArgs, workspace.workspace],
    options,
  );
}

export function buildCoderStartWorkspaceInvocation(
  deploymentInput: CoderDeploymentProfile,
  workspaceInput: CoderWorkspaceProfile,
  options?: CoderInvocationOptions,
): CoderInvocation {
  return buildCoderWorkspaceActionInvocation(
    deploymentInput,
    workspaceInput,
    ["start", "--yes"],
    options,
  );
}

export function buildCoderStopWorkspaceInvocation(
  deploymentInput: CoderDeploymentProfile,
  workspaceInput: CoderWorkspaceProfile,
  options?: CoderInvocationOptions,
): CoderInvocation {
  return buildCoderWorkspaceActionInvocation(
    deploymentInput,
    workspaceInput,
    ["stop", "--yes"],
    options,
  );
}

export function buildCoderRestartWorkspaceInvocation(
  deploymentInput: CoderDeploymentProfile,
  workspaceInput: CoderWorkspaceProfile,
  options?: CoderInvocationOptions,
): CoderInvocation {
  return buildCoderWorkspaceActionInvocation(
    deploymentInput,
    workspaceInput,
    ["restart", "--yes"],
    options,
  );
}

export function buildCoderUpdateWorkspaceInvocation(
  deploymentInput: CoderDeploymentProfile,
  workspaceInput: CoderWorkspaceProfile,
  options?: CoderInvocationOptions,
): CoderInvocation {
  return buildCoderWorkspaceActionInvocation(deploymentInput, workspaceInput, ["update"], options);
}

export function buildCoderWorkspaceShellInvocation(
  deploymentInput: CoderDeploymentProfile,
  workspaceInput: CoderWorkspaceProfile,
  shellCommand: string,
  options?: CoderInvocationOptions,
): CoderInvocation {
  const deployment = normalizeCoderDeploymentProfile(deploymentInput);
  const workspace = normalizeCoderWorkspaceProfile(workspaceInput);
  if (workspace.deploymentId !== deployment.id) {
    throw new Error("Coder workspace does not belong to the selected deployment.");
  }
  if (shellCommand.length === 0 || /\0/.test(shellCommand)) {
    throw new Error("Coder workspace shell command must not be empty or contain NUL bytes.");
  }
  return invocation(
    deployment,
    [
      ...CODER_GLOBAL_ARGS,
      "--url",
      deployment.url,
      "ssh",
      workspace.workspace,
      "--",
      "sh",
      "-c",
      quotePosixShellArgument(shellCommand),
    ],
    options,
  );
}

export function buildCoderWorkspaceStatsInvocation(
  deploymentInput: CoderDeploymentProfile,
  workspaceInput: CoderWorkspaceProfile,
  options?: CoderInvocationOptions,
): CoderInvocation {
  return buildCoderWorkspaceShellInvocation(
    deploymentInput,
    workspaceInput,
    REMOTE_WORKSPACE_STATS_COMMAND,
    options,
  );
}

export function buildCoderPortForwardInvocation(
  deploymentInput: CoderDeploymentProfile,
  workspaceInput: CoderWorkspaceProfile,
  portForwardInput: CoderPortForwardProfile,
  options?: CoderInvocationOptions,
): CoderInvocation {
  const deployment = normalizeCoderDeploymentProfile(deploymentInput);
  const workspace = normalizeCoderWorkspaceProfile(workspaceInput);
  const portForward = normalizeCoderPortForwardProfile(portForwardInput);
  if (workspace.deploymentId !== deployment.id) {
    throw new Error("Coder workspace does not belong to the selected deployment.");
  }
  if (portForward.workspaceId !== workspace.id) {
    throw new Error("Coder port forward does not belong to the selected workspace.");
  }
  return invocation(
    deployment,
    [
      ...CODER_GLOBAL_ARGS,
      "--url",
      deployment.url,
      "port-forward",
      workspace.workspace,
      `--${portForward.protocol}`,
      `127.0.0.1:${portForward.localPort}:${portForward.remotePort}`,
    ],
    options,
  );
}

export function buildCoderScpConfigInvocation(
  deploymentInput: CoderDeploymentProfile,
  sshConfigPath: string,
  hostPrefix: string,
  options?: CoderInvocationOptions,
): CoderInvocation {
  const deployment = normalizeCoderDeploymentProfile(deploymentInput);
  if (sshConfigPath.trim().length === 0 || /\r|\n|\0/.test(sshConfigPath)) {
    throw new Error("Temporary SSH config path must be a non-empty single line.");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*-$/.test(hostPrefix)) {
    throw new Error("Temporary SSH host prefix contains unsupported characters.");
  }
  return invocation(
    deployment,
    [
      ...CODER_GLOBAL_ARGS,
      "--url",
      deployment.url,
      "config-ssh",
      "--yes",
      "--wait=no",
      "--ssh-config-file",
      sshConfigPath,
      "--ssh-host-prefix",
      hostPrefix,
    ],
    options,
  );
}

export function buildCoderHelperInvocation(
  deploymentInput: CoderDeploymentProfile,
  workspaceInput: CoderWorkspaceProfile,
  options?: CoderInvocationOptions,
): CoderInvocation {
  const deployment = normalizeCoderDeploymentProfile(deploymentInput);
  const workspace = normalizeCoderWorkspaceProfile(workspaceInput);
  if (workspace.deploymentId !== deployment.id) {
    throw new Error("Coder workspace does not belong to the selected deployment.");
  }
  const helperCommand = [
    "set -eu",
    "stty raw -echo 2>/dev/null || true",
    `printf '${REMOTE_HELPER_READY_SENTINEL}\\n'`,
    [
      "exec env",
      quotePosixShellArgument(`T3_CODER_WORKSPACE_LABEL=${deployment.name} · ${workspace.name}`),
      REMOTE_NODE_COMMAND,
      REMOTE_HELPER_COMMAND,
      "--stdio",
      // Coder 2.25 always allocates a remote PTY, which merges the helper's stderr
      // into its stdout and would corrupt the NDJSON transport with Node warnings.
      "2>/dev/null",
    ].join(" "),
  ].join("; ");
  return invocation(
    deployment,
    [
      ...CODER_GLOBAL_ARGS,
      "--url",
      deployment.url,
      "ssh",
      workspace.workspace,
      "--",
      "sh",
      "-c",
      quotePosixShellArgument(helperCommand),
    ],
    options,
  );
}

export function buildBrowserOpenInvocation(
  platform: NodeJS.Platform,
  localUrl: string,
): CoderInvocation {
  const url = new URL(localUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error("T3 Coder browser URL must use loopback HTTP.");
  }

  switch (platform) {
    case "darwin":
      return { executable: "open", args: [url.href] };
    case "win32":
      return { executable: "explorer.exe", args: [url.href] };
    default:
      return { executable: "xdg-open", args: [url.href] };
  }
}
