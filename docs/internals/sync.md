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

- `git merge --no-ff --no-commit "$SHA"`.
- Take upstream's version of a file and reapply only the seams the seams doc lists, each marked
  `Coder:` in code. A difference not listed there is drift: remove it.
- Leave upstream bugs unfixed unless they break an `AGENTS.md` boundary.
- If adopting upstream would remove fork behavior the seams doc lists, stop and tell the user.
- To reopen a file resolved wrongly with its conflict markers: `git checkout -m -- <file>`.

## 3. Deleted directories

Upstream files under directories the fork deleted stay deleted, whether upstream modified or added
them. After `git merge` stops, run `node scripts/sync-resolve-deleted.mjs` (or
`pnpm sync:resolve-deleted` when no `package.json` or `pnpm-lock.yaml` is conflicted, since pnpm
checks dependencies before running a script). It `git rm`s each modify/delete conflict under the
paths listed in the script and prints every other conflict and every upstream-added file under
those paths, untouched, for you to decide. It never resolves a content conflict. The categories
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

- `apps/server/src/server.ts`: Coder layer wiring (`CoderRuntimeStartup`, the helper RPC layer,
  the T3 tool bridge). Take upstream's new services and provides; wire them into the Coder layer
  next to their upstream neighbors; drop HTTP, auth, preview, and telemetry layers.
- `apps/server/src/ws.ts`: keep upstream's handler order and add upstream's new handlers; keep the
  fork-only handlers marked `Coder:`. The served group is `CoderWsRpcGroup` (see section 5).
- `apps/web/src/components/ChatView.tsx`: the fork removes preview, device, usage, self-update,
  local editor, feedback, and sidebar-drop code. Take upstream's hunk, then re-delete the hole and
  keep its `Coder:` comment.
- `docs/user/*.md`: take upstream's text, then reapply "merge request", "MR", `!N`, "T3 Coder".
- `knip.jsonc`: keep ours; add or drop `ignoreIssues` entries as `pnpm knip:check` reports.
- `pnpm-lock.yaml`: keep ours (`git checkout --ours pnpm-lock.yaml`), run
  `pnpm install --no-frozen-lockfile` to apply the merged `package.json` files, then confirm
  `pnpm install --frozen-lockfile` passes.

## 5. Seams to re-check on every sync

- **Claude CLI transport.** Every option upstream passes to `query()` must be in `ClaudeAgentSdk.ts`'s
  `SUPPORTED_QUERY_OPTIONS`, and every `Query` method it calls in the seams doc's mapped list; an
  unsupported option fails every Claude turn at runtime only. Read `makeClaudeQueryOptions` and the
  `query({` call: `git diff "$MB" "$SHA" -- apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts apps/server/src/provider/ClaudeProvider.ts`.
  New `Query` calls: `git diff "$MB" "$SHA" -- apps/server/src ':!*.test.*' | grep -E '^\+.*(queryRuntime|\bq)\.[a-zA-Z]+\('`.
  SDK bumps: `git diff "$MB" "$SHA" -- '*package.json' | grep claude-agent-sdk`.
- **Capabilities.** `coderEnvironment.test.ts` fails when upstream adds an
  `ExecutionEnvironmentCapabilities` key; decide it (advertise, or add to
  `CODER_OMITTED_CAPABILITIES` with a reason).
- **RPCs.** List RPCs upstream added to `WsRpcGroup` in the range; serve each in `CoderWsRpcGroup`
  or record why it is omitted:
  ```sh
  rpcs() { git show "$1:packages/contracts/src/rpc.ts" | sed -n '/^export const WsRpcGroup = /,/^);/p' | grep -oE 'Ws[A-Za-z]+Rpc' | sort -u; }
  comm -13 <(rpcs "$MB") <(rpcs "$SHA")
  ```
- **Shared contracts.** Never drop a field the fork does not use. For each contract file upstream
  changed (`git diff --name-only "$MB" "$SHA" -- packages/contracts/src`), every hunk of
  `git diff "$SHA" -- <file>` must be a listed Contracts seam.
- **Always-grant scopes.** `useEnvironmentScope`, `useEnvironmentsWithScope`,
  `readEnvironmentScope` (`apps/web/src/state/session.ts`), `useFilesystemReadAccess`, and
  client-runtime's command permissions still grant everything. New gates:
  `git diff "$MB" "$SHA" -- apps/web/src packages/client-runtime/src | grep -E '^\+.*(EnvironmentScope|EnvironmentsWithScope|FilesystemReadAccess|commandPermissions|RpcPermissionGuard)'`.
- **Wording.** New user-facing strings follow the merge-request wording seam:
  `git diff "$MB" "$SHA" -- apps/web/src packages/client-runtime/src packages/shared/src apps/server/src docs/user ':!*.test.*' | grep -E '^\+.*([Pp]ull [Rr]equest|\bPRs?\b|T3 Code\b)'`.

## 6. Mechanical checks after the merge

Before committing the merge, compare each upstream-modified file's `Coder:` marker count with
`$PREV`; a drop must be inside a block upstream deleted.

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
`AGENTS.md`; `pnpm knip:check`; `pnpm build`.

Known results, which are not fork failures:

- `apps/server/src/storageCleanup.test.ts` "aggregates expired artifacts and rotated logs while
  retaining current logs" fails on macOS (`/var` is a symlink to `/private/var`).
- `apps/server/src/orchestration-v2/ProjectionRecovery.test.ts` "selects unfinished recovery work
  without reading settled thread histories" fails on pure upstream too (`ProjectionStoreSetupError`,
  "malformed JSON").
- `apps/server/src/serverSettings.test.ts` "follows a settings link that is repointed to another
  directory" can hit its 2-second watcher timeout under full-suite load. Rerun it alone:
  `pnpm exec vp test run --config vite.coder.config.ts apps/server/src/serverSettings.test.ts`.

## 8. Land

1. Commit the merge alone: `git commit` with the subject `Merge upstream/main <short sha> into
   coder-only` and a body naming what upstream brought and how conflicts were resolved.
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
