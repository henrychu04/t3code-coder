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
  readonly env?: Readonly<Record<string, string>>;
}

const CODER_GLOBAL_ARGS = ["--no-version-warning"] as const;

export interface CoderInvocationOptions {
  readonly globalConfig?: string;
}

export const REMOTE_NODE_COMMAND = '"$HOME/.t3-coder/node24/bin/node"';
export const REMOTE_HELPER_COMMAND = '"$HOME/.t3-coder/bin/workspace-helper/index.mjs"';
export const REMOTE_HELPER_READY_SENTINEL = "T3_CODER_HELPER_READY";
export const REMOTE_WORKSPACE_STATS_COMMAND = [
  "set -eu",
  'cpu="$(coder --no-version-warning stat cpu --output=json)"',
  'memory="$(coder --no-version-warning stat mem --output=json)"',
  'disk="$(coder --no-version-warning stat disk --path "$HOME" --output=json)"',
  `printf '{"cpu":%s,"memory":%s,"disk":%s}\\n' "$cpu" "$memory" "$disk"`,
].join("; ");
const REMOTE_NODE_VERSION_CHECK = `${REMOTE_NODE_COMMAND} -e 'const major = Number(process.versions.node.split(".")[0]); process.exit(major >= 24 ? 0 : 1)'`;
/** A preflight failure line: the helper launch prints it and exits before the ready sentinel. */
export const REMOTE_PREFLIGHT_FAILED_PREFIX = "T3_CODER_PREFLIGHT_FAILED: ";
/** The installed helper bundle does not match the gateway's; install it and relaunch. */
export const REMOTE_HELPER_INSTALL_REQUIRED_SENTINEL = "T3_CODER_HELPER_INSTALL_REQUIRED";
/** Written into the installed helper directory; holds the bundle's SHA-256. */
export const REMOTE_HELPER_BUNDLE_HASH_FILE = ".t3-bundle-sha256";
const HELPER_BUNDLE_HASH_PATTERN = /^[a-f0-9]{64}$/;
// Coder 2.25's remote PTY merges stderr into stdout, so failures are reported on stdout.
export const REMOTE_WORKSPACE_PREFLIGHT_COMMAND = [
  "set -eu",
  `fail() { printf "${REMOTE_PREFLIGHT_FAILED_PREFIX}%s\\n" "$1"; exit 1; }`,
  '[ "$(uname -s)" = "Linux" ] || fail "T3 Coder requires a Linux workspace."',
  '[ "$(uname -m)" = "x86_64" ] || fail "T3 Coder requires an x86-64 workspace."',
  '[ -n "${HOME:-}" ] || fail "T3 Coder requires a workspace HOME directory."',
  '[ -d "$HOME" ] && [ -r "$HOME" ] && [ -x "$HOME" ] || fail "The workspace HOME directory is not accessible."',
  'mkdir -p "$HOME/.t3-coder/bin" "$HOME/.t3-coder/attachments" || fail "T3 Coder cannot create its workspace state directories."',
  'chmod 700 "$HOME/.t3-coder" "$HOME/.t3-coder/bin" "$HOME/.t3-coder/attachments" || fail "T3 Coder cannot secure its workspace state directories."',
  '[ -w "$HOME/.t3-coder/bin" ] && [ -w "$HOME/.t3-coder/attachments" ] || fail "T3 Coder workspace state directories are not writable."',
  `if ! [ -x ${REMOTE_NODE_COMMAND} ] || ! ${REMOTE_NODE_VERSION_CHECK}; then command -v nix-env >/dev/null 2>&1 || fail "T3 Coder requires nix-env to provision Node.js 24."; nix-env --profile "$HOME/.t3-coder/node24" -iA nixpkgs.nodejs_24 >/dev/null 2>&1 || fail "T3 Coder could not provision Node.js 24 from the workspace's configured nixpkgs."; fi`,
  `[ -x ${REMOTE_NODE_COMMAND} ] || fail "T3 Coder's Nix-provisioned Node.js runtime is not executable."`,
  `${REMOTE_NODE_VERSION_CHECK} || fail "T3 Coder requires Node.js 24 or newer from its Nix runtime."`,
  'command -v git >/dev/null 2>&1 || fail "T3 Coder requires Git."',
  // The helper install streams a tar archive over `coder ssh` stdin and verifies it remotely.
  'command -v tar >/dev/null 2>&1 || fail "T3 Coder requires tar to install its workspace helper."',
  'command -v sha256sum >/dev/null 2>&1 || fail "T3 Coder requires sha256sum to verify its workspace helper."',
  'command -v head >/dev/null 2>&1 || fail "T3 Coder requires head to receive transfers."',
  'command -v claude >/dev/null 2>&1 || command -v codex >/dev/null 2>&1 || command -v pi >/dev/null 2>&1 || fail "T3 Coder requires Claude Code, Codex, or Pi in the workspace PATH."',
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
      "-l",
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

/** Exits with code 3 after the install sentinel unless the installed helper has `hash`. */
export function remoteHelperBundleCheck(hash: string): string {
  if (!HELPER_BUNDLE_HASH_PATTERN.test(hash)) {
    throw new Error("Coder helper bundle hash must be a SHA-256 hex digest.");
  }
  return `[ "$(cat "$HOME/.t3-coder/bin/workspace-helper/${REMOTE_HELPER_BUNDLE_HASH_FILE}" 2>/dev/null || true)" = "${hash}" ] || { printf '${REMOTE_HELPER_INSTALL_REQUIRED_SENTINEL}\\n'; exit 3; }`;
}

export interface CoderHelperInvocationOptions extends CoderInvocationOptions {
  /** When set, a workspace whose installed helper has another hash asks for an install. */
  readonly expectedBundleHash?: string;
}

/**
 * The foreground helper launch. It runs the workspace preflight, then, when a bundle hash is
 * expected, checks the installed helper, so a connection to a current workspace needs one
 * `coder ssh` session and no transfer.
 */
export function buildCoderHelperInvocation(
  deploymentInput: CoderDeploymentProfile,
  workspaceInput: CoderWorkspaceProfile,
  options?: CoderHelperInvocationOptions,
): CoderInvocation {
  const deployment = normalizeCoderDeploymentProfile(deploymentInput);
  const workspace = normalizeCoderWorkspaceProfile(workspaceInput);
  if (workspace.deploymentId !== deployment.id) {
    throw new Error("Coder workspace does not belong to the selected deployment.");
  }
  const expectedBundleHash = options?.expectedBundleHash;
  const helperCommand = [
    REMOTE_WORKSPACE_PREFLIGHT_COMMAND,
    ...(expectedBundleHash === undefined ? [] : [remoteHelperBundleCheck(expectedBundleHash)]),
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
      "-l",
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
