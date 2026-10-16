# Upstream sync checklist

Merge `pingdotgg/t3code` `main` into `coder-only`. Follow the steps in order. Read `AGENTS.md`
and the upstream seams in [coder-only.md](coder-only.md#upstream-seams) first; that list is the
only fork behavior to keep. Commands run from the repository root of the sync worktree.

## 1. Prepare

1. `git fetch origin && git fetch upstream main`. Do not move `origin/main`; mirroring it is a
   separate step the owner authorizes.
2. Choose the exact upstream commit and read its range. Never take "the tip" without reading it:
   `git log --oneline origin/coder-only..upstream/main`.
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
- When upstream edits a block the fork moved into a Coder file, apply the edit there. In the
  aef0e9ca40 sync, `FilePreviewPanel`'s attachment preview lives in `SentAttachmentFilePreview`
  and HTML render's full-size open is `HtmlRenderFrame`'s dialog, so upstream's new `threadRef`
  went to both; the marker and lost-line checks in section 6 do not catch this.
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
- Upstream code the fork carries can start importing a module the fork deleted (in 2a7bd1673c,
  `ThreadManagementService.ts` imports `environment/ServerEnvironment.ts` for
  `ServerEnvironmentIdentity`). Declare the piece it needs in the matching Coder module
  (`coderEnvironment.ts`) and point the import there with a `Coder:` comment.

## 3. Deleted directories

Upstream files under directories the fork deleted stay deleted, whether upstream modified or added
them. After `git merge` stops, run `node scripts/sync-resolve-deleted.mjs` (or
`pnpm sync:resolve-deleted` when no `package.json` or `pnpm-lock.yaml` is conflicted, since pnpm
checks dependencies before running a script). It `git rm`s each modify/delete conflict under the
paths listed in the script and prints every other conflict and every upstream-added file under
those paths, untouched, for you to decide. It never resolves a content conflict. The files it lists are untouched but staged, so removing
one needs `git rm -f`. To remove every listed upstream-added file at once:
```sh
node scripts/sync-resolve-deleted.mjs | awk '/^Added by upstream/ { on = 1; next } on && /^  / { print $1 }' > /tmp/sync-added.txt
git rm -q -f --pathspec-from-file=/tmp/sync-added.txt
```
The script lists only paths under deleted directories. Upstream also adds files for cut surfaces
in kept directories (in the 5cbe82a870 sync: `observability/OtlpEndpointCheck.ts`,
`settings/TelemetryExportSettings.tsx`, `provider/antigravityUsageLimits.ts`, and provider-pi's
`usage.ts`; in the 2a7bd1673c sync: server `outboundHttp.ts` and `zipArchive.ts`, the OTLP
`config.test.ts`, web `sidebar/SidebarUpdateCapsule.tsx` and `settings/DatabaseStorageNotice.tsx`,
and client-runtime `state/threadTranscriptHttp.ts`, which the fork replaced with an RPC); review
`git diff --name-only --diff-filter=A "$MB" "$SHA" -- apps packages` for them. Upstream's
patches for mobile or desktop packages land in `patches/` (2a7bd1673c: `@expo__ui@58.0.18.patch`);
delete any that `pnpm-workspace.yaml`'s `patchedDependencies` does not list. A fork-deleted file
outside those paths that upstream modified (a cut
surface's test or settings panel) is listed as "deleted by fork"; keep it deleted unless the seams
doc says otherwise. An upstream rename out of a deleted directory into a kept one (in this batch,
mobile's `microphonePriority.ts` into `packages/shared`) arrives as an added file with only stage
3; carry it only if a carried surface uses it. The categories
(top-level directories in brackets):

- Auth and pairing (`apps/server/src/auth`, web `components/auth`, client-runtime `authorization`).
- Preview and browser (`apps/server/src/preview`, web `browser`, `components/preview`).
- Device (`apps/server/src/device`, web `components/device`, client-runtime `device`).
- HTTP routes and assets (`apps/server/src/assets`, `http.ts` route files).
- Forgejo, GitHub, Azure DevOps, Bitbucket, and GitCafe (`packages/source-control-*` except core,
  gitlab, and testing).
- Other provider packages (`packages/provider-{acp,acp-registry,cursor,grok,muse,opencode}`,
  `packages/effect-acp`).
- Desktop (`apps/desktop`, `native`, `packaging`, `assets`); mobile (`apps/mobile`); hosted web
  (`apps/marketing`, `apps/server/src/cloud`, web `cloud`, `components/clerk`).
- Relay (`apps/server/src/relay`, `infra`, `packages/ssh`, `packages/tailscale`); telemetry
  (`apps/server/src/{telemetry,resourceTelemetry,usage,diagnostics}`, web `components/usage`).
- Upstream repository tooling (`.github`, `.repos`, `oxlint-plugin-t3code`, `docs/operations`).

Re-derive the list, and update the script's data, when the fork cuts or restores a surface:

```sh
git -c diff.renameLimit=0 diff --no-renames --name-status "$MB" origin/coder-only |
  awk '$1 == "D" { split($2, p, "/"); print (p[1] == "apps" || p[1] == "packages") ? p[1] "/" p[2] : p[1] }' |
  sort | uniq -c | sort -rn
```

## 4. Conflict magnets

- `apps/server/src/server.ts`: upstream's file minus the cut surfaces. Upstream's edits to the
  carried declarations merge; keep their three `Coder:` changes and the export block. Conflicts
  sit in regions the fork deletes (`layerMakeServer`, `layerRuntimeCoreDependencies*`, HTTP,
  auth, preview, and telemetry layers): keep the deletion, and port a new service or provide the
  helper needs into `coderServer.ts`'s matching composition (`CoderRuntimeCoreLive`,
  `CoderRuntimeDependenciesLive`, `CoderRuntimeStartupLive`, or `makeCoderRuntimeLayer`). Export
  a carried declaration only when `coderServer.ts` uses it.
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
  New text that describes a mechanism the fork cut (in dd5c7bd09e, provider update checks
  "fetch model catalog updates", where the catalog is bundled) keeps describing what T3 Coder does.
- **Source-control host definitions.** client-runtime's `sourceControlClients.ts` and the server's
  `sourceControl/sourceControlHostSecrets.ts` register only GitLab's definition. When upstream
  moves host behavior into definitions, delete the fork's per-kind GitLab shims that the GitLab-only
  registry now expresses, and move a remaining GitLab difference into GitLab's definition when the
  field exists for it.

## 6. Mechanical checks after the merge

Before committing the merge, compare each upstream-modified file's `Coder:` marker count with
`$PREV`; a drop must be inside a block upstream deleted, or be a seam that upstream's own
mechanism now expresses (name it in the merge commit body).

```sh
git diff --name-only "$MB" "$SHA" | while IFS= read -r f; do [ -f "$f" ] || continue
  a=$(git show "$PREV:$f" 2>/dev/null | grep -c 'Coder:'); b=$(grep -c 'Coder:' "$f")
  [ "$a" = "$b" ] || echo "$f: $a -> $b"; done
```

Then list lines upstream added in `$MB..$SHA` that the result lacks; each must be a listed seam or
a deleted surface. Use the merged range, never `upstream/main`'s tip (later work shows as losses).

```sh
git diff --name-only --diff-filter=AM "$MB" "$SHA" -- apps packages ':!*.test.*' | while IFS= read -r f; do
  [ -f "$f" ] || continue
  git diff -U0 "$MB" "$SHA" -- "$f" | sed -n 's/^+[[:space:]]*//p' | grep -v '^++ ' | awk 'length > 3' |
    while IFS= read -r line; do grep -qF -- "$line" "$f" || printf '%s: %s\n' "$f" "$line"; done
done
```

Finish with `pnpm knip:check`.

## 7. Verify

In this order, fixing each failure before the next: `pnpm test:coder`; every typecheck listed in
`AGENTS.md`; `pnpm knip:check`; `pnpm build`. Typecheck before the full suite finds most merge
breakage faster. For one file, `pnpm exec vp test run --config vite.coder.config.ts <file>`
covers `apps/server` only; run web, client-runtime, and package tests from the package
directory with `pnpm exec vp test run <file>`.

`pnpm test:coder` exits 0; a failure is real. It stops at the first failing package script, so
fix and rerun until it completes. Known results:

- The suite needs the Node version in upstream's `engines.node` (`^24.13.1` at 2a7bd1673c). On an
  older Node, three upstream tests fail on unmodified upstream code: ProjectionRecovery's "selects
  unfinished recovery work without reading settled thread histories" (`ProjectionStoreSetupError`,
  "malformed JSON") and nodeSqliteClient's "keeps large text and blob parameters off cached
  statements" (node:sqlite binds an ArrayBuffer parameter as NULL) and "checkpoints the WAL on the
  worker instead of the writer" (its SQLite predates 3.51). Check `node -p process.version`
  against `engines.node` before blaming the merge; do not skip them.
- `apps/server/src/serverSettings.test.ts` "follows a settings link that is repointed to another
  directory" and "reloads when a dangling settings link gets its destination" can hit their
  2-second watcher timeout under full-suite load. Rerun it alone:
  `pnpm exec vp test run --config vite.coder.config.ts apps/server/src/serverSettings.test.ts`.

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

9. Update the seams doc's "checked against" SHAs for carried fixes still present upstream, and
   add to this file wherever it fell short during the sync.
