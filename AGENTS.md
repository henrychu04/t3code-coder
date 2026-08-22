# T3 Coder

Use the global `karpathy-guidelines` skill for coding, review, and refactoring work.

T3 Coder is a Coder-only fork of T3 Code. A browser talks to a Node gateway bound to
`127.0.0.1`; the gateway talks to authenticated Linux Coder workspaces only through foreground
`coder ssh` stdin/stdout; the workspace helper owns Claude Code, repositories, terminals, Git,
SQLite, projects, threads, sessions, and checkpoints.

Read `docs/internals/coder-only.md` before changing the runtime boundary.

## Non-negotiable boundary

- Keep the local gateway on IPv4 loopback with an ephemeral port, exact Host/Origin checks, no
  CORS, and no application authentication token.
- The only local non-loopback child transport is the installed Coder CLI. Use argument-array
  spawning with `shell: false` and include `--disable-network-telemetry` in every Coder invocation.
- Coder owns authentication for each configured deployment. Never ask for, read, copy, log, or
  persist Coder tokens.
- The helper runs in the foreground through `coder ssh`, uses newline-delimited RPC over stdio, and
  opens no HTTP, WebSocket, tunnel, forwarded port, or other listener.
- Claude Code exists only in the Linux workspace. Do not probe for or launch a local provider.
- Keep durable application state in the workspace. T3-owned local persistence is limited to
  non-secret deployment URLs, Coder executable paths, and workspace targets. Coder 2.25.3 may write
  tokens only inside opaque deployment-specific CLI config directories; T3 must never read them.
- Do not add file uploads, downloads, exports, attachments, drag-and-drop transfer, clipboard-image
  transfer, or background file synchronization. The versioned helper bootstrap over Coder stdin is
  the sole control-plane exception.
- Git is repository-local in the workspace. Do not add fetch, pull, push, pull-request, or hosted
  source-control integrations.
- Do not reintroduce Electron, mobile, marketing, hosted web, relay, Tailscale, Cloudflare, Clerk,
  OAuth, telemetry, auto-update, browser preview, WSL, generic SSH, or providers other than Claude.
- External markdown links and images remain inert, and terminal URLs must not open automatically.

## Supported platforms

- Local development and testing: macOS.
- Production local host: Windows 11.
- Remote workspace: Linux x86-64 with Node.js 24.10+, Git, Claude Code, and `script(1)`.

Use Node platform APIs for local paths and processes. Never assume POSIX paths on the local host.
Remote commands may assume Linux and must quote user-configured values for the shell behavior of
Coder's arguments after `--`.

## Code layout

- `apps/coder-gateway`: loopback HTTP/static server, configuration UI endpoints, and WebSocket to
  helper-stdio bridge.
- `packages/coder-cli`: validated non-secret profiles, Coder command construction, helper install,
  and helper connection lifecycle.
- `apps/coder-helper`: bundled Linux stdio entry point.
- `apps/server`: workspace-owned orchestration, Claude adapter, persistence, terminal, filesystem,
  and repository-local VCS implementation.
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
- Preserve unrelated user changes and avoid destructive Git commands.
- Never kill processes by pattern; stop only a PID captured at spawn.
- Never commit plans, scratch notes, local state, secrets, credentials, or generated build output.
- Do not create a pull request unless explicitly requested.
