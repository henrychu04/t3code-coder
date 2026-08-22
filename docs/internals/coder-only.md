# Coder-only architecture

The Coder-only distribution runs its user interface on the developer's computer and all repository,
Claude, terminal, checkpoint, and durable orchestration work inside Linux Coder workspaces. It does
not use the upstream desktop, relay, Tailscale, hosted web, or direct remote-server connection paths.

## Runtime boundary

The local process is a Node gateway that binds to an ephemeral IPv4 loopback port and serves the web
client to the default browser. It stores only non-secret Coder deployment URLs, workspace targets,
project display names and Linux roots, and an optional Coder executable path. Browser UI preferences
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

```text
browser -> 127.0.0.1 gateway -> coder ssh stdio -> workspace helper -> claude
```

The workspace helper owns the existing T3 orchestration store, project records, threads, Claude
sessions, repository-local Git and filesystem operations, terminals, and checkpoints. Its durable
state remains in the workspace. The local gateway does not open or mirror its SQLite file.

## Authentication

Coder owns deployment authentication. The gateway invokes `coder login <url>` and supplies
`--url <url>` to deployment-specific commands. It never asks for, reads, copies, or persists Coder
tokens. Different deployment URLs can therefore use the credential selection supported by the
installed Coder CLI.
All generated Coder invocations include `--disable-network-telemetry` and
`--disable-direct-connections`, so the CLI does not send optional network telemetry or establish
peer-to-peer workspace connections.

The loopback gateway has no application token. It binds only to `127.0.0.1`, validates the exact
`Host` and `Origin` values for commands and upgrades, exposes no CORS policy, and treats local
processes and managed browser extensions as trusted by the deployment environment.

## Supported hosts

Development is supported on macOS. The production local host is Windows 11, so local paths and
processes must use Node platform APIs and argument-array spawning with `shell: false`. The initial
workspace target is Linux x86-64. Before installing or launching a helper, the gateway checks the
remote OS and architecture, Node.js version, Git, Claude Code, `script(1)`, workspace state
directory, and configured project root. Platform and protocol versions are then negotiated before a
helper is used.

## Network and transfer constraints

The T3 gateway does not make external HTTP requests. Its only non-loopback child transport is the
installed Coder CLI. The helper opens no network listener; Claude and user-initiated terminal
commands remain subject to workspace network policy.

User-facing file transfer is disabled. The distribution does not expose attachments, uploads,
downloads, exports, drag-and-drop, or clipboard-image transfer. Messages, terminal output, and code
diffs necessarily cross the foreground connection for display but are not durably cached locally.
Installing a versioned helper through Coder is a control-plane bootstrap operation, not a file
transfer feature.

Source-control UI is limited to repository-local operations such as status, diffs, branches,
worktrees, commits, and checkpoints. Fetch, pull, push, pull-request, and provider-hosted operations
are not exposed by T3.

## Distribution

`npm start` builds the web client and Linux helper from the checked-out source and lockfile, then
starts the local gateway. Connecting never installs from npm or downloads an update. On the first
connection to a workspace in each local gateway session, the gateway replaces the remote helper
with that locally built bundle through Coder before starting it in the foreground.
