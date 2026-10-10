// Resolves an upstream merge's modify/delete conflicts for surfaces T3 Coder does not carry.
//
// Run after `git merge <upstream sha>` stops with conflicts (see docs/internals/sync.md). A
// conflict is resolved with `git rm` only when the fork deleted the file, upstream modified it,
// and the path falls under DELETED_PATHS. Content conflicts and every other path are listed for a
// human to decide. Upstream files added under DELETED_PATHS are listed too, never removed.
import { execFileSync } from "node:child_process";

// A trailing `/` names a directory. Any other entry names one file and its siblings that share
// the stem (`project/http.ts` also covers `project/http.test.ts`). Derived from
// `git diff --name-status <merge-base> origin/coder-only | grep ^D`.
const DELETED_PATHS = {
  // Auth and pairing: Coder owns authentication; no sessions, pairing, OAuth, DPoP, or scopes.
  // The server's auth/ keeps only ServerSecretStore, which a modify/delete cannot name.
  "auth and pairing": [
    "apps/server/src/auth/",
    "apps/server/src/persistence/AuthPairingLinks.ts",
    "apps/server/src/persistence/AuthSessions.ts",
    "apps/server/src/startupAccess.ts",
    "apps/web/src/components/auth/",
    "apps/web/src/hostedPairing.ts",
    "apps/web/src/pairingUrl.ts",
    "apps/web/src/routes/connect-agent.tsx",
    "apps/web/src/routes/connect.tsx",
    "apps/web/src/routes/pair.tsx",
    "apps/web/src/state/auth.ts",
    "packages/client-runtime/src/authorization/",
    "packages/client-runtime/src/state/auth.ts",
    "packages/shared/src/authScopeOptions.ts",
    "packages/shared/src/connectAuth.ts",
    "packages/shared/src/dpop.ts",
    "packages/shared/src/dpopCommon.ts",
    "packages/shared/src/oauthScope.ts",
  ],
  // Preview and browser: no in-app browser, preview panel, or headless browser automation.
  // web's browser/ keeps only useOpenLink.ts and components/preview/ only the panel shell.
  "preview and browser": [
    "apps/server/src/mcp/PreviewAutomationBroker.ts",
    "apps/server/src/mcp/toolkits/preview/",
    "apps/server/src/mcp/toolkits/previewControls/",
    "apps/server/src/preview/",
    "apps/web/src/browser/",
    "apps/web/src/components/preview/",
    "apps/web/src/previewMiniPlayerStore.ts",
    "apps/web/src/previewStateStore.ts",
    "apps/web/src/state/preview.ts",
    "apps/web/src/state/previewStream.ts",
    "packages/client-runtime/src/preview/",
    "packages/client-runtime/src/state/preview.ts",
    "packages/shared/src/preview.ts",
    "packages/shared/src/previewViewport.ts",
  ],
  // Device: no device hosts, device hub, or agent device shim.
  device: [
    "apps/server/src/device/",
    "apps/server/src/mcp/toolkits/device/",
    "apps/web/src/components/device/",
    "apps/web/src/state/device.ts",
    "packages/client-runtime/src/device/",
    "packages/client-runtime/src/state/device.ts",
  ],
  // HTTP routes and assets: the helper serves stdio RPC only; no HTTP server, routes, or signed
  // asset URLs.
  "HTTP routes and assets": [
    "apps/server/src/assets/",
    "apps/server/src/http.ts",
    "apps/server/src/httpCors.ts",
    "apps/server/src/mcp/McpHttpServer.ts",
    "apps/server/src/orchestration-v2/http.ts",
    "apps/server/src/project/http.ts",
    "apps/server/src/pullRequest/http.ts",
    "apps/server/src/scheduledTasks/webhookRoute.ts",
    "packages/client-runtime/src/rpc/http.ts",
    "packages/contracts/src/environmentHttp.ts",
  ],
  // Hosted source-control providers: GitLab is the only one carried.
  "Forgejo, GitHub, Azure DevOps, Bitbucket, and GitCafe packages": [
    "packages/source-control-azure-devops/",
    "packages/source-control-bitbucket/",
    "packages/source-control-forgejo/",
    "packages/source-control-gitcafe/",
    "packages/source-control-github/",
  ],
  // Other provider packages: Codex, Claude Code, and Pi are the only providers.
  "other provider packages": [
    "apps/server/src/provider/acp/",
    "packages/effect-acp/",
    "packages/provider-acp/",
    "packages/provider-acp-registry/",
    "packages/provider-cursor/",
    "packages/provider-grok/",
    "packages/provider-muse/",
    "packages/provider-opencode/",
  ],
  // Desktop: no Electron app, local primary environment, desktop updates, OS permission
  // checklist, native helpers, or packaging.
  desktop: [
    "apps/desktop/",
    "apps/server/src/desktopUpdate/",
    "apps/web/src/components/desktop/",
    "apps/web/src/components/permissions/",
    "apps/web/src/environments/",
    "assets/",
    "native/",
    "packaging/",
  ],
  // Mobile: no mobile app.
  mobile: ["apps/mobile/"],
  // Hosted web: no hosted app, cloud accounts, marketing site, or welcome onboarding.
  "hosted web": [
    "apps/marketing/",
    "apps/server/src/cloud/",
    "apps/web/src/cloud/",
    "apps/web/src/components/clerk/",
    "apps/web/src/components/cloud/",
    "apps/web/src/components/onboarding/",
  ],
  // Server CLI: the helper starts over `coder ssh`, never as upstream's `t3` command.
  "server CLI": ["apps/server/src/cli/"],
  // Relay: no relay, Tailscale, or SSH transport.
  relay: [
    "apps/server/src/relay/",
    "apps/web/src/state/relay.ts",
    "infra/",
    "packages/client-runtime/src/relay/",
    "packages/ssh/",
    "packages/tailscale/",
  ],
  // Telemetry: no T3-owned telemetry, usage dashboards, diagnostics, or trace export.
  telemetry: [
    "apps/server/src/diagnostics/",
    "apps/server/src/resourceTelemetry/",
    "apps/server/src/telemetry/",
    "apps/server/src/usage/",
    "apps/web/src/components/usage/",
    "apps/web/src/observability/",
    "apps/web/src/state/usage.ts",
    "packages/client-runtime/src/state/usage.ts",
    "packages/contracts/src/resourceTelemetry.ts",
    "packages/contracts/src/usage.ts",
  ],
  // Upstream repository tooling: vendored sources, CI, hooks, editor and agent configuration,
  // and operations docs. The fork's .github/ keeps only SECURITY.md.
  "upstream repository tooling": [
    ".agents/",
    ".claude/",
    ".cursor/",
    ".devcontainer/",
    ".github/",
    ".macroscope/",
    ".repos/",
    ".vite-hooks/",
    ".vscode/",
    "docs/operations/",
    "oxlint-plugin-t3code/",
  ],
};

const git = (...args) => execFileSync("git", args, { encoding: "utf8", shell: false });

const stem = (file) => file.slice(0, file.lastIndexOf("."));
const categoryOf = (path) => {
  for (const [category, entries] of Object.entries(DELETED_PATHS)) {
    for (const entry of entries) {
      if (entry.endsWith("/") ? path.startsWith(entry) : path.startsWith(`${stem(entry)}.`)) {
        return category;
      }
    }
  }
  return undefined;
};

// `git ls-files -u` lists one line per stage: `<mode> <sha> <stage>\t<path>`.
const stagesByPath = new Map();
for (const line of git("ls-files", "-u", "-z").split("\0").filter(Boolean)) {
  const [info, path] = line.split("\t");
  const stage = info.split(" ")[2];
  stagesByPath.set(path, (stagesByPath.get(path) ?? "") + stage);
}
if (stagesByPath.size === 0) {
  console.log("No unmerged paths.");
}

const resolved = [];
const left = [];
for (const [path, stages] of [...stagesByPath].sort(([a], [b]) => a.localeCompare(b))) {
  // Stage 1 is the merge base, 2 is ours (coder-only), 3 is theirs (upstream). Without stage 2
  // the fork deleted the file; with 1 and 3 upstream modified it.
  const deletedByUsModifiedByThem = stages === "13";
  const category = categoryOf(path);
  if (deletedByUsModifiedByThem && category) {
    resolved.push({ path, category });
  } else {
    const kind = deletedByUsModifiedByThem
      ? "deleted by fork, modified upstream; not under a deleted path"
      : stages === "12"
        ? "modified by fork, deleted upstream"
        : stages.includes("2") && stages.includes("3")
          ? "content conflict"
          : `stages ${stages}`;
    left.push(`${path}  (${kind})`);
  }
}

if (resolved.length > 0) {
  git("rm", "--quiet", "--", ...resolved.map(({ path }) => path));
  console.log(`Kept deleted (${resolved.length}):`);
  for (const { path, category } of resolved) console.log(`  ${path}  [${category}]`);
}
if (left.length > 0) {
  console.log(`\nLeft for a human (${left.length}):`);
  for (const line of left) console.log(`  ${line}`);
}

const added = git("diff", "--cached", "--no-renames", "--name-only", "--diff-filter=A", "HEAD", "-z")
  .split("\0")
  .filter((path) => path && categoryOf(path));
if (added.length > 0) {
  console.log(`\nAdded by upstream under deleted paths, not touched (${added.length}):`);
  for (const path of added) console.log(`  ${path}  [${categoryOf(path)}]`);
}
