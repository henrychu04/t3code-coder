# T3 Coder

Use the global `karpathy-guidelines` skill for coding, review, and refactoring work.

T3 Coder is a Coder-only fork of T3 Code. A browser talks to a Node gateway bound to
`127.0.0.1`; the gateway talks to authenticated Linux Coder workspaces only through foreground
Coder CLI processes. The workspace helper owns Claude Code, repositories, terminals, Git, SQLite,
projects, threads, sessions, and checkpoints.

Read `docs/internals/coder-only.md` before changing the runtime boundary.

## Non-negotiable boundary

- Keep the local gateway on IPv4 loopback with an ephemeral port, exact Host/Origin checks, no
  CORS, and no application authentication token.
- The installed Coder CLI is the only process allowed to make a non-loopback workspace connection.
  OpenSSH `scp` may be spawned for the versioned helper bootstrap and validated clipboard-image
  uploads only when it uses `coder ssh --stdio` as its ProxyCommand. SCP must never connect directly
  to a workspace. Use argument-array spawning with `shell: false` and include
  `--disable-network-telemetry`, `--disable-direct-connections`, and `--no-version-warning` in every
  underlying Coder invocation.
- User-configured TCP and UDP forwards may use foreground `coder port-forward` processes. Bind every
  local endpoint to `127.0.0.1`, accept structured workspace/protocol/port fields rather than raw
  commands, and stop only the exact child process captured at spawn. Saved forwards may auto-start
  with the gateway; failed forwards must remain stopped until an explicit restart or configuration
  change.
- Coder owns authentication for each configured deployment. Never ask for, read, copy, log, or
  persist Coder tokens.
- The helper runs in the foreground through `coder ssh`, uses newline-delimited RPC over stdio, and
  opens no HTTP, WebSocket, tunnel, forwarded port, or other listener.
- Claude Code exists only in the Linux workspace. Do not probe for or launch a local provider.
- Keep durable application state in the workspace. T3-owned local persistence is limited to
  non-secret deployment URLs, Coder executable paths, workspace targets, structured port-forward
  rules, and ephemeral staging of validated clipboard images in an OS temporary directory. Delete
  staged images immediately after each transfer attempt. Coder 2.25.3 may write tokens only inside
  opaque deployment-specific CLI config directories; T3 must never read them.
- Do not add arbitrary file uploads, downloads, exports, drag-and-drop transfer, clipboard text
  transfer, or background file synchronization. The only user-facing transfer exception is an image
  pasted directly into the message composer. Accept PNG, JPEG, and WebP images only, validate their
  signatures rather than trusting browser metadata, and reject images larger than 20 MiB. Generate
  filenames internally and copy images only into `$HOME/.t3-coder/attachments`; never accept a
  user-controlled local or remote path. The versioned helper bootstrap is the other transfer
  exception.
- Git is repository-local in the workspace. Do not add fetch, pull, push, pull-request, or hosted
  source-control integrations.
- Do not reintroduce Electron, mobile, marketing, hosted web, relay, Tailscale, Cloudflare, Clerk,
  OAuth, telemetry, auto-update, browser preview, WSL, generic user-facing SSH, reverse forwarding,
  arbitrary tunnels, or providers other than Claude. OpenSSH use is limited to helper bootstrap and
  validated clipboard-image uploads through a `coder ssh --stdio` ProxyCommand.
- External markdown links and images remain inert, and terminal URLs must not open automatically.

## Supported platforms

- Local development and testing: macOS.
- Production local host: Windows 11 with the OpenSSH Client feature (`ssh.exe` and `scp.exe`).
- Remote workspace: Linux x86-64 with Nix, Git, Claude Code, and `script(1)`. T3 provisions its
  pinned Node.js 24 runtime through Nix without changing the workspace's default Node.js version.

Use Node platform APIs for local paths and processes. Never assume POSIX paths on the local host.
Remote commands may assume Linux and must quote user-configured values for the shell behavior of
Coder's arguments after `--`.

## Code layout

- `apps/coder-gateway`: loopback HTTP/static server, configuration UI endpoints, and WebSocket to
  helper-stdio bridge.
- `packages/coder-cli`: validated non-secret profiles, Coder command construction, helper install,
  helper connection lifecycle, and foreground port-forward lifecycle.
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
