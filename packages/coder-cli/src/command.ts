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

const CODER_GLOBAL_ARGS = ["--disable-network-telemetry", "--disable-direct-connections"] as const;

export const REMOTE_HELPER_COMMAND = '"$HOME/.t3-coder/bin/workspace-helper"';
export const REMOTE_WORKSPACE_PROBE_COMMAND = [
  "set -eu",
  'fail() { printf "%s\\n" "$1" >&2; exit 1; }',
  '[ "$(uname -s)" = "Linux" ] || fail "T3 Coder requires a Linux workspace."',
  '[ "$(uname -m)" = "x86_64" ] || fail "T3 Coder requires an x86-64 workspace."',
  'command -v node >/dev/null 2>&1 || fail "T3 Coder requires Node.js 24.10 or newer."',
  `node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 24 || (major === 24 && minor >= 10) ? 0 : 1)' || fail "T3 Coder requires Node.js 24.10 or newer."`,
  'command -v git >/dev/null 2>&1 || fail "T3 Coder requires Git."',
  'command -v claude >/dev/null 2>&1 || fail "T3 Coder requires Claude Code in the workspace PATH."',
  'command -v script >/dev/null 2>&1 || fail "T3 Coder requires util-linux script(1)."',
  'script -qefc true /dev/null >/dev/null 2>&1 || fail "T3 Coder requires util-linux script(1) with -qefc support."',
  '[ -n "${HOME:-}" ] || fail "T3 Coder requires a workspace HOME directory."',
  'mkdir -p "$HOME/.t3-coder" || fail "T3 Coder cannot create its workspace state directory."',
  '[ -w "$HOME/.t3-coder" ] || fail "T3 Coder workspace state directory is not writable."',
  '[ -d "$T3_CODER_CWD" ] || fail "The configured workspace project root does not exist."',
  '[ -r "$T3_CODER_CWD" ] && [ -x "$T3_CODER_CWD" ] || fail "The configured workspace project root is not accessible."',
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
): CoderInvocation {
  const deployment = normalizeCoderDeploymentProfile(deploymentInput);
  return {
    executable: deployment.executable ?? "coder",
    args,
  };
}

export function buildCoderLoginInvocation(
  deploymentInput: CoderDeploymentProfile,
): CoderInvocation {
  const deployment = normalizeCoderDeploymentProfile(deploymentInput);
  return invocation(deployment, [...CODER_GLOBAL_ARGS, "login", deployment.url]);
}

export function buildCoderListWorkspacesInvocation(
  deploymentInput: CoderDeploymentProfile,
): CoderInvocation {
  const deployment = normalizeCoderDeploymentProfile(deploymentInput);
  return invocation(deployment, [
    ...CODER_GLOBAL_ARGS,
    "--url",
    deployment.url,
    "list",
    "--output",
    "json",
  ]);
}

export function buildCoderWorkspaceProbeInvocation(
  deploymentInput: CoderDeploymentProfile,
  workspaceInput: CoderWorkspaceProfile,
): CoderInvocation {
  const deployment = normalizeCoderDeploymentProfile(deploymentInput);
  const workspace = normalizeCoderWorkspaceProfile(workspaceInput);
  if (workspace.deploymentId !== deployment.id) {
    throw new Error("Coder workspace does not belong to the selected deployment.");
  }
  return invocation(deployment, [
    ...CODER_GLOBAL_ARGS,
    "--url",
    deployment.url,
    "ssh",
    workspace.workspace,
    "--",
    "env",
    quotePosixShellArgument(`T3_CODER_CWD=${workspace.workspaceRoot}`),
    "sh",
    "-c",
    quotePosixShellArgument(REMOTE_WORKSPACE_PROBE_COMMAND),
  ]);
}

export function buildCoderHelperInvocation(
  deploymentInput: CoderDeploymentProfile,
  workspaceInput: CoderWorkspaceProfile,
): CoderInvocation {
  const deployment = normalizeCoderDeploymentProfile(deploymentInput);
  const workspace = normalizeCoderWorkspaceProfile(workspaceInput);
  if (workspace.deploymentId !== deployment.id) {
    throw new Error("Coder workspace does not belong to the selected deployment.");
  }
  return invocation(deployment, [
    ...CODER_GLOBAL_ARGS,
    "--url",
    deployment.url,
    "ssh",
    workspace.workspace,
    "--",
    "env",
    quotePosixShellArgument(`T3_CODER_CWD=${workspace.workspaceRoot}`),
    REMOTE_HELPER_COMMAND,
    "--stdio",
  ]);
}

export function buildCoderHelperInstallInvocation(
  deploymentInput: CoderDeploymentProfile,
  workspaceInput: CoderWorkspaceProfile,
): CoderInvocation {
  const deployment = normalizeCoderDeploymentProfile(deploymentInput);
  const workspace = normalizeCoderWorkspaceProfile(workspaceInput);
  if (workspace.deploymentId !== deployment.id) {
    throw new Error("Coder workspace does not belong to the selected deployment.");
  }
  return invocation(deployment, [
    ...CODER_GLOBAL_ARGS,
    "--url",
    deployment.url,
    "ssh",
    workspace.workspace,
    "--",
    "sh",
    "-c",
    quotePosixShellArgument(REMOTE_HELPER_INSTALL_COMMAND),
  ]);
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
