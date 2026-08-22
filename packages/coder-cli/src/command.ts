import {
  normalizeCoderDeploymentProfile,
  normalizeCoderWorkspaceProfile,
  type CoderDeploymentProfile,
  type CoderWorkspaceProfile,
} from "./profile.ts";

export interface CoderInvocation {
  readonly executable: string;
  readonly args: readonly string[];
}

const CODER_GLOBAL_ARGS = [
  "--disable-network-telemetry",
  "--disable-direct-connections",
  "--no-version-warning",
] as const;

export interface CoderInvocationOptions {
  readonly globalConfig?: string;
}

export const REMOTE_NODE_COMMAND = '"$HOME/.t3-coder/node24/bin/node"';
export const REMOTE_HELPER_COMMAND = '"$HOME/.t3-coder/bin/workspace-helper"';
const REMOTE_NODE_VERSION_CHECK = `${REMOTE_NODE_COMMAND} -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 24 || (major === 24 && minor >= 10) ? 0 : 1)'`;
export const REMOTE_WORKSPACE_PROBE_COMMAND = [
  "set -eu",
  'fail() { printf "%s\\n" "$1" >&2; exit 1; }',
  '[ "$(uname -s)" = "Linux" ] || fail "T3 Coder requires a Linux workspace."',
  '[ "$(uname -m)" = "x86_64" ] || fail "T3 Coder requires an x86-64 workspace."',
  '[ -n "${HOME:-}" ] || fail "T3 Coder requires a workspace HOME directory."',
  '[ -d "$HOME" ] && [ -r "$HOME" ] && [ -x "$HOME" ] || fail "The workspace HOME directory is not accessible."',
  'mkdir -p "$HOME/.t3-coder" || fail "T3 Coder cannot create its workspace state directory."',
  '[ -w "$HOME/.t3-coder" ] || fail "T3 Coder workspace state directory is not writable."',
  `if ! [ -x ${REMOTE_NODE_COMMAND} ] || ! ${REMOTE_NODE_VERSION_CHECK}; then command -v nix-env >/dev/null 2>&1 || fail "T3 Coder requires nix-env to provision Node.js 24."; nix-env --profile "$HOME/.t3-coder/node24" -iA nixpkgs.nodejs_24 || fail "T3 Coder could not provision Node.js 24 from the workspace's configured nixpkgs."; fi`,
  `[ -x ${REMOTE_NODE_COMMAND} ] || fail "T3 Coder's Nix-provisioned Node.js runtime is not executable."`,
  `${REMOTE_NODE_VERSION_CHECK} || fail "T3 Coder requires Node.js 24.10 or newer from its Nix runtime."`,
  'command -v git >/dev/null 2>&1 || fail "T3 Coder requires Git."',
  'command -v claude >/dev/null 2>&1 || fail "T3 Coder requires Claude Code in the workspace PATH."',
  'command -v script >/dev/null 2>&1 || fail "T3 Coder requires util-linux script(1)."',
  'script -qefc true /dev/null >/dev/null 2>&1 || fail "T3 Coder requires util-linux script(1) with -qefc support."',
  'printf "T3_CODER_PREFLIGHT_OK\\n"',
].join("; ");
export const REMOTE_HELPER_INSTALL_COMMAND = [
  "set -eu",
  'install_dir="$HOME/.t3-coder/bin"',
  'mkdir -p "$install_dir"',
  'temporary="$install_dir/workspace-helper.tmp.$$"',
  "trap 'rm -f \"$temporary\"' EXIT HUP INT TERM",
  'cat > "$temporary"',
  'chmod 700 "$temporary"',
  'mv "$temporary" "$install_dir/workspace-helper"',
  "trap - EXIT HUP INT TERM",
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
  return invocation(deployment, [...CODER_GLOBAL_ARGS, "--url", deployment.url, "whoami"], options);
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
  return invocation(
    deployment,
    [
      ...CODER_GLOBAL_ARGS,
      "--url",
      deployment.url,
      "ssh",
      workspace.workspace,
      "--",
      "env",
      quotePosixShellArgument(`T3_CODER_WORKSPACE_LABEL=${deployment.name} · ${workspace.name}`),
      REMOTE_NODE_COMMAND,
      REMOTE_HELPER_COMMAND,
      "--stdio",
    ],
    options,
  );
}

export function buildCoderHelperInstallInvocation(
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
      quotePosixShellArgument(REMOTE_HELPER_INSTALL_COMMAND),
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
