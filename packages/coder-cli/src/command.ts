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

const CODER_GLOBAL_ARGS = ["--disable-network-telemetry"] as const;

export const REMOTE_HELPER_COMMAND = '"$HOME/.t3-coder/bin/workspace-helper"';
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
    "uname",
    "-s",
    "-m",
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
