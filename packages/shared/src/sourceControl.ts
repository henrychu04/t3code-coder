const SCP_SSH_REMOTE_PATTERN = /^[a-zA-Z0-9._-]+@([^:/]+):/;

export function isSshRemoteUrl(remoteUrl: string): boolean {
  const trimmed = remoteUrl.trim();
  return SCP_SSH_REMOTE_PATTERN.test(trimmed) || trimmed.toLowerCase().startsWith("ssh://");
}

/**
 * Coder: hosts of the providers T3 Coder does not carry, as upstream recognised them before host
 * recognition moved into the host definitions (GitHub, Bitbucket, Azure DevOps, Forgejo, GitCafe).
 */
function isOtherProviderHost(hostname: string): boolean {
  const labels = hostname.split(".");
  return (
    hostname === "github.com" ||
    hostname.endsWith(".ghe.com") ||
    labels.includes("github") ||
    hostname === "bitbucket.org" ||
    labels.includes("bitbucket") ||
    hostname === "dev.azure.com" ||
    hostname.endsWith(".dev.azure.com") ||
    hostname.endsWith(".visualstudio.com") ||
    hostname === "codeberg.org" ||
    labels.includes("forgejo") ||
    labels.includes("gitea") ||
    hostname === "git.cafe" ||
    hostname === "staging.git.cafe"
  );
}

/** Coder: GitLab-only clone sources. Route project paths through provider lookup and full URLs directly to workspace Git. */
export function parseGitLabCloneSource(
  value: string,
): { readonly repository: string } | { readonly remoteUrl: string } | null {
  const input = value.trim();
  if (/[\s\\\u0000-\u001f\u007f]/u.test(input)) return null;
  let projectPath = input;
  let hostname: string | null = null;
  const scp = /^[a-zA-Z0-9._-]+@([a-zA-Z0-9.-]+):(.+)$/u.exec(input);
  if (scp) {
    hostname = scp[1]!.toLowerCase();
    projectPath = scp[2]!;
  } else if (input.includes("://")) {
    try {
      const url = new URL(input);
      if (!["https:", "http:", "ssh:"].includes(url.protocol)) return null;
      if (url.password || (url.protocol !== "ssh:" && url.username) || url.search || url.hash) {
        return null;
      }
      hostname = url.hostname.toLowerCase();
      projectPath = decodeURIComponent(url.pathname.replace(/^\//u, ""));
    } catch {
      return null;
    }
  }
  const segments = projectPath.replace(/\/+$/u, "").split("/");
  if (
    segments.length < 2 ||
    segments.some((segment) => !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/u.test(segment))
  ) {
    return null;
  }
  if (hostname !== null) {
    // Unrecognized hosts may be self-hosted GitLab; known other providers stay unsupported.
    if (hostname.length === 0 || isOtherProviderHost(hostname)) return null;
    return { remoteUrl: input };
  }
  return { repository: input };
}
