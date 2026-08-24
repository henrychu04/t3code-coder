# Coder-only architecture

The Coder-only distribution runs its user interface on the developer's computer and all repository,
Claude, terminal, checkpoint, and durable orchestration work inside Linux Coder workspaces. It does
not use the upstream desktop, relay, Tailscale, hosted web, or direct remote-server connection paths.

## Runtime boundary

The local process is a Node gateway that binds to an ephemeral IPv4 loopback port and serves the web
client to a browser opened by the user. It stores only non-secret Coder deployment URLs, workspace
targets, structured port-forward rules, and an optional Coder executable path. A clipboard image may
be staged temporarily in an OS temporary directory while it is copied to the workspace; the local
copy is deleted immediately after the transfer attempt. Browser UI preferences
such as theme and panel size may use browser storage; messages, drafts, active workspace projections,
and provider sessions are memory-only.
Each active workspace gets one loopback WebSocket that translates frame-delimited browser RPC into
newline-delimited helper RPC; the gateway does not persist those application messages.

For every connected workspace, the gateway starts one foreground process through the authenticated
Coder CLI. The process runs a version-matched helper in the Linux workspace and carries T3's Effect
RPC envelopes as newline-delimited JSON over stdin and stdout. The helper has no HTTP server,
WebSocket server, or other listening socket. Closing the Coder connection stops the helper and any
active turn. Reloading or temporarily disconnecting the browser does not stop the helper; the
gateway keeps it attached and reconnects the loopback WebSocket. If the helper or Coder SSH process
exits, the next browser connection runs preflight again and starts a fresh foreground helper.

Each saved port-forward rule starts a separate foreground `coder port-forward` process. The rule
contains only a configured workspace, TCP or UDP protocol, and validated local and remote ports. The
gateway always supplies `127.0.0.1` as the local bind address. It reports process state to the
settings UI, does not loop on failures, and stops the exact captured process when a rule changes, is
removed, or the gateway exits.

```text
browser -> 127.0.0.1 gateway -> coder ssh stdio -> workspace helper -> claude
local client -> 127.0.0.1:configured port -> coder port-forward -> workspace service
```

The workspace helper owns the existing T3 orchestration store, project records, threads, Claude
sessions, repository-local Git and filesystem operations, terminals, and checkpoints. Its durable
state remains in the workspace. The local gateway does not open or mirror its SQLite file.

The helper starts the workspace-installed `claude` executable directly with argument-array spawning
and streaming JSON over stdin/stdout. No Anthropic Agent SDK package or Claude executable is bundled.
T3 passes an empty strict MCP configuration and disables connected claude.ai MCP servers for every
managed session. Claude's provider connection remains owned by the workspace executable and subject
to workspace policy.

## Authentication

Coder owns deployment authentication. For the supported Coder CLI 2.25.3, the gateway assigns each
deployment an isolated Coder-owned `--global-config` directory, invokes `coder --no-open login
<url>`, and supplies both that config directory and `--url <url>` to every deployment-specific
command. Coder prints its login URL and hidden token prompt in the terminal running T3 Coder. The
gateway never asks for, reads, copies, logs, or writes tokens. Coder 2.25.3 itself stores the session
token as plaintext in the selected config directory; multi-deployment OS-keyring storage is not
available until Coder 2.29.
All generated Coder invocations include `--disable-network-telemetry` and
`--disable-direct-connections`, so the CLI does not send optional network telemetry or establish
peer-to-peer workspace connections. They also include Coder 2.25.3's `--no-version-warning`
because the managed deployment may run a newer fixed server version.

The loopback gateway has no application token. It binds only to `127.0.0.1`, validates the exact
`Host` and `Origin` values for commands and upgrades, exposes no CORS policy, and treats local
processes and managed browser extensions as trusted by the deployment environment.

## Supported hosts

Development is supported on macOS. The production local host is Windows 11 with the OpenSSH Client
feature installed, so local paths and processes must use Node platform APIs and argument-array
spawning with `shell: false`. The initial
workspace target is Linux x86-64. Before installing or launching a helper, the gateway checks the
remote OS and architecture, realizes a Node.js 24 package from the workspace's configured
`nixpkgs` only when that runtime is not already available, and checks Git, Claude Code, `script(1)`,
and the workspace state directory. The helper is launched
with the Nix package's absolute Node path without changing `PATH`, so workspace shells and helper
children retain the workspace's default Node.js version. Platform and protocol versions are then
negotiated before a helper is used.

## Network and transfer constraints

The T3 gateway does not make external HTTP requests. The installed Coder CLI is the only process
allowed to make a non-loopback workspace connection. Structured port-forward rules use foreground
`coder port-forward` processes and bind only to IPv4 loopback; reverse forwarding, arbitrary bind
addresses, and raw tunnel arguments are not exposed. The gateway may invoke OpenSSH `scp` for helper
bootstrap and validated clipboard-image uploads only, with `coder ssh --stdio` as its ProxyCommand.
SCP must not connect directly to a workspace or use authentication outside Coder. The helper opens
no network listener; Claude and user-initiated terminal commands remain subject to workspace policy.

General user-facing file transfer remains disabled. The sole user-facing exception is an image
pasted into the message composer. The browser sends the image only to the loopback gateway. The
gateway accepts signature-validated PNG, JPEG, or WebP content up to 20 MiB, stages it in an OS
temporary directory, and copies it through helper-scoped SCP to a generated path beneath
`$HOME/.t3-coder/attachments`. It then deletes the local staging file and inserts the remote path
into the draft. User-controlled filesystem paths, arbitrary files, downloads, exports,
drag-and-drop, and background synchronization remain prohibited.

Remote uploads must first use a generated temporary filename and then be atomically renamed to
their final generated filename after successful transfer. Failed or incomplete transfers must be
removed. Image bytes, local paths, Coder credentials, and SCP configuration must not be logged.
Any temporary SSH configuration must contain no credentials and must be removed after the transfer.

Source-control UI is limited to repository-local operations such as status, diffs, branches,
worktrees, commits, and checkpoints. Fetch, pull, push, pull-request, and provider-hosted operations
are not exposed by T3.

## Distribution

`npm start` builds the web client and Linux helper from the checked-out source and lockfile, then
starts the local gateway without opening a browser. Connecting never installs from npm or downloads
an application update. The first connection may download the pinned Node.js package through Nix if
it is not already in the workspace's Nix store. On the first connection to a workspace in each local
gateway session, the gateway replaces the remote helper with that locally built bundle through
Coder before starting it in the foreground.
