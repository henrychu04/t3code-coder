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
provider sessions, and screenshot artifact object URLs are memory-only.
Each active workspace accepts one loopback WebSocket at a time. The workspace helper can outlive
that browser connection, so the gateway treats every accepted WebSocket as a distinct RPC session:
it translates browser-local request IDs to helper-lifetime unique IDs, restores the browser IDs on
responses, and interrupts every still-active request when the session detaches. A browser `Eof`
ends only that logical session and is not forwarded to the helper. If interrupted requests do not
terminate within five seconds, the gateway closes the helper instead of retaining unowned work.
The gateway translates frame-delimited browser RPC into newline-delimited helper RPC and does not
persist those application messages.

After the browser requests latency for a connected workspace, the gateway starts one additional
foreground `coder ping` process for that workspace. It parses each pong into an in-memory latest
round-trip value and serves that value only through the loopback gateway. Repeated reads share the
same process. The ping is stopped with the exact workspace connection scope, and an unexpected exit
is retried only when the browser requests latency again.

The header's workspace health card reads Coder's workspace health from `coder list --output json`.
While the card is open, the browser refreshes that health and asks the gateway for workspace-scoped
CPU, memory, and home-disk usage every ten seconds. Each resource sample is a bounded, foreground `coder ssh` invocation of Coder
2.25.3's `coder stat` commands inside the connected workspace. The gateway accepts only Coder's
fixed JSON result shape, never samples the shared host explicitly, and does not run resource polling
while the card is closed.

For every connected workspace, the gateway starts one foreground process through the authenticated
Coder CLI. The process runs a version-matched helper in the Linux workspace and carries T3's Effect
RPC envelopes as newline-delimited JSON over stdin and stdout. The helper has no HTTP server,
WebSocket server, or other listening socket. Closing the Coder connection stops the helper and any
active turn. Reloading or temporarily disconnecting the browser does not stop the helper; the
gateway keeps it attached and reconnects the loopback WebSocket. If the helper or Coder SSH process
exits, the next browser connection runs preflight again and starts a fresh foreground helper.
Shell and thread subscriptions always emit a `synchronized` item between their initial
snapshot/replay and live events. The browser does not negotiate this guarantee: it keeps restored
data in `synchronizing` state until the item arrives and requests a clean connection retry if it is
missing for 15 seconds. These guarantees define helper protocol version 2; older helpers are not
accepted or adapted.

The browser keeps bounded in-memory thread and terminal caches. Terminal attach requests resume
from an event sequence when the helper's bounded replay window still covers the gap, otherwise they
receive a complete capped snapshot. Shell subscriptions coalesce filtered high-frequency activity
into cursor-only watermarks so reconnect cursors advance without reprojecting sidebar rows. Initial
thread snapshots target 512 KiB and older pages target 1 MiB by reducing the requested turn window;
the newest requested turn is always retained, even when that one turn exceeds the target. Older
pages use a unary RPC on the existing workspace connection. Review file snapshots remain bounded
and immutable, use adaptive per-chunk gzip when it reduces bytes, and are fetched only when the diff
renderer asks to expand omitted context; completed contents stay in a bounded browser cache.

T3 reads `coder list --output json` to distinguish stopped, starting, and running workspaces and to
report whether a template update is available. It does not implicitly connect to a stopped
workspace because Coder SSH would start it without an explicit user action. Starting, stopping,
restarting, or updating a workspace first closes its helper and active sessions and stops its saved
port forwards before invoking the corresponding Coder command through the same deployment-specific
CLI profile. A successful start, restart, or update restores the saved forwards and reconnects; a
successful stop leaves the helper and forwards stopped. The browser reports workspace
and port-forward status as unavailable when their status requests fail; it does not leave a request
checking indefinitely or retain a stale running label.

The gateway stores each workspace and saved forward in one tagged lifecycle state held by an Effect
`SynchronizedRef`. Workspace connection and action claims, and port-forward start and stop claims,
are serialized transitions. Duplicate requests for the same workspace action share its result;
conflicting actions are rejected instead of being coalesced into a different command. Process exits
can update only the state that still owns that exact connection, so a late exit cannot overwrite a
newer start, stop, or restart transition.

Each saved port-forward rule starts a separate foreground `coder port-forward` process. The rule
contains only a configured workspace, TCP or UDP protocol, and validated local and remote ports. The
gateway always supplies `127.0.0.1` as the local bind address. It reports process state to the
settings UI, does not loop on failures, and stops the exact captured process when a rule changes, is
removed, or the gateway exits.

```text
browser -> 127.0.0.1 gateway -> coder ssh stdio -> workspace helper -> claude
browser -> 127.0.0.1 gateway -> coder ping -> workspace agent
browser -> 127.0.0.1 gateway -> coder ssh -> coder stat in connected workspace
local client -> 127.0.0.1:configured port -> coder port-forward -> workspace service
```

The workspace helper owns the existing T3 orchestration store, project records, threads, Claude
sessions, repository-local Git and filesystem operations, terminals, and checkpoints. Its durable
state remains in the workspace. Validated screenshot artifacts are also stored in the workspace;
the local gateway does not open or mirror its SQLite file or artifact directory.

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
available until Coder 2.29. Network telemetry and direct workspace connections follow the
configured Coder deployment and CLI defaults. All generated Coder invocations include Coder
2.25.3's `--no-version-warning` because the managed deployment may run a newer fixed server version.

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

General user-facing file transfer remains disabled. One exception is an image pasted into the
message composer. The browser sends the image only to the loopback gateway. The gateway accepts
signature-validated PNG, JPEG, or WebP content up to 20 MiB, stages it in an OS temporary directory,
and copies it through helper-scoped SCP to a generated path beneath
`$HOME/.t3-coder/attachments`. It then deletes the local staging file and inserts the remote path
into the draft.

The other user-facing exception displays screenshots produced while Claude verifies a frontend.
This does not require MCP or a project-specific T3 skill. While a Claude turn is active, the helper
observes image paths created or modified inside that turn's active project and accepts image content
returned directly by tool results. Tool-result images are captured as they arrive; observed paths
are captured when the turn completes. Both paths signature-validate PNG, JPEG, and WebP content,
reject files larger than 20 MiB, deduplicate by content, cap capture at 10 images, and copy accepted
bytes to generated paths beneath `$HOME/.t3-coder/artifacts`. The durable activity event contains
only an opaque artifact ID, display name, MIME type, and byte count; tool-result base64 is removed
before activity and turn history are persisted.

```text
project verification skill -> screenshot in active project --+
Claude image tool result -> in-memory image content -----------+-> validate/dedupe/copy in workspace
                                                                -> metadata-only activity row
user expands Visual artifacts -> opaque-ID chunk RPC -> browser Blob URL -> thumbnail/lightbox
```

The browser initially renders only a collapsed artifact count. Explicitly expanding it requests
bounded 512 KiB chunks by opaque ID over the existing browser-to-helper RPC path. The browser joins
those chunks into memory-only object URLs and revokes them when the view unmounts. The RPC accepts
no filesystem path, the gateway does not persist the bytes, and the UI exposes no download or
export action. The observer ends with the turn and performs no scan or background synchronization.
User-controlled filesystem paths, arbitrary files, downloads, exports, and drag-and-drop remain
prohibited.

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
