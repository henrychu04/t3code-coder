# Upstream sync checklist

Merge `pingdotgg/t3code` `main` into `coder-only`. Follow the steps in order. Read `AGENTS.md`
and the upstream seams in [coder-only.md](coder-only.md#upstream-seams) first; that list is the
only fork behavior to keep. Commands run from the repository root of the sync worktree.

## 1. Prepare

1. `git fetch origin && git fetch upstream main`. Do not move `origin/main`; mirroring it is a
   separate step the owner authorizes.
2. Choose the exact upstream commit and read its range. Never take "the tip" without reading it:
   `git log --oneline origin/coder-only..upstream/main`. Compare the range with the open issues
   labelled `upstream` (`gh issue list --label upstream`): note any the range fixes, and the
   fork seams that fix makes redundant.
3. Set the variables every later step uses:
   ```sh
   SHA=<verified upstream sha>
   PREV=$(git rev-parse origin/coder-only)
   MB=$(git merge-base "$PREV" "$SHA")
   ```
   `$MB` is the previous sync point. The seams doc's "checked against" lines name the upstream
   commit each carried fix was last compared with.
4. Create a worktree branch from `origin/coder-only` (in T3 Code, use a worktree workspace
   strategy): `git worktree add -b t3code/sync-upstream-<short sha> <path> origin/coder-only`.
   There, run `pnpm install --frozen-lockfile`.

## 2. Merge rules

- `git -c merge.directoryRenames=false merge --no-ff --no-commit "$SHA"`. Without the
  setting, git infers directory renames from earlier upstream moves and files mobile adds under
  `apps/mobile/src/lib` land in `packages/shared/src` as stage-3-only "added" files that upstream
  never had there (six in the 5cbe82a870 sync). Check any such file with
  `git ls-tree "$SHA" -- <path>`: an empty answer means git invented the path.
- Take upstream's version of a file and reapply only the seams the seams doc lists, each marked
  `Coder:` in code. A difference not listed there is drift: remove it.
- Leave upstream bugs unfixed unless they break an `AGENTS.md` boundary.
- If adopting upstream would remove fork behavior the seams doc lists, stop and tell the user.
- To reopen a file resolved wrongly with its conflict markers: `git checkout -m -- <file>`.
- Resolve test files block by block, as code. Taking the fork's whole test file drops upstream's
  mechanical edits (renamed types, branded values) from conflicted regions only, which typecheck
  then reports far from their cause. Where diff3 interleaves two versions of one test, replace that
  whole test with one side rather than splicing hunks.
- Upstream test files that merge in without conflict can still exercise a cut surface or an SDK
  hook the CLI transport lacks (for example the SDK's `spawnClaudeCodeProcess`); review every
  added or modified `*.test.*` in the range and adapt or cut it with a `Coder:` comment.
- When upstream edits a block the fork moved into a Coder file, apply the edit there; the marker
  and lost-line checks in section 6 do not catch this.
- An upstream commit for a cut surface can also add hooks to carried files that only the cut
  surface calls (in the dd5c7bd09e sync, `ProviderUpdatesAction`'s `quiet` option and returned
  runs for "Update everything"). Leave those hunks out, mark the file `Coder:`, and list the seam.
- Fork-only tests that build upstream services (`mcp/bridge/T3ToolBridge.test.ts`,
  `storageCleanup.coder.test.ts`, `ws.projects.test.ts`) fail typecheck when upstream adds a
  service dependency; mock it as upstream's own tests of that service do. Their fixtures cast
  partial records (`as unknown as`), so a field upstream starts reading fails only at runtime
  (2a7bd1673c: thread shells' `lineage` and `settledAt`); copy the fields from upstream's own
  fixture for that service.
- When upstream rewrites a file wholesale (in 2a7bd1673c, `ChatView.tsx` and `ChatComposer.tsx`
  moved from `useCallback` to plain functions and `useStableCallback`), take upstream's file and
  replay the fork's delta hunk by hunk: `git diff "$MB" "$PREV" -- <file>`, split it into one
  file per hunk, and apply each with `patch -p1 --fuzz=3 -i <hunk>` (`patch` reads a positional
  argument as the file to patch, so pass the hunk with `-i`). Apply rejects by hand, and check
  that no fuzzy hunk landed in the wrong block (in that sync two retry buttons swapped their
  `image` and `file` variables). Then confirm the delta survived: every line the fork added in
  `$MB..$PREV` is in the result, and every line the fork removed that upstream still has is not:
  ```sh
  python3 - "$MB" "$PREV" "$SHA" <file> <<'PY'
  import subprocess, sys; from collections import Counter
  f = sys.argv[4]
  rev = lambda r: Counter(l.strip() for l in subprocess.run(["git", "show", f"{r}:{f}"], capture_output=True, text=True).stdout.splitlines() if len(l.strip()) > 3)
  mb, prev, sha = (rev(r) for r in sys.argv[1:4])
  res = Counter(l.strip() for l in open(f).read().splitlines() if len(l.strip()) > 3)
  for l, n in prev.items():
      if n > mb[l] and res[l] < min(sha[l] + n - mb[l], n): print("lost fork line:", l)
  for l, n in mb.items():
      if n > prev[l] and sha[l] and res[l] > max(sha[l] - (n - prev[l]), 0): print("fork cut back:", l)
  PY
  ```
  macOS `patch` reverses a hunk it takes for "already applied" without failing; pass `-N` so
  such hunks become rejects to apply by hand.
  Expect hook dependency-list entries and call sites the refactor rewrote; read every other line,
  since it is a lost or reverted seam (that sync's check caught a "pull request" wording
  regression this way).
- An upstream commit that only deletes comments (cfafb4bb54's #19559 touched about 3,100
  files) conflicts wherever the fork edited nearby. Merge it in its own stage: merge up to the
  commit's parent first, then the commit with the rest of the range. With
  `-c merge.conflictStyle=diff3`, a hunk whose upstream side differs from the base only in
  comment lines takes the fork's side with upstream's comment edits applied. Where upstream
  deleted a comment that also held a `Coder:` note, keep the note as its own comment. Edit
  comment blocks whole: removing upstream's lines one at a time can drop a `/**` or `*/` the
  fork's text still needs (typecheck catches the orphaned lines). Afterwards, list comment lines
  upstream deleted that the result still has, since an auto-merged hunk can keep them too.
- A mechanical upstream refactor (e.g. e85539ab59's traced `Effect.fn` wrappers, #21989–#22000)
  re-indents whole functions, so conflicts span the fork's rewrites. Merge it in its own stage. For a
  file the refactor alone touched, take upstream's file and replay the fork's delta
  (`git diff "$MB" "$PREV" -- <file>`) with `patch -p1 -l --fuzz=3`, which ignores the indentation
  change, then `vp fmt`. Where the fork replaced a function wholesale (Kilo Code, Codex, and Claude
  drivers' `create`), keep the fork's body and apply only upstream's wrapper. Effect.fn spans
  export nothing here, but matching upstream's shape keeps later syncs small.
- When upstream splits a file into new modules (688ee52f0e: ChatView, ChatMarkdown, ChatComposer,
  MessagesTimeline, CommandPalette, SettingsPanels, the sidebar, and the pull requests page), the
  new modules arrive as plain added files with none of the fork's delta, and can carry cut
  surfaces again (`useSystemComposerBanners`' server-update notice). Replay the old file's delta
  into whichever module now holds each block, strip cut surfaces there, and run the lost-line
  check above against the old file plus its new modules together. Section 6's marker check then
  shows the old file's drop and the new modules' gain; the totals should match.
- When upstream moves web logic into a shared package (07d38b8d17: `LinkPullRequestDialog`'s
  parsing moved to client-runtime's `pullRequestLinkInput.ts`), move the fork's test adaptations
  with it, keep the moved module upstream's apart from wording, and keep a seam that needs web
  code (`gitLabMergeRequestBrowserUrl`) as a wrapper at the web caller.
- An upstream sweep that deletes code nothing upstream reaches (67661cfbb5's #26238) also removes
  helpers, mock-agent options, and guards that only fork-only tests (tests the fork kept after
  upstream deleted its copy) or fork modules still use. Typecheck misses most of these, since
  the tests mock by name or spawn scripts; only the full suite finds them (that sync:
  `GitWorkflowService.test.ts`'s `jj` guard, `useThreadActionMenu.test.tsx`'s entity mocks,
  the Kilo adapter test's `acp-mock-agent.ts` option). Keep a piece a fork module needs as a
  `Coder:` seam; adapt a fork-only test to the remaining behavior.
- Upstream code the fork carries can start importing a module the fork deleted (in 2a7bd1673c,
  `ThreadManagementService.ts` imports `environment/ServerEnvironment.ts` for
  `ServerEnvironmentIdentity`). Declare the piece it needs in the matching Coder module
  (`coderEnvironment.ts`) and point the import there with a `Coder:` comment.
- An upstream rewrite can add a new caller of the upstream function a seam replaces, in a file that
  merged cleanly (6d450a4284's #25869: `ChatView.tsx`'s new-thread permissions label called
  `resolveCompatibleRuntimeMode` while the composer used the fork's resolver). After resolving,
  `rg` the tree for the upstream names each touched seam replaces, not only the conflicted files.
- Fork wording changes inside upstream code (GitLab's "merge request !N") break the new test cases
  upstream adds for that code (48a292364a's #26395). `pnpm test:coder` stops at the first failing
  package, so read its log for the failing package and rerun until every package has run.

## 3. Deleted directories

Upstream files under directories the fork deleted stay deleted, whether upstream modified or added
them. After `git merge` stops, run `node scripts/sync-resolve-deleted.mjs` (or
`pnpm sync:resolve-deleted` when no `package.json` or `pnpm-lock.yaml` is conflicted, since pnpm
checks dependencies before running a script). It `git rm`s each modify/delete conflict under the
paths listed in the script and prints every other conflict and every upstream-added file under
those paths, untouched, for you to decide. It never resolves a content conflict. A modify/delete it leaves for a human on a surface the fork
already removed belongs in the script: `git rm` it and add the path to `DELETED_PATHS` in the same
stage (6d450a4284 added 56). The files it lists are untouched but staged, so removing
one needs `git rm -f`.

An upstream file added under a deleted path can still be needed: a carried file may import it
(upstream #28041 adds `apps/server/src/auth/serverInternalPaths.ts`, which the carried
`AssetAccess.ts`, `GitVcsDriverCore.ts`, and `WorkspaceFileSystem.ts` import). The script lists
such files apart, under "Keep candidates", with their importers. Keep each one a carried file
needs (narrow the `DELETED_PATHS` entry if the directory is otherwise cut, and add the file to
the seams doc); an importer that is itself an uncarried upstream addition (`binCli.ts` for
`cli/up.ts`) means neither is needed. To remove every other listed upstream-added file at once:

```sh
node scripts/sync-resolve-deleted.mjs | awk '/^Added by upstream/ { on = 1; next } /^$/ { on = 0 } on && /^  / { print $1 }' > /tmp/sync-added.txt
git rm -q -f --pathspec-from-file=/tmp/sync-added.txt
```

The script lists only paths under deleted directories. Upstream also adds files for cut surfaces
in kept directories (in the 5cbe82a870 sync: `observability/OtlpEndpointCheck.ts`,
`settings/TelemetryExportSettings.tsx`, `provider/antigravityUsageLimits.ts`, and provider-pi's
`usage.ts`; in the 2a7bd1673c sync: server `outboundHttp.ts` and `zipArchive.ts`, the OTLP
`config.test.ts`, web `sidebar/SidebarUpdateCapsule.tsx` and `settings/DatabaseStorageNotice.tsx`,
and client-runtime `state/threadTranscriptHttp.ts`, which the fork replaced with an RPC); review
`git diff --name-only --diff-filter=A "$MB" "$SHA" -- apps packages` for them. Upstream's manual
repro fixtures and seed scripts under `scripts` (eb1510d249: `fixtures/issue-16534`; bb7783e295:
`fixtures/issue-18188`, `fixtures/issue-21397.json`, `seed-issue-21397.py` and its test) are
upstream tooling; delete them. Upstream's
patches for mobile or desktop packages land in `patches/` (2a7bd1673c: `@expo__ui@58.0.18.patch`);
delete any that `pnpm-workspace.yaml`'s `patchedDependencies` does not list. An upstream bump
of a patched package the fork cut renames its patch, so the new file arrives as an addition
outside any deleted path (67661cfbb5: `alchemy@2.0.0-beta.84.patch`); compare `ls patches` with
`patchedDependencies` after every stage. A fork-deleted file
outside those paths that upstream modified (a cut
surface's test or settings panel) is listed as "deleted by fork"; keep it deleted unless the seams
doc says otherwise. An upstream rename out of a deleted directory into a kept one (in this batch,
mobile's `microphonePriority.ts` into `packages/shared`) arrives as an added file with only stage
3; carry it only if a carried surface uses it. The categories
(top-level directories in brackets):

- Auth and pairing (`apps/server/src/auth`, web `components/auth`, client-runtime `authorization`).
- Preview and browser (`apps/server/src/preview` except `PortScanner.ts`, web `browser`,
  `components/preview`).
- Device (`apps/server/src/device`, web `components/device`, client-runtime `device`).
- HTTP routes (`http.ts` route files other than the server's signed asset route in
  `apps/server/src/http.ts`, and the uncarried `assets/` modules).
- Forgejo, GitHub, Azure DevOps, Bitbucket, and GitCafe (`packages/source-control-*` except core,
  gitlab, and testing).
- Other provider packages (`packages/provider-{cursor,fx,grok,muse,opencode}`,
  `apps/server/src/provider/acp`) and their orchestrator replay fixtures (matched by pattern;
  upstream's new entries for them in `testkit/fixtures/index.ts` still merge in, and typecheck
  reports their imports of the deleted files).
- ACP Registry surfaces Kilo Code does not use (provider-acp-registry's `auth.ts`,
  `authenticationState.ts`, `copilotAcp.ts`, `devinAcp.ts`, and `testing/`; provider-acp's
  `nativeLogging.ts`).
- Desktop (`apps/desktop`, `native`, `packaging`, `assets`); mobile (`apps/mobile`); hosted web
  (`apps/marketing`, `apps/server/src/cloud`, web `cloud`, `components/clerk`).
- Triage and dev replay (`apps/server/src/triage`, `apps/server/scripts/dev-replay*`,
  web `DevReplayHost.tsx`, `chat/TriageDraftHero.tsx`,
  `hooks/useStartTriage.ts`, `lib/triageTarget.ts`, `docs/user/triage.md`).
- Relay (`apps/server/src/relay`, `infra`, `packages/ssh`, `packages/tailscale`); telemetry
  (`apps/server/src/{telemetry,resourceTelemetry,usage,diagnostics}`, web `components/usage`).
- Secret providers (web `settings/SecretsSettings.tsx`, `SecretProviderDialog*`,
  `SecretSourceInput*`, the server's `secrets/SecretResolver.ts` and `secretProviderDefinitions*`,
  `packages/secret-provider-*`).
- Local editors and provider setup (`process/externalLauncher*`, shared `editor.ts`, web
  `CodexSetupSection.tsx`), and upstream tests for cut surfaces (`mcp/toolkits/core.test.ts`,
  `apps/web/test/appScenarios.renders.tsx`, two settings browser tests).
- Upstream repository tooling (`.github`, `.repos`, `oxlint-plugin-t3code`, `docs/operations`,
  `apps/server/integration`, `evals`, `.coderabbit.config.ts`) and upstream's CI-only checks
  (`AgentContextBudget.test.ts`, `verify-built-boot.ts`).

Re-derive the list, and update the script's data, when the fork cuts or restores a surface:

```sh
git -c diff.renameLimit=0 diff --no-renames --name-status "$MB" origin/coder-only |
  awk '$1 == "D" { split($2, p, "/"); print (p[1] == "apps" || p[1] == "packages") ? p[1] "/" p[2] : p[1] }' |
  sort | uniq -c | sort -rn
```

## 4. Conflict magnets

- `apps/server/src/server.ts`: upstream's file minus the cut surfaces. Upstream's edits to the
  carried declarations merge; keep their `Coder:` changes and the export block. Conflicts
  sit in regions the fork deletes (`layerMakeServer`, `layerRuntimeCoreDependencies*`, HTTP,
  auth, preview, and telemetry layers): keep the deletion, and port a new service or provide the
  helper needs into `coderServer.ts`'s matching composition (`CoderRuntimeCoreLive`,
  `CoderRuntimeDependenciesLive`, `CoderRuntimeStartupLive`, or `makeCoderRuntimeLayer`). Export
  a carried declaration only when `coderServer.ts` uses it. A service that gains a requirement
  (758d773f57: `ProviderRegistry` reading `ProviderLatestVersions`) still typechecks in
  `apps/server`, because only the helper entry point launches the composed layer; run
  `pnpm typecheck:helper` to catch a requirement `coderServer.ts` does not provide.
- `apps/server/src/ws.ts`: upstream's file minus the cut surfaces, with in-place `Coder:` changes;
  the fork-only methods live in `coderWs.ts`, merged in at the `return` hook. Keep upstream's
  handler and helper order and take upstream's handler edits. Its handler object is typed by
  `CoderWsRpcGroup` minus `CODER_WS_METHODS`, so typecheck fails until every served upstream
  method has a handler there (see section 5 for adding RPCs). `coderWs.ts` wraps upstream's Files
  list, read, and write handlers rather than copying them, so their upstream edits apply as they
  merge.
- `apps/web/src/components/ChatView.tsx`: the fork removes preview, device, usage, self-update,
  local editor, and feedback code. Take upstream's hunk, then re-delete the hole and
  keep its `Coder:` comment.
- `docs/user/*.md`: take upstream's text, then reapply "merge request", "MR", `!N`, "T3 Coder".
- `knip.jsonc`: keep ours; add or drop `ignoreIssues` entries as `pnpm knip:check` reports, and
  remove any `workspaces` entry upstream adds for a package the fork does not carry (2a7bd1673c:
  `packages/source-control-github`). Its long entries stay on one line; do not reformat the file.
- `package.json` export maps: when both sides add an entry near the same place, the merge can keep
  it twice. JSON parsing silently keeps the last copy, so check changed manifests for duplicate
  keys (`vp fmt` drops them, as does a `json.load(..., object_pairs_hook=...)` check).
- Patch files under `patches/`: when upstream bumps a patched package, the fork's patch for the
  old version arrives as modify/delete. Check whether the new version still needs the fork's
  hunks, and append them to upstream's new patch by hand; `pnpm patch-commit` rewrites the whole
  file in its own order. pnpm checks each hunk header's line counts when it applies a patch, so
  an appended hunk must keep exact `@@ -a,b +c,d @@` counts; `pnpm install --frozen-lockfile`
  fails on a miscounted one.
- `pnpm-lock.yaml`: keep ours, run `pnpm install --no-frozen-lockfile` to apply the merged
  `package.json` files, then confirm `pnpm install --frozen-lockfile` passes. Do this even when the
  lockfile merged cleanly: the auto-merge carries importer entries for deleted packages, and any
  later `pnpm exec`/`vp` run silently rewrites the lockfile when it disagrees with a `package.json`.
  Start from ours with `git show HEAD:pnpm-lock.yaml > pnpm-lock.yaml` (during a merge,
  `git checkout --ours` works only on a conflicted path). Resolve the lockfile and every
  `package.json` before running any `pnpm <script>`, the `typecheck:*` scripts included: pnpm
  checks dependencies first and installs when a manifest disagrees with the lockfile.
  Re-resolving from ours picks the newest version of each package new to the lockfile, while
  upstream's lockfile and `third-party-licenses.config.json` overrides name the version upstream
  resolved (7df7cb9999: `@nodable/entities` 2.2.0 against upstream's 2.1.1 failed the web build's
  license step). List the newly added package versions that differ from upstream's lockfile and
  replace their `packages:` and `snapshots:` entries and references with upstream's, then confirm
  `pnpm install --frozen-lockfile` passes.
- When upstream moves a dependency line within a `package.json` (67661cfbb5: `@opencode-ai/sdk`
  from `dependencies` to `devDependencies` in `apps/server`), the merge can add it back for a
  package the fork cut. Review `git diff HEAD -- '*package.json'` after resolving manifests.
- New upstream code can import a dependency the fork had removed with an old cut (7df7cb9999:
  `yauzl` for document text, `jszip` for office previews). Typecheck reports the missing module;
  restore upstream's dependency entry rather than adapting the code.
- `apps/coder-gateway/src/server.ts`'s CSP pins the hash of `apps/web/index.html`'s inline boot
  script. When upstream edits that script (comment pruning counts), recompute the hash;
  `server.test.ts` fails until then.
- A package that gains a dependency on deleted host packages (this batch: client-runtime on every
  `source-control-*` client definition) keeps only `source-control-core` and `-gitlab`.

## 5. Seams to re-check on every sync

- **Claude CLI transport.** Every option upstream passes to `query()` must be in `ClaudeAgentSdk.ts`'s
  `SUPPORTED_QUERY_OPTIONS`, and every `Query` method it calls in the seams doc's mapped list; an
  unsupported option fails every Claude turn at runtime only. Read `makeClaudeQueryOptions` and the
  `query({` call: `git diff "$MB" "$SHA" -- apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts apps/server/src/provider/ClaudeProvider.ts`.
  New `Query` calls, by method name, since upstream's receivers vary (`q`, `queryRuntime`,
  `liveQuery.query`):
  ```sh
  sdk=$(ls -d node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@*/node_modules/@anthropic-ai/claude-agent-sdk | head -1)
  methods=$(awk '/^export declare interface Query /,/^}/' "$sdk/sdk.d.ts" | grep -oE '^    [a-zA-Z]+\(' | tr -d ' (' | sort -u | paste -sd'|' -)
  git diff "$MB" "$SHA" -- apps/server/src ':!*.test.*' | grep -E "^\+.*\.($methods)\("
  ```
  SDK bumps: `git diff "$MB" "$SHA" -- '*package.json' | grep claude-agent-sdk`.
  Upstream may add an SDK hook in the runner's own `query({` call rather than in
  `makeClaudeQueryOptions` (`spawnClaudeCodeProcess` in dd5c7bd09e); `ClaudeCli.ts` must honour
  it, and upstream's `ClaudeAgentSdkQueryRunner.test.ts` fake-CLI tests then exercise it.
  A rejected `Query` method is loud only if upstream lets the rejection surface: upstream wraps
  some calls (`setMcpServers` in `layerQueryRunner`) so a failure is logged and the turn continues
  without the feature. For every new call, read how upstream handles its failure; implement the
  method in `ClaudeCli.ts` from the SDK's `sdk.mjs` request shape (find
  `async <method>(` in `node_modules/.pnpm/@anthropic-ai+claude-agent-sdk*/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`)
  and add a `ClaudeCli.test.ts` case whose fake CLI answers only the exact shape.
- **Node 24 runtime.** The laptop and the workspaces run Node 24, while upstream develops on
  Node 26 (`engines.node` pinned to `26.12.1` since ed3f965e07). Keep root `engines.node` at the
  fork's `^24.13.1` and the `@types/node` catalog entry on major 24 even when upstream bumps them,
  so typecheck rejects a Node 25 or 26-only API in carried code. If upstream code needs one, stop
  and tell the user. Bumps: `git diff "$MB" "$SHA" -- package.json pnpm-workspace.yaml | grep -E 'engines|"node"|@types/node'`.
- **MCP servers.** T3 tools reach agents over the file bridge, never an MCP server, because work
  Claude Code and Codex policies block custom MCP servers (`AGENTS.md` boundary 6). Carry a new
  upstream toolkit over the bridge and cut any new path that hands a provider T3's MCP endpoint.
  Listeners inside the workspace are otherwise allowed. Search the range:
  `git diff "$MB" "$SHA" -- apps/server/src packages ':!*.test.*' | rg '^\+.*(mcp_servers|mcpServers|McpHttpServer)'`.
- **Capabilities.** `coderEnvironment.test.ts` fails when upstream adds an
  `ExecutionEnvironmentCapabilities` key; decide it (advertise, or add to
  `CODER_OMITTED_CAPABILITIES` with a reason).
- **RPCs.** List RPCs upstream added to `WsRpcGroup` in the range; serve each in `CoderWsRpcGroup`
  or record why it is omitted (the pattern needs digits for the `WsOrchestrationV2…Rpc` names):
  ```sh
  rpcs() { git show "$1:packages/contracts/src/rpc.ts" | sed -n '/^export const WsRpcGroup = /,/^);/p' | grep -oE 'Ws[A-Za-z0-9]+Rpc' | sort -u; }
  comm -13 <(rpcs "$MB") <(rpcs "$SHA")
  ```
- **Shared contracts.** Never drop a field the fork does not use. For each contract file upstream
  changed (`git diff --name-only "$MB" "$SHA" -- packages/contracts/src`), every hunk of
  `git diff "$SHA" -- <file>` must be a listed Contracts seam.
- **Always-grant scopes.** `useEnvironmentScope`, `useEnvironmentsWithScope`,
  `readEnvironmentScope` (`apps/web/src/state/session.ts`), `useFilesystemReadAccess`, and
  client-runtime's command permissions still grant everything. New gates:
  `git diff "$MB" "$SHA" -- apps/web/src packages/client-runtime/src | grep -E '^\+.*(EnvironmentScope|EnvironmentsWithScope|FilesystemReadAccess|commandPermissions|RpcPermissionGuard)'`.
- **Wording.** New user-facing strings follow the merge-request wording seam. Use `rg` (some
  shells alias `grep` to tools that reject `\b`), and include the source-control packages and
  `#${` references, which the `!123` seam replaces:
  `git diff "$MB" "$SHA" -- apps/web/src packages/client-runtime/src packages/shared/src apps/server/src docs/user packages/source-control-core/src packages/source-control-gitlab/src ':!*.test.*' | rg '^\+.*([Pp]ull [Rr]equest|\bPRs?\b|T3 Code\b|#\$\{)'`.
  Upstream tests that assert merge-request summaries (`runtimeLayer.test.ts`'s watch tests) spell
  them `#N`; the fork's text is `!N`.
  New text that describes a mechanism the fork cut (in dd5c7bd09e, provider update checks
  "fetch model catalog updates", where the catalog is bundled) keeps describing what T3 Coder does.
- **Source-control host definitions.** `source-control-definitions`' `registry.ts` and the server's
  `sourceControl/sourceControlDefinitions.ts` register only GitLab. When upstream moves host
  behavior into definitions or driver hooks, delete the fork's per-kind GitLab shims that the
  GitLab-only registry now expresses, and move a remaining GitLab difference into GitLab's
  definition when the field exists for it (be1d066732: `referenceAutolinks` replaced the web's
  GitLab autolink code). When upstream deletes code in favor of a hook, check that the helper
  wires the hook: be1d066732 replaced `PullRequestService`'s unknown-host refinement with the
  repository identity resolver's `refine`, which an older sync had dropped from the fork, so
  self-hosted GitLab detection would have silently stopped. Upstream tests that build GitHub,
  GitCafe, or Azure URLs fail only at runtime once the registry no longer parses them; move them
  to GitLab URLs or cut them. A host's media, settings, and credential helpers that only cut hosts
  use go in `knip.jsonc`'s `ignoreIssues`.

## 6. Mechanical checks after the merge

Before committing the merge, run `node scripts/sync-check.mjs "$PREV" "$SHA"` from the merge
result. Read every line it prints; it changes nothing. Its checks (`--only <name>` runs one):

- `markers`: each upstream-modified file's `Coder:` marker count against `$PREV`. A drop must be
  inside a block upstream deleted, or be a seam that upstream's own mechanism now expresses (name
  it in the merge commit body).
- `lost`: lines upstream added in `$MB..$SHA` that the result lacks; each must be a listed seam or
  a deleted surface. It uses the merged range, never `upstream/main`'s tip (later work would show
  as losses).
- `both-sides`: lines both `$PREV` and `$SHA` have that the result lacks. Neither side deleted
  them, so each is a merge loss unless the line moved (7df7cb9999 lost `projectScriptEditor.tsx`'s
  run-on-settle switch this way; `lost` misses it because the line predates `$MB`).
- `unused-locals`: unused imports and locals (`tsc --noUnusedLocals` over every package, about a
  minute). Knip does not see them, and cutting a surface or replaying the fork's delta into
  upstream's split modules leaves them behind (688ee52f0e left about 50, including a dead Claude
  worker). A name that upstream's own file has as often is upstream's and is skipped. Remove each
  listed name, then rerun with `--only unused-locals` until it prints nothing: removing a
  declaration can leave its imports unused in turn.

Then run `node scripts/seams-check.mjs "$SHA"`. It fails when a backticked name in the seams doc's
"Upstream seams" or "Cut surfaces" section exists in neither the result nor `$SHA` (a stale
entry), or when an upstream file the fork modified, outside tests and docs, has no `Coder:`
marker in its fork lines, no mention in `coder-only.md`, and is not a pure merge-request wording
swap. Fix the doc or mark the code until it passes.

Check that no `patch` backup or reject file was staged:
`git ls-files | grep -E '\.(orig|rej)$'` must print nothing (a `BranchToolbar.tsx.orig` slipped
into the fb990765a4 merge).

Finish with `pnpm knip:check`. Upstream's test pruning can leave an export used only by a cut
surface (mobile, relay, other providers) once the test that imported it is gone; list that file
in `knip.jsonc`'s `ignoreIssues`, and delete the export instead when it is in a fork-only file.

## 7. Verify

In this order, fixing each failure before the next: `pnpm test:coder`; every typecheck listed in
`AGENTS.md`; `pnpm knip:check`; `node scripts/seams-check.mjs "$SHA"`; `pnpm build`; then
`pnpm exec vp fmt --check $(git diff --name-only "$PREV" HEAD -- '*.ts' '*.tsx' '*.mjs' '*.md')`
over the files the merge changed, since a comment deletion can leave a doubled blank line that
typecheck and tests never see (cfafb4bb54: `ModelManifest.test.ts`). Typecheck before the full suite finds most merge
breakage faster. For one file, `pnpm exec vp test run --config vite.coder.config.ts <file>`
covers `apps/server` only; run web, client-runtime, and package tests from the package
directory with `pnpm exec vp test run <file>`.

Then start up a real instance with mocks and do a simple test.

`pnpm test:coder` exits 0; a failure is real. It stops at the first failing package script, so
fix and rerun until it completes. A full run takes over ten minutes, longer than an agent's
foreground command limit, so run it in the background and read its log. Known results:

- The suite needs a Node version in the root `engines.node` (the fork's `^24.13.1`). On an
  older Node, three upstream tests fail on unmodified upstream code: ProjectionRecovery's "selects
  unfinished recovery work without reading settled thread histories" (`ProjectionStoreSetupError`,
  "malformed JSON") and nodeSqliteClient's "keeps large text and blob parameters off cached
  statements" (node:sqlite binds an ArrayBuffer parameter as NULL) and "checkpoints the WAL on the
  worker instead of the writer" (its SQLite predates 3.51). Check `node -p process.version`
  against `engines.node` before blaming the merge; do not skip them.
- `apps/server/src/serverSettings.test.ts` "follows a settings link that is repointed to another
  directory" and "reloads when a dangling settings link gets its destination" can hit their
  2-second watcher timeout under full-suite load; #236 lists the other known flakes. Rerun it
  alone:
  `pnpm exec vp test run --config vite.coder.config.ts apps/server/src/serverSettings.test.ts`.
- On macOS, upstream's `ClaudeSkills.test.ts` "merges plugin enablement and selects installs in
  native registry order" fails because `TMPDIR` sits under the `/var` symlink (758d773f57, #235),
  as does `GitVcsDriverCore.test.ts`'s "keeps generated worktree folders short without changing
  long branch names" (32ecd71726). Both pass with a real-path temp directory:
  `TMPDIR=/private/tmp/<dir>`.
- Read the suite's own exit status from its log. A background run like
  `pnpm test:coder > log; echo "exit=$?" >> log` reports success to the agent harness even when the
  suite failed (32ecd71726's stage 2 did).
- In a fresh worktree, the first web runs can fail in browser test files that load no tests
  ("There was an error when mocking a module") or time out, because Vite re-optimizes
  dependencies mid-run and reloads ("optimized dependencies changed. reloading"). Rerun
  `pnpm test:web:coder` until no reload is logged; failures that remain are real.
- Fork-adapted unit tests that match rendered HTML as strings (`ChatMarkdown.test.tsx`) fail when
  upstream adds an attribute its browser tests never assert (ed3f965e07: #22777's `dir`). Add
  the attribute to the expected string.

## 8. Land

1. Commit the merge alone: `git commit` with the subject
   `Merge upstream/main <short sha> into coder-only` and a body naming what upstream brought and
   how conflicts were resolved.
2. Commit each Coder adaptation separately after it.
3. `git push -u origin <branch>`.
4. `gh pr create --base coder-only --head <branch>`. Always pass `--base coder-only`; never rely on
   the repository default and never target `main`.
5. Register the PR with T3's `link_pull_request` tool when it is available.
6. `gh pr view <number> --json baseRefName,headRefOid`: `baseRefName` must be `coder-only` and
   `headRefOid` must equal `git rev-parse HEAD`.
7. `gh pr merge <number> --merge --admin --match-head-commit <sha>`: the `coder-only` ruleset
   requires a review the owner cannot give themselves. Keep the branch (no `--delete-branch`).
8. `git fetch origin && git log -1 --format=%P origin/coder-only`: the second parent is `<sha>`.

9. Update the seams doc's "checked against" SHAs for carried fixes still present upstream, set
   `SYNC_BASE` in `scripts/seams-check.mjs` to the merged upstream commit, and add to this file
   wherever it fell short during the sync.
10. Close the issues the sync resolved, with a comment naming the upstream commit, and open issues
    for bugs it surfaced but left unfixed.
