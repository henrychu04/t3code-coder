# T3 Coder

T3 Coder is a browser interface for Claude Code running inside Linux Coder workspaces. The local
computer runs only a loopback Node gateway and the web UI. Repositories, Claude sessions, terminals,
Git operations, checkpoints, and SQLite state stay in the selected Coder workspace.

```text
browser -> 127.0.0.1 gateway -> coder ssh stdio -> workspace helper -> Claude Code
```

This fork intentionally removes the upstream Electron, mobile, hosted-web, relay, OAuth, telemetry,
third-party source-control, and non-Claude provider implementations. It has no file upload or
download features and does not expose a remote HTTP or WebSocket listener.

## Requirements

On the local macOS test machine or Windows 11 work computer:

- Node.js 24.10 or newer
- pnpm 11.10
- Coder CLI 2.25.3

Inside each Linux Coder workspace:

- Claude Code, already authenticated
- Git
- Nix with access to the configured Nix substituters and GitHub
- the standard Linux `script` utility for terminal PTYs

The workspace's default Node.js version may remain Node 22. On first connection, T3 uses Nix to
realize a pinned Node.js 24 package at `$HOME/.t3-coder/node24` and launches only the workspace
helper through that absolute Node path. The package is reused on later connections and is not added
to the workspace profile or `PATH`.

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
