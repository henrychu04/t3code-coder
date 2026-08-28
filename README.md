# T3 Coder

T3 Coder is a browser interface for Claude Code running inside Linux Coder workspaces. The local
computer runs only a loopback Node gateway and the web UI. Repositories, Claude sessions, terminals,
Git operations, checkpoints, and SQLite state stay in the selected Coder workspace.

```text
browser -> 127.0.0.1 gateway -> coder ssh stdio -> workspace helper -> Claude Code
```

This fork intentionally removes the upstream Electron, mobile, hosted-web, relay, OAuth, telemetry,
third-party source-control, and non-Claude provider implementations. It has no general file upload
or download features and does not expose a remote HTTP or WebSocket listener. It can display
signature-validated screenshots produced during a Claude turn through its existing workspace-helper
connection; this requires neither MCP nor changes to a project's verification skill.

## Product-level differences from upstream T3 Code

This is a Coder-only fork, compared with upstream T3 Code at the [shared source base
commit](https://github.com/pingdotgg/t3code/tree/a3a8cbd60539b4af4de8f96c892dbd07a2b6c041).
This is a supported product-level comparison, not a commit-by-commit change ledger; the
[architecture note](./docs/internals/coder-only.md) and [compliance review](./docs/compliance-review.md)
define the complete runtime and policy boundary.

### Removed

- Electron and other native desktop packaging; iOS and Android clients; hosted web, relay,
  Tailscale, Cloudflare, OAuth, Clerk, auto-update, browser preview, and T3-owned telemetry.
- All providers except the workspace-installed Claude Code CLI, plus packaged Agent SDK support,
  MCP servers, and Claude browser integration.
- Generic SSH, direct workspace connections, background workspace daemons, arbitrary tunnels,
  reverse forwards, and non-loopback port-forward binds.
- Arbitrary file transfer: uploads, downloads, exports, drag-and-drop, clipboard text transfer,
  and background synchronization.
- Remote and hosted source-control operations: fetch, pull, push, pull requests, and provider
  integrations.

### Kept

- The browser-based T3 interface, including projects, threads, Claude conversations, terminals,
  repository-local Git status/diffs/branches/worktrees/commits/checkpoints, and permission control.
- Workspace-resident server orchestration, SQLite state, terminal PTYs, and the web terminal assets.
- Review diffs, core keyboard shortcuts, and user-interface preferences stored only in browser memory
  or browser storage as appropriate.

### Introduced

- A local IPv4-loopback gateway and a version-matched Linux workspace helper connected only through
  foreground `coder ssh` stdio; Coder owns authentication and deployment connectivity.
- Coder deployment, workspace, lifecycle, health, latency, and explicit stop/restart/update controls,
  plus structured TCP/UDP forwards that always bind locally to `127.0.0.1`.
- A contained Files surface: validated project-relative paths, 1 MiB text-read/edit limits, binary
  and symlink-escape rejection, stale-write detection, and atomic writes.
- Project/path search, including on-demand bounded content search with IntelliJ-style file masks;
  validated pasted-image delivery; and explicit, bounded display of turn-scoped screenshot artifacts.
- Workspace preflight that verifies Linux x86-64 requirements and provisions the helper's pinned
  Node.js 24 runtime through Nix without changing the workspace's normal Node.js setup.
- Workspace-supported Claude model and mode discovery, project Claude-command discovery, and
  workspace-aware semantic branch and worktree naming.

### Improved for this deployment model

- A deliberately narrow network and data boundary: exact loopback Host/Origin checks, no CORS or
  app token, no helper listener, and no durable local repository, conversation, terminal, or SQLite
  data.
- Safer Coder lifecycle handling: foreground child processes, serialized workspace/forward state,
  reconnect status, and stopping only the exact process that was started.
- A workspace-aware experience: connection diagnostics, health and latency indicators, responsive
  right-panel controls, per-thread scroll restoration, project search, IntelliJ-style shortcuts,
  and screenshot-artifact navigation.
- More resilient long-running work: faster thread switching and resumed-session traffic, bounded
  progressive caches, and typed oversized-diff outcomes that keep review usable instead of failing.
- A smaller, auditable distribution: upstream release, hosting, mobile, relay, native-app, and
  external-integration surfaces have been removed while preserving the core development workflow.

## Requirements

On the local macOS test machine or Windows 11 work computer:

- Node.js 24.10 or newer
- pnpm 11.10
- Coder CLI 2.25.3

Inside each Linux Coder workspace:

- Claude Code, already authenticated
- Git
- Nix with a configured `nixpkgs` and access to its substituters
- the standard Linux `script` utility for terminal PTYs

The workspace's default Node.js version may remain Node 22. On first connection, T3 uses
`nix-env -iA nixpkgs.nodejs_24` with a dedicated profile at `$HOME/.t3-coder/node24` and launches
only the workspace helper through that absolute Node path. The package is reused on later
connections and is not added to the workspace's normal profile or `PATH`.

## Run

```bash
pnpm install --frozen-lockfile --ignore-scripts
npm start
```

The gateway builds the pinned workspace helper and web client, binds to an ephemeral
`127.0.0.1` port, and prints the local URL. Open that URL in an approved browser. Browser launch is
never automatic; `npm run start:open` is an explicit convenience for unrestricted development
machines.

The normal T3 Code interface opens even before a workspace is configured. In Settings, add each
Coder domain and choose **Sign in**. Coder prints its login URL and hidden token prompt in the
terminal running `npm start`; T3 Coder never accepts the token in its browser UI. Then choose **Add
project** in the sidebar, select an authenticated domain and workspace, and navigate to a Linux
folder in the remote folder picker.

Connecting installs the version-matched helper through a
separate Coder SSH stdin operation and then runs it in the foreground over newline-delimited stdio.
Coder owns deployment authentication; the gateway never reads, copies, logs, or writes Coder tokens.
Every Coder invocation disables the CLI's optional network telemetry and direct peer-to-peer
workspace connections. Before installing or starting the helper, the gateway verifies the remote
Linux architecture, provisions and verifies its pinned Node.js runtime through Nix, and checks Git,
Claude Code, `script(1)`, and the state directory.

Refreshing the browser reconnects to the existing foreground helper. If Coder SSH or the helper
exits, the browser's next connection attempt runs preflight and starts a fresh helper.

The local T3 profile is a small JSON file containing only deployment URLs, optional Coder executable
paths, and Coder workspace targets. Project roots and project records stay in workspace SQLite.
UI-only preferences such as theme and panel size may remain in browser storage. Claude sessions,
messages, repository data, terminals, and SQLite state are never persisted locally.

Coder 2.25.3 predates OS-keyring credential storage. To keep two domains signed in, T3 invokes Coder
with a separate `--global-config` directory for each domain. The Coder CLI writes its session token
as plaintext inside that directory; the gateway treats the directory as opaque and never reads it.
Reauthentication repeats the foreground Coder login flow. If corporate policy requires Windows
Credential Manager storage, the installed Coder CLI must be upgraded to 2.29 or newer.

## Security boundary

The local gateway accepts only its exact loopback Host and Origin and sends no CORS headers. It has
no application authentication token by design. Its only non-loopback child transport is the
installed Coder CLI. The workspace helper opens no listening socket.

The helper invokes the workspace-installed `claude` executable directly with streaming JSON over
stdio. This repository does not package Anthropic's Agent SDK. Filesystem and claude.ai MCP servers
are disabled for T3-managed Claude sessions.

Allowed transport paths are:

- browser to the loopback gateway;
- gateway to the configured Coder deployment through `coder ssh`;
- Claude Code to endpoints permitted by the workspace policy.

See [the architecture note](./docs/internals/coder-only.md) for the complete boundary and data
ownership model. [The compliance review](./docs/compliance-review.md),
[security policy](./SECURITY.md), [third-party notices](./THIRD_PARTY_NOTICES.md), and
[CycloneDX SBOM](./docs/sbom.cdx.json) are included for software-intake review.

## Focused verification

```bash
pnpm test:coder
pnpm typecheck:gateway
pnpm typecheck:helper
pnpm typecheck:server
pnpm typecheck:web
pnpm build
```

This is a private-purpose fork of the open-source T3 Code project. Review and obtain approval under
your employer's software, security, data-handling, and open-source policies before using it with
work systems or data.
