// Resolves an upstream merge's modify/delete conflicts for surfaces T3 Coder does not carry.
//
// Run after `git merge <upstream sha>` stops with conflicts (see docs/internals/sync.md). A
// conflict is resolved with `git rm` only when the fork deleted the file, upstream modified it,
// and the path falls under DELETED_PATHS. Content conflicts and every other path are listed for a
// human to decide. Upstream files added under DELETED_PATHS are listed too, never removed; those
// a carried file imports are listed apart as keep candidates.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as NodePath from "node:path";

// A trailing `/` names a directory. A RegExp matches whole paths. Any other entry names one file
// and its siblings that share the stem (`project/http.ts` also covers `project/http.test.ts`). Derived from
// `git diff --name-status <merge-base> origin/coder-only | grep ^D`.
const DELETED_PATHS = {
  // Auth and pairing: Coder owns authentication; no sessions, pairing, OAuth, DPoP, or scopes.
  // The server's auth/ keeps only ServerSecretStore, utils, and serverInternalPaths (which carried
  // file readers import); a modify/delete cannot name them.
  "auth and pairing": [
    "packages/client-runtime/src/state/environmentHttpAuth.test.ts",
    "apps/server/src/auth/",
    "apps/web/src/components/settings/SessionPermissions.tsx",
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
    "packages/client-runtime/src/state/commandPermissions.test.ts",
    "packages/client-runtime/src/state/auth.ts",
    "packages/shared/src/authScopeOptions.ts",
    "packages/shared/src/connectAuth.ts",
    "packages/shared/src/dpop.ts",
    "packages/shared/src/dpopCommon.ts",
    "packages/shared/src/oauthScope.ts",
  ],
  // Preview and browser: no in-app browser, preview panel, or headless browser automation.
  // web's browser/ keeps only useOpenLink.ts, and components/preview/ only the panel shell and
  // its resize handle. The server's preview/ keeps PortScanner.ts for port discovery, and the
  // preview state modules keep only its atoms and loopback checks.
  "preview and browser": [
    "apps/server/src/mcp/PreviewAutomationBroker.ts",
    "apps/server/src/htmlRender/headlessChrome.ts",
    "apps/server/src/htmlRender/HtmlRender.test.ts",
    "apps/server/src/mcp/toolkits/preview/",
    "apps/server/src/mcp/toolkits/previewControls/",
    /^apps\/server\/src\/preview\/(?!PortScanner\.)/,
    "apps/web/src/browser/",
    "apps/web/src/components/preview/",
    "apps/web/src/components/settings/IntegrationsSettings.tsx",
    "apps/web/src/previewMiniPlayerStore.ts",
    "apps/web/src/previewStateStore.ts",
    "apps/web/src/state/previewStream.ts",
    "packages/client-runtime/src/preview/",
    "packages/shared/src/preview.test.ts",
    "packages/shared/src/previewViewport.ts",
  ],
  // Device: no device hosts, device hub, or agent device shim.
  device: [
    "packages/client-runtime/src/state/deviceHubAccess.ts",
    "apps/server/src/device/",
    "apps/server/src/mcp/McpDeviceToolkit.test.ts",
    "apps/server/src/mcp/toolkits/device/",
    "apps/web/src/components/device/",
    "apps/web/src/components/settings/EasDeviceHostEditor.tsx",
    "apps/web/src/components/settings/easDeviceHostsSettings.logic.ts",
    "apps/web/src/state/device.ts",
    "docs/internals/devices.md",
    "docs/user/devices.md",
    "packages/contracts/src/device.test.ts",
    "packages/client-runtime/src/device/",
    "packages/client-runtime/src/state/device.ts",
  ],
  // HTTP routes and assets: the helper serves stdio RPC; its only HTTP route is the signed asset
  // route in http.ts, which assets/ backs, so both stay. No native app icons or credentialed
  // source-control media.
  "HTTP routes and assets": [
    "apps/server/src/assets/NativeAppIconResolver.ts",
    "apps/server/src/assets/sourceControlMediaResponse.ts",
    "apps/server/src/httpCors.ts",
    "apps/server/src/mcp/McpHttpServer.ts",
    "apps/server/src/mcp/OrchestratorMcpToolkit.integration.test.ts",
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
    "apps/server/src/sourceControl/SourceControlSignIn.ts",
    "apps/web/src/components/settings/SourceControlHostSettings.tsx",
  ],
  // Other provider packages: Codex, Claude Code, Pi, and Kilo Code are the only providers.
  "other provider packages": [
    "apps/server/src/provider/antigravityAuthSupport.ts",
    "apps/server/scripts/record-fx-acp-replay-fixture.ts",
    "apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.test.ts",
    "apps/server/src/orchestration-v2/Adapters/FxAdapterV2.ts",
    "apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts",
    "apps/server/src/provider/AntigravityInstallation.ts",
    "apps/server/src/provider/AntigravityProvider.ts",
    "apps/server/src/provider/Drivers/AntigravityDriver.ts",
    "apps/server/src/provider/antigravityRelease.ts",
    "apps/server/src/textGeneration/AntigravityTextGeneration.ts",
    "docs/user/providers-antigravity.md",
    "apps/server/src/provider/acp/",
    "packages/provider-cursor/",
    "packages/provider-fx/",
    "packages/provider-grok/",
    "packages/provider-muse/",
    "packages/provider-opencode/",
    // Their orchestrator replay fixtures: whole fixture directories, transcripts and assertions
    // in shared fixture directories (except the three the ACP Registry entries reuse), and
    // per-driver test files.
    /^apps\/server\/src\/orchestration-v2\/testkit\/fixtures\/(?:fx|grok|muse|opencode|skill_invocation)[^/]*\//,
    /^apps\/server\/src\/orchestration-v2\/testkit\/fixtures\/(?!message_steering\/grok_output\.ts$|todo_list\/grok_output\.ts$|tool_call_read_only\/cursor_output\.ts$)[^/]+\/(?:cursor|fx|grok|muse|opencode)_[^/]+$/,
    /^apps\/server\/src\/orchestration-v2\/testkit\/(?:Cursor|Fx|Grok|Muse|OpenCode)ReplayFixtures\./,
    "apps/server/src/orchestration-v2/Adapters/OpenCode2AdapterV2.test.ts",
    "apps/server/src/textGeneration/OpenCode2TextGeneration.test.ts",
    "apps/server/src/provider/antigravityUsageLimits.ts",
  ],
  // Kilo Code runs upstream's ACP Registry driver from its local command only: no registry
  // installs, agent sign-in, per-agent flavors, or native protocol logging.
  "ACP Registry surfaces": [
    "docs/user/providers-acp.md",
    "packages/provider-acp-registry/src/server/auth.ts",
    "packages/provider-acp-registry/src/server/authenticationState.ts",
    "packages/provider-acp-registry/src/server/copilotAcp.ts",
    "packages/provider-acp-registry/src/server/devinAcp.ts",
    "packages/provider-acp-registry/src/server/testing/",
    "packages/provider-acp/src/server/nativeLogging.ts",
    "apps/server/src/mcp/AcpMcpStdioBridge.ts",
    "apps/web/src/components/settings/AcpSessionManagementSection.tsx",
  ],
  // Desktop: no Electron app, local primary environment, desktop updates, OS permission
  // checklist, native helpers, or packaging.
  desktop: [
    "apps/web/src/lib/desktopPasteAsText.ts",
    "apps/web/src/components/ThreadNotificationCoordinator.badge.browser.test.ts",
    "patches/app-builder-lib@26.16.1.patch",
    "apps/desktop/",
    "apps/server/src/desktopUpdate/",
    "apps/web/src/components/desktop/",
    "apps/web/src/components/chat/OpenInPicker.tsx",
    "apps/web/src/components/chat/OpenInPickerShortcut.ts",
    "apps/web/src/components/permissions/",
    "apps/web/src/environments/",
    "assets/",
    "native/",
    "packages/contracts/src/ipc.ts",
    "packaging/",
    "packages/shared/src/desktopAppControl.ts",
    "scripts/apply-web-brand-assets.ts",
    "scripts/build-desktop-artifact.ts",
    "scripts/fixtures/desktop-launch/",
  ],
  // Mobile: no mobile app.
  mobile: ["apps/mobile/", "patches/@expo__ui@58.0.20.patch", "patches/expo-sharing@58.0.19.patch"],
  // Hosted web: no hosted app, cloud accounts, marketing site, or welcome onboarding.
  "hosted web": [
    "packages/client-runtime/src/promptLinks.ts",
    "apps/marketing/",
    "apps/server/src/cloud/",
    "apps/web/src/cloud/",
    "apps/web/src/components/clerk/",
    "apps/web/src/components/cloud/",
    "apps/web/src/components/onboarding/",
    "apps/web/src/components/promptLinks/copyPromptLink.ts",
  ],
  // Server CLI: the helper starts over `coder ssh`, never as upstream's `t3` command, and
  // CoderEnvironment replaces upstream's ServerEnvironment.
  // Upstream's runtime startup and state tests build its own server; the helper's startup is
  // coderServer.ts.
  "server CLI": [
    "apps/server/src/binCli.ts",
    "apps/server/src/cli/",
    "apps/server/src/environment/ServerEnvironment.ts",
    "apps/server/src/serverRuntimeStartup.autoPull.test.ts",
    "apps/server/src/serverRuntimeStartup.test.ts",
    "apps/server/src/serverRuntimeState.test.ts",
  ],
  // Local editors and provider setup: the helper cannot open an editor on the laptop, and
  // providers are configured in the workspace without in-app sign-in or setup.
  "local editors and provider setup": [
    "apps/server/src/process/externalLauncher.ts",
    "apps/server/src/process/externalLauncher.test.ts",
    "apps/web/src/components/settings/CodexSetupSection.tsx",
    "packages/shared/src/editor.ts",
    "apps/server/src/provider/CodexChatGptModels.ts",
    "apps/server/src/provider/CodexInstallation.ts",
    "apps/web/src/components/settings/ProviderSetupSection.tsx",
    "docs/user/welcome-wizard.md",
  ],
  // Tests for cut surfaces: the provider environment panel test drives managed Codex accounts and
  // ACP sign-in, the theme import test the remote catalog and desktop picker, the MCP core test
  // peer links and client scopes, and the app render scenarios upstream's fake environment.
  "tests for cut surfaces": [
    // Upstream tests built on cut surfaces: the fake environment harness, upstream's HTTP peer
    // MCP client, and host credential secret references.
    "apps/web/src/components/ChatView.browser.test.tsx",
    "apps/server/src/peer/PeerMcpClient.test.ts",
    "apps/server/src/sourceControl/sourceControlHostSecrets.test.ts",
    // Upstream's ACP Registry icon cache (`settings/AcpRegistryIcon.tsx`), which Kilo Code's
    // inlined icon replaces.
    "apps/web/src/components/chat/ProviderModelPicker.browser.test.tsx",
    "apps/web/src/components/settings/ProviderSettingsPanel.environment.browser.test.tsx",
    "apps/web/src/components/settings/ThemeImportDialog.browser.test.tsx",
    "apps/server/src/mcp/toolkits/core.test.ts",
    "apps/web/test/appScenarios.renders.tsx",
    "apps/web/src/components/settings/AddProviderInstanceDialog.environment.browser.test.tsx",
    "apps/web/test/fakeEnvironment.ts",
    "packages/client-runtime/src/state/server.test.ts",
  ],
  // Relay: no relay, Tailscale, or SSH transport.
  relay: [
    "apps/server/src/environment/DirectEndpoints.ts",
    "packages/client-runtime/src/connection/resolver.test.ts",
    "docs/internals/connection-runtime.md",
    "apps/server/src/relay/",
    "apps/web/src/state/relay.ts",
    "docs/internals/remote.md",
    "docs/user/remote-access.md",
    "infra/",
    "packages/client-runtime/src/relay/",
    "packages/contracts/src/relay.ts",
    "packages/client-runtime/src/connection/supervisor.test.ts",
    "packages/ssh/",
    "packages/tailscale/",
    "apps/web/src/components/settings/AddEnvironmentDialog.tsx",
    "apps/web/src/components/settings/ConnectionsSettings.tsx",
    "apps/web/src/components/settings/EnvironmentRoutesList.tsx",
    "apps/web/src/components/settings/LoadBalancingSettings.tsx",
    "apps/web/src/components/settings/PullRequestRoutingSettings.tsx",
    "packages/client-runtime/src/connection/routes.ts",
    "packages/client-runtime/src/state/relayDiscovery.ts",
    "packages/shared/src/relayClient.ts",
  ],
  // Telemetry: no T3-owned telemetry, usage dashboards or plan-window usage limits, diagnostics,
  // or trace export.
  telemetry: [
    "packages/shared/src/usageFormat.ts",
    "packages/shared/src/httpObservability.ts",
    "apps/server/src/diagnostics/",
    "apps/server/src/provider/Drivers/claudeUsage.ts",
    "apps/server/src/provider/Drivers/claudeUsage.test.ts",
    "apps/web/src/components/settings/DiagnosticsSettings.tsx",
    "apps/web/src/components/settings/ResourceTelemetryDiagnostics.tsx",
    "apps/server/src/observability/HeapAttribution.ts",
    "apps/server/src/observability/HeapAttribution.test.ts",
    "apps/server/src/observability/Observability.ts",
    "apps/server/src/observability/RpcInstrumentation.ts",
    "apps/server/src/resourceTelemetry/",
    "apps/server/src/telemetry/",
    "apps/server/src/usage/",
    "apps/web/src/components/usage/",
    "apps/web/src/components/settings/AddUsageLimitSourceDialog.logic.ts",
    "apps/web/src/components/settings/AddUsageLimitSourceDialog.logic.test.ts",
    "apps/web/src/components/settings/AddUsageLimitSourceDialog.tsx",
    "apps/web/src/components/settings/UsageProviderSettings.tsx",
    "apps/web/src/components/chat/ComposerUsageLimits.tsx",
    "apps/web/src/observability/",
    "apps/web/src/state/usage.ts",
    "packages/client-runtime/src/state/usage.ts",
    "packages/contracts/src/resourceTelemetry.ts",
    "packages/contracts/src/usage.ts",
    "packages/shared/src/usageLimits.ts",
    "docs/user/usage.md",
    "apps/server/src/provider/Drivers/codexUsage.ts",
    "apps/server/src/provider/EventNdjsonLogger.test.ts",
    "apps/server/src/serverLogger.ts",
    "packages/provider-pi/src/server/usage.ts",
    "packages/shared/src/observability.ts",
  ],
  // Updates and releases: no server self-update, update pill or fleet tracks, npm launcher, CLI
  // archives, or release notes.
  "updates and releases": [
    "apps/web/src/components/sidebar/updateEverythingRun.tsx",
    "apps/server/src/persistence/databaseMigrationHead.ts",
    "apps/server/src/serverOwnership.ts",
    "apps/web/src/components/ServerUpdateAction.tsx",
    "apps/web/src/components/sidebar/SidebarUpdatePill.tsx",
    "apps/web/src/components/sidebar/SidebarUpdateReleaseNotes.tsx",
    "apps/web/src/components/sidebar/UpdateEverythingDialog.tsx",
    "apps/web/src/components/sidebar/updateEverything.logic.ts",
    "apps/web/src/components/sidebar/useUpdateEverything.ts",
    "apps/web/src/state/npmRelease.ts",
    "docs/user/updating.md",
    "packages/shared/src/cliRelease.ts",
    "scripts/build-cli-archive.ts",
    "scripts/build-npm-launcher.ts",
    "scripts/generate-release-notes.ts",
    "scripts/release-smoke.ts",
    "docs/user/background-service.md",
    "scripts/npm-launcher/",
    "scripts/licenses/libatomic.LICENSE",
    "scripts/notify-discord-release.ts",
    "scripts/smoke-cli-archive.ts",
    "apps/web/src/components/settings/UpdateTrackSwitchDialog.tsx",
    "packages/client-runtime/src/connection/outdatedHostUpdate.ts",
    "scripts/install.sh",
  ],
  // Peer links: the gateway hub replaces upstream's peer stack, so there is no link request card
  // or client peer-link state.
  "peer links": [
    "apps/web/src/components/chat/LinkRequestCard.tsx",
    "packages/client-runtime/src/state/peerLinks.ts",
    "apps/server/src/mcp/linkOrigin.test.ts",
    "apps/server/src/peer/PeerForwarding.test.ts",
    "apps/server/src/peer/RemoteDelegation.test.ts",
  ],
  // Guest sharing: no guest share links, guest page, or guest HTTP routes.
  "guest sharing": [
    "apps/server/src/guest/",
    "apps/web/src/components/chat/GuestMessageAttachments.tsx",
    "apps/web/src/components/chat/GuestShareControls.tsx",
    "apps/web/src/components/chat/guestMessageStyle.tsx",
    "apps/web/src/components/guest/",
    "apps/web/src/guestPage.ts",
    "apps/web/src/routes/guest.tsx",
  ],
  // Triage and dev replay: no in-app triage of upstream issues and no dev-only replay provider.
  "triage and dev replay": [
    "apps/server/src/triage/",
    "apps/server/scripts/dev-replay/",
    "apps/server/scripts/dev-replay-agent.ts",
    "apps/server/scripts/dev-replay-agent.test.ts",
    "apps/web/src/components/DevReplayHost.tsx",
    "apps/web/src/components/chat/TriageDraftHero.tsx",
    "apps/web/src/hooks/useStartTriage.ts",
    "apps/web/src/lib/triageTarget.ts",
    "apps/web/src/lib/triageTarget.test.ts",
    "docs/user/triage.md",
  ],
  // Secret providers: no 1Password or other secret provider settings, dialogs, or packages.
  // Contracts keep upstream's settings fields.
  "secret providers": [
    "apps/server/src/secrets/settingsSecretValue.ts",
    "apps/web/src/components/settings/SecretProviderDialog.logic.test.ts",
    "apps/web/src/components/settings/SecretProviderDialog.logic.ts",
    "apps/web/src/components/settings/SecretProviderDialog.tsx",
    "apps/web/src/components/settings/SecretsSettings.tsx",
    "apps/web/src/routes/_chat.settings.secrets.tsx",
    "apps/web/src/components/settings/SecretSourceInput.tsx",
    "apps/web/src/components/settings/SecretSourceInput.browser.test.tsx",
    "apps/server/src/secrets/SecretResolver.ts",
    "apps/server/src/secrets/secretProviderDefinitions.ts",
    "apps/server/src/secrets/secretProviderDefinitions.test.ts",
    "packages/secret-provider-core/",
    "packages/secret-provider-definitions/",
    "packages/secret-provider-onepassword/",
  ],
  // Other cut web surfaces: the GitHub star prompt (#27832; GitLab is the only host) and guests'
  // screenshot URLs (#26323; workspace images load through the workspace asset route).
  "other web surfaces": [
    "apps/web/src/components/GitHubStarPrompt.tsx",
    "apps/web/src/components/chat/hostImageUrl.ts",
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
    // CI-only checks: the transfer budget harness, the agent context budget test, and the built
    // web boot check.
    "apps/server/integration/",
    "apps/server/src/provider/AgentContextBudget.test.ts",
    "apps/server/src/provider/agentContextBudget.json",
    "apps/web/scripts/verify-built-boot.ts",
    "docs/operations/",
    "docs/internals/open-source-licenses.md",
    "docs/user/faq.md",
    "scripts/check-changed.ts",
    "scripts/dev-runner.ts",
    "scripts/dev-runner.test.ts",
    // Upstream's ChatMarkdown browser test, which the fork has not carried since its first commit.
    "apps/web/src/components/ChatMarkdown.browser.test.tsx",
    // CodeRabbit's configuration and upstream's MCP tool-use evals.
    ".coderabbit.config.ts",
    "evals/",
    "oxlint-plugin-t3code/",
    "apps/server/scripts/migrate-dev-db.ts",
  ],
};

const git = (...args) => execFileSync("git", args, { encoding: "utf8", shell: false });

const stem = (file) => file.slice(0, file.lastIndexOf("."));
const categoryOf = (path) => {
  for (const [category, entries] of Object.entries(DELETED_PATHS)) {
    for (const entry of entries) {
      const matches =
        entry instanceof RegExp
          ? entry.test(path)
          : entry.endsWith("/")
            ? path.startsWith(entry)
            : path.startsWith(`${stem(entry)}.`);
      if (matches) {
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

const added = git(
  "diff",
  "--cached",
  "--no-renames",
  "--name-only",
  "--diff-filter=A",
  "HEAD",
  "-z",
)
  .split("\0")
  .filter((path) => path && categoryOf(path));
// A carried file (one outside DELETED_PATHS) can import a file upstream adds under a cut prefix
// (#28041's auth/serverInternalPaths.ts, imported by AssetAccess.ts, GitVcsDriverCore.ts, and
// WorkspaceFileSystem.ts). Such a file must be kept, so it is listed apart from the removable ones.
const stripExtension = (path) => path.replace(/\.[cm]?[jt]sx?$/, "");
const readMerged = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};
// Workspace packages by name, so `@t3tools/<pkg>/<sub>` imports resolve through their `exports`.
const workspacePackages = new Map(
  git("ls-files", "-z", "--", "apps/*/package.json", "packages/*/package.json")
    .split("\0")
    .filter(Boolean)
    .flatMap((manifest) => {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8"));
        return [[parsed.name, { dir: NodePath.posix.dirname(manifest), exports: parsed.exports }]];
      } catch {
        return [];
      }
    }),
);
const exportTarget = (value) =>
  typeof value === "string" ? value : (value?.import ?? value?.default ?? value?.types);
/** The repository path an import specifier names, for relative, package, and `~/` imports. */
const resolveSpecifier = (importer, specifier) => {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return NodePath.posix.join(NodePath.posix.dirname(importer), specifier);
  }
  // The web app's `~` alias (apps/web/tsconfig.json and vite.config.ts).
  if (specifier.startsWith("~/")) return `apps/web/src/${specifier.slice(2)}`;
  const match = /^(@[^/]+\/[^/]+)(?:\/(.+))?$/.exec(specifier);
  const pkg = match ? workspacePackages.get(match[1]) : undefined;
  if (!pkg || typeof pkg.exports !== "object" || pkg.exports === null) return undefined;
  const key = match[2] === undefined ? "." : `./${match[2]}`;
  for (const [pattern, value] of Object.entries(pkg.exports)) {
    const target = exportTarget(value);
    if (typeof target !== "string") continue;
    if (pattern === key) return NodePath.posix.join(pkg.dir, target);
    const star = pattern.indexOf("*");
    if (
      star !== -1 &&
      key.startsWith(pattern.slice(0, star)) &&
      key.endsWith(pattern.slice(star + 1))
    ) {
      const captured = key.slice(star, key.length - (pattern.length - star - 1));
      return NodePath.posix.join(pkg.dir, target.replace("*", captured));
    }
  }
  return undefined;
};
const importersOf = (path) => {
  const stem = NodePath.posix.basename(stripExtension(path));
  let hits = "";
  try {
    hits = git("grep", "-l", "-z", "-F", "-e", stem, "--", "apps", "packages");
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  return hits
    .split("\0")
    .filter((file) => file && file !== path && !categoryOf(file))
    .filter((file) =>
      [...readMerged(file).matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g)].some(
        ([, specifier]) => {
          const resolved = resolveSpecifier(file, specifier);
          return resolved !== undefined && stripExtension(resolved) === stripExtension(path);
        },
      ),
    );
};
const keep = [];
const removable = [];
for (const path of added) {
  const importers = importersOf(path);
  if (importers.length > 0) keep.push({ path, importers });
  else removable.push(path);
}
if (removable.length > 0) {
  console.log(`\nAdded by upstream under deleted paths, not touched (${removable.length}):`);
  for (const path of removable) console.log(`  ${path}  [${categoryOf(path)}]`);
}
if (keep.length > 0) {
  console.log(
    `\nKeep candidates: added under deleted paths but imported by a carried file (${keep.length}):`,
  );
  for (const { path, importers } of keep) {
    console.log(`  ${path}  [${categoryOf(path)}]`);
    for (const importer of importers) console.log(`    imported by ${importer}`);
  }
}
