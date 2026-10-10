# T3 Coder

T3 Coder is a Coder-only browser fork of T3 Code: upstream's projects, threads, review, terminals,
and files for Codex, Claude Code, and Pi running inside Linux Coder workspaces. The local machine is
a corporate Windows 11 laptop with endpoint security, so every boundary below is about what runs
on, listens on, or leaves that machine. Product scope otherwise follows upstream.

Use the global `karpathy-guidelines` skill. Read `docs/internals/coder-only.md` before changing the
runtime boundary or syncing upstream.

## What runs on the laptop

- A Node gateway (`apps/coder-gateway`) listening on one `127.0.0.1` port.
- The installed Coder CLI, which the gateway spawns as foreground child processes.
- A browser the user points at the gateway's loopback URL.
- On disk: the checkout and its build output (the web client and a Linux helper bundle that is
  never run locally), `config.json` and `gateway-port` in the T3 Coder config directory, and
  Coder's own per-deployment `--global-config` directories beside them.
- Nothing else, apart from files the user saves through the browser's own downloads. Attachments
  stream from gateway memory; nothing is staged on disk.
- Hosts: Windows 11 in production, macOS for development; use Node platform APIs for local paths.

## Boundaries

1. The gateway binds IPv4 loopback only, checks the exact Host and Origin, sends no CORS headers,
   has no application token, and reuses its saved port when free.
2. The installed Coder CLI is the only process that leaves the laptop. Spawn it with argument
   arrays, `shell: false`, and `--no-version-warning` on every invocation; no OpenSSH or other client.
3. No relay, Tailscale, Cloudflare, OAuth, Electron, mobile, hosted web, auto-update, T3-owned
   telemetry or trace export, WSL, generic user-facing SSH, reverse forwarding, or arbitrary tunnels.
   The web client contacts no service of its own; linked content (Markdown images and videos, link
   favicons, GitLab avatars) loads from its own host as on upstream.
4. Port forwards are foreground `coder port-forward` processes bound to `127.0.0.1`, built from
   structured fields only; stop only the exact child process captured at spawn.
5. Coder owns authentication: never ask for, read, copy, log, or persist Coder tokens. GitLab and
   provider credentials stay in the workspace. Upstream's agent secret request card stays as is.
6. The workspace helper runs in the foreground over `coder ssh`, speaks newline-delimited RPC over
   stdio, and opens no listener of any kind.
7. Codex, Claude Code, and Pi are the only providers; they exist only in the workspace, and T3
   never probes for or launches a local provider. Carry no other provider driver or package.
8. No provider binary is bundled on the laptop; the Anthropic Agent SDK stays type-only.
9. Durable application state stays in the workspace. Local persistence is limited to non-secret
   deployment URLs, Coder executable paths, workspace targets, port-forward rules, and the last
   gateway port. Browser storage keeps UI preferences, draft text, and upstream's IndexedDB caches;
   never credentials or application bytes.
10. GitLab is the only hosted source-control provider; Git and `glab` run only in the workspace.
11. The branch policy below is part of the boundary.

Product cuts kept on purpose, documented in `docs/internals/coder-only.md`: Files reads and edits
stay inside the verified project root, composer attachments are the only laptop-to-workspace
upload, and upstream's `html_preview` and its headless browser are not carried.

## Provider scope

Codex, Claude Code, and Pi with API-backed usage only, configured in the workspace (Pi's lives in
`~/.pi/agent`). Do not add local credential entry, provider sign-in, subscription dashboards, plan
windows, or account management. Provider readiness, authentication status, context and token usage,
and rate-limit errors stay.

## Branch policy

- `origin/main` is a protected, commit-for-commit mirror of `upstream/main` with no fork commits.
  Only an authorized mirror sync may move it to the verified upstream commit (temporary bypass).
- `coder-only` is the default and integration branch. Every fork change and upstream sync reaches it
  through a pull request; merge `upstream/main` into a branch based on `coder-only` and adapt there.
- Verify a pull request's base branch explicitly before creating or merging it.
- If an upstream sync would remove fork-specific behavior, stop and tell the user first.

## Code layout

- `apps/coder-gateway`: loopback HTTP/static server, configuration UI endpoints, and WebSocket to
  helper-stdio bridge.
- `packages/coder-cli`: validated non-secret profiles, Coder command construction, helper install
  and attachment transfer over `coder ssh` stdin, helper connection lifecycle, and foreground
  port-forward lifecycle.
- `apps/coder-helper`: bundled Linux stdio entry point.
- `apps/server`: workspace-owned orchestration, Codex, Claude, and Pi adapters, persistence, terminal,
  filesystem, and repository-local VCS implementation.
- `apps/web`: browser client and Coder deployment/workspace manager.
- `packages/contracts`, `packages/client-runtime`, `packages/shared`: typed wire and shared runtime
  logic retained by the web/helper pair, including the named byte limits.
- `packages/source-control-core`, `packages/source-control-gitlab`, `packages/source-control-testing`:
  upstream's source-control contracts, the GitLab driver, and its test host.

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
pnpm --filter @t3tools/provider-core --filter @t3tools/provider-pi --filter @t3tools/provider-testing typecheck
pnpm --filter @t3tools/source-control-core --filter @t3tools/source-control-gitlab --filter @t3tools/source-control-testing typecheck
pnpm build
```

Backend boundary changes need focused tests; `apps/coder-gateway/src/boundaryGuard.test.ts` checks
the gateway's URLs, connections, and spawn targets. Do not launch browsers or use computer-control
tooling without explicit user permission. Do not test against or modify `~/.t3/userdata`.

## Working practices

- Upstream is the source of truth for shared product behavior and its docs (`docs/user/` in
  `pingdotgg/t3code`). Port upstream's code rather than re-deriving it, and leave upstream bugs
  unfixed unless they break a boundary above.
- Mark every fork delta in upstream code with a `Coder:` comment and list it in the upstream seams
  of `docs/internals/coder-only.md`; a difference not listed there is drift to remove.
- Keep byte limits as named constants with a one-line reason; docs refer to the constant.
- A fresh worktree has no `node_modules`; when the lockfile is unchanged, run
  `pnpm install --frozen-lockfile` there (it links from the pnpm store and does not duplicate
  packages). Symlinking another worktree's tree is safe only while the lockfiles are identical.
- Prefer `rg`/`rg --files`. Preserve unrelated user changes and avoid destructive Git commands.
- Never kill processes by pattern; stop only a PID captured at spawn.
- Never commit plans, scratch notes, local state, secrets, credentials, or build output, and do
  not create a pull request unless explicitly requested.
