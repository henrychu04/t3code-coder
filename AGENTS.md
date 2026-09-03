# T3 Coder

T3 Coder is a browser interface for Codex and Claude Code running inside Linux Coder workspaces. It
keeps the T3 Code product — projects, threads, review, terminals, files — and specializes it for
Coder-managed workspaces, removing upstream's desktop, mobile, hosted-web, relay, telemetry, and
other provider surfaces.

Use the global `karpathy-guidelines` skill for coding, review, and refactoring work.

T3 Coder is a Coder-only fork of T3 Code. A browser talks to a Node gateway bound to
`127.0.0.1`; the gateway talks to authenticated Linux Coder workspaces only through foreground
Coder CLI processes. The workspace helper owns Codex, Claude Code, repositories, terminals, Git,
SQLite, projects, threads, sessions, and checkpoints.

Read `docs/internals/coder-only.md` before changing the runtime boundary.

## Branch policy

- `origin/main` is a protected, commit-for-commit mirror of `upstream/main`. It must point to the
  same commit as `upstream/main`; do not add fork commits, merge commits, or pull requests to it.
- The repository ruleset for `main` rejects every normal update and has no persistent bypass.
  For an explicitly authorized mirror sync, grant a temporary bypass only long enough to move
  `origin/main` to the verified `upstream/main` commit, then remove the bypass immediately.
- `coder-only` is the default and product integration branch. All fork changes and upstream-sync
  adaptations must reach the repository through pull requests targeting `coder-only`.
- Before creating or merging a pull request, verify its base branch explicitly. Never infer the
  target from a repository default or a previous pull request.
- Updating `origin/main` is a mirror operation, not a development push. Only an explicitly
  authorized mirror sync may move it directly to the exact `upstream/main` commit. Merge
  `upstream/main` into a branch based on `coder-only`, resolve Coder adaptations there, and target
  the resulting pull request at `coder-only`.
- If an upstream sync would remove fork-specific behavior, stop and tell the user before making
  that removal.

## Non-negotiable boundary

- Keep the local gateway on IPv4 loopback with an ephemeral port, exact Host/Origin checks, no
  CORS, and no application authentication token.
- The installed Coder CLI is the only process allowed to make a non-loopback workspace connection.
  OpenSSH `scp` may be spawned for the versioned helper bootstrap and validated clipboard-image
  uploads only when it uses `coder ssh --stdio` as its ProxyCommand. SCP must never connect directly
  to a workspace. Use argument-array spawning with `shell: false` and include
  `--no-version-warning` in every underlying Coder invocation. Network telemetry and direct
  workspace connections follow the configured Coder deployment and CLI defaults.
- User-configured TCP and UDP forwards may use foreground `coder port-forward` processes. Bind every
  local endpoint to `127.0.0.1`, accept structured workspace/protocol/port fields rather than raw
  commands, and stop only the exact child process captured at spawn. Saved forwards may auto-start
  with the gateway; failed forwards must remain stopped until an explicit restart or configuration
  change.
- Coder owns authentication for each configured deployment. Never ask for, read, copy, log, or
  persist Coder tokens.
- The helper runs in the foreground through `coder ssh`, uses newline-delimited RPC over stdio, and
  opens no HTTP, WebSocket, tunnel, forwarded port, or other listener.
- Codex and Claude Code exist only in the Linux workspace. Do not probe for or launch a local
  provider.
- Keep durable application state in the workspace. T3-owned local persistence is limited to
  non-secret deployment URLs, Coder executable paths, workspace targets, structured port-forward
  rules, and ephemeral staging of validated clipboard images in an OS temporary directory. Delete
  staged images immediately after each transfer attempt. Coder 2.25.3 may write tokens only inside
  opaque deployment-specific CLI config directories; T3 must never read them.
- Do not add arbitrary file uploads, downloads, exports, drag-and-drop transfer, clipboard text
  transfer, or background file synchronization. The only exceptions are listed below; each is
  scoped to its own mechanism and authorizes nothing beyond it.
  - **Files surface (the only text-file exception).** It may list, read, and edit bounded UTF-8
    text files inside the active project through the existing helper stdio RPC. Accept only
    validated project-relative paths, verify the project root belongs to the requesting thread,
    reject path and symlink escapes and binary files, detect stale writes, and keep open-file and
    editor state in browser memory only. Its explicit Copy path action may place only that
    project-relative path—not file contents or an absolute path—on the local clipboard. Ordinary
    user-initiated reads and edits retain the 1 MiB limit and all existing path, UTF-8, binary-file,
    symlink, and stale-write validation.
  - **Project-content search (the only additional text-content exception).**
    - Filename and path search must continue to use a lightweight path-only FFF index.
    - Content search may use a separate, on-demand, content-enabled `@ff-labs/fff-node` index only
      after verifying that the exact project root belongs to the requesting thread and using the
      verified real project root as FFF's `basePath`. It may use FFF's native plain-text and regex
      grep, but must never scan a filesystem root or home directory.
    - Enforce a hard native search time budget, initially 250 ms per request, cursor-based
      pagination, at most 100 matches per file and 500 returned matches per request, cancellation
      and timeout behavior that cannot monopolize the helper's stdio RPC connection, and a
      15-minute idle TTL followed by deterministic destruction of each content index.
    - Treat every FFF result as untrusted: before exposure, reject absolute paths, traversal, NUL
      bytes, malformed relative paths, and realpath or symlink escapes. Return only validated
      project-relative paths, bounded UTF-8 line snippets, and match ranges; reject or suppress
      binary-file matches and never expose arbitrary file bytes or a general content-reading API.
    - Keep query text, matching contents, absolute paths, and secrets out of errors and logs.
    - The former 2,000-file and 32 MiB aggregate scan limits do not apply once this compliant
      native, time-budgeted search path replaces the existing scanner. Before implementation is
      approved, focused Linux x86-64 tests must characterize FFF's handling of symlinks, binary
      files, oversized files, regex failures, cancellation, and time budgets.
    - This search exception does not authorize uploads, downloads, synchronization, arbitrary file
      reads, or non-Coder workspace connections.
  - **Images: composer paste-in and turn-scoped screenshot artifacts.** Accept PNG, JPEG, and WebP
    images only, validate their signatures rather than trusting metadata, and reject images larger
    than 20 MiB.
    - Pasted images: generate filenames internally and copy only into
      `$HOME/.t3-coder/attachments`; never accept a user-controlled local or remote path.
    - Screenshot artifacts: capture at most 10 images that were created or modified inside the
    active project during a provider turn, or returned as image content by that turn's tool
      results. Copy them to generated paths beneath `$HOME/.t3-coder/artifacts`, expose only opaque
      IDs and metadata in durable activity, and return bytes in bounded chunks over the existing
      helper stdio RPC only after explicit UI expansion. Do not expose arbitrary paths,
      download/export actions, local persistence, or a general file-reading API.
  - **Versioned helper bootstrap.** The remaining transfer exception; see the SCP rule above.
- Git and hosted source-control operations run only in the Linux workspace through the existing
  helper stdio RPC. The helper may run repository-scoped Git fetch, pull, commit, push, clone, and
  remote-management commands, and may invoke the workspace-installed `glab` CLI to discover
  authentication, create or publish repositories, and read, create, update, or check out merge
  requests. Keep the UI and provider registry GitLab-only. GitLab owns authentication; T3 must
  never ask for, read, persist, or log its tokens. Do not add GitHub, Azure DevOps, Bitbucket, or
  another hosted provider, and do not move Git or `glab` execution into the local gateway.
- Do not reintroduce Electron, mobile, marketing, hosted web, relay, Tailscale, Cloudflare, Clerk,
  OAuth, T3-owned telemetry, auto-update, browser preview, WSL, generic user-facing SSH, reverse
  forwarding, arbitrary tunnels, or providers other than Codex and Claude. OpenSSH use is limited
  to helper bootstrap and validated clipboard-image uploads through a `coder ssh --stdio`
  ProxyCommand.
- External markdown links and images remain inert, and terminal URLs must not open automatically.

## Supported platforms

- Local development and testing: macOS.
- Production local host: Windows 11 with the OpenSSH Client feature (`ssh.exe` and `scp.exe`).
- Remote workspace: Linux x86-64 with Nix, Git, and Codex or Claude Code. T3 provisions its pinned
  Node.js 24 runtime through Nix and bundles the native terminal runtime without changing the
  workspace's default Node.js version.

Use Node platform APIs for local paths and processes. Never assume POSIX paths on the local host.
Remote commands may assume Linux and must quote user-configured values for the shell behavior of
Coder's arguments after `--`.

## Code layout

- `apps/coder-gateway`: loopback HTTP/static server, configuration UI endpoints, and WebSocket to
  helper-stdio bridge.
- `packages/coder-cli`: validated non-secret profiles, Coder command construction, helper install,
  helper connection lifecycle, and foreground port-forward lifecycle.
- `apps/coder-helper`: bundled Linux stdio entry point.
- `apps/server`: workspace-owned orchestration, Codex and Claude adapters, persistence, terminal,
  filesystem, and repository-local VCS implementation.
- `apps/web`: browser client and Coder deployment/workspace manager.
- `packages/contracts`, `packages/client-runtime`, `packages/shared`: typed wire and shared runtime
  logic retained by the web/helper pair.

## Verification

Use the smallest relevant checks. Do not run repository-wide legacy suites.

```bash
pnpm test:coder
pnpm typecheck:gateway
pnpm typecheck:helper
pnpm typecheck:server
pnpm typecheck:web
pnpm --filter @t3tools/contracts typecheck
pnpm --filter @t3tools/shared typecheck
pnpm --filter @t3tools/client-runtime typecheck
pnpm --filter @t3tools/coder-cli typecheck
pnpm build
```

Backend boundary changes need focused tests. Do not launch browsers or use computer-control tooling
without explicit user permission. Do not test against or modify `~/.t3/userdata`.

## Working practices

- Prefer `rg`/`rg --files` for discovery.
- Upstream T3 Code's docs (`docs/user/` in `pingdotgg/t3code`) are the source of truth for shared
  product behavior. When documenting product behavior, start from upstream's docs rather than
  re-deriving from code, adapt them to the Coder-only model, and port upstream doc updates when
  they apply.
- Preserve unrelated user changes and avoid destructive Git commands.
- Never kill processes by pattern; stop only a PID captured at spawn.
- Never commit plans, scratch notes, local state, secrets, credentials, or generated build output.
- Do not create a pull request unless explicitly requested.
