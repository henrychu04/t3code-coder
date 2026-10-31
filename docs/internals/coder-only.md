# How T3 Coder keeps work in Coder

> This is a maintainer and reviewer reference. For the user-facing explanation, start with
> [Coder workspaces](../user/workspaces.md) and [Product decisions and upstream
> differences](../product-differences.md).
> To merge upstream, follow the [upstream sync checklist](sync.md).

T3 Coder runs its browser interface on the developer's computer while repository, Codex, Claude,
Pi, Kilo Code, terminal, checkpoint, and durable orchestration work stays inside Linux Coder workspaces. The
laptop runs only the loopback gateway, the Coder CLI, and a browser; `AGENTS.md` lists the
boundaries, and this document records how the code keeps them and where it departs from upstream.

## Runtime boundary

The local process is a Node gateway that binds to an IPv4 loopback port and serves the web client to
a browser opened by the user. It reuses the port saved in `gateway-port` beside `config.json` when
that port is free, so browser storage keeps one origin across restarts; otherwise it binds an
ephemeral port and saves that. It stores only non-secret Coder deployment URLs, workspace targets,
structured port-forward rules, an optional Coder executable path, and the last gateway port. A
composer attachment stays in gateway memory while it is streamed to the workspace and is never
written to local disk by the gateway. The browser may store and cache what upstream does, except
credentials. Browser UI preferences
such as theme and panel size may use browser storage; as on main, `uiStateStore` keeps sidebar
project expansion, order, and scope, thread visit times, changed-file folder expansion, and the
last merge method there, and session storage holds main's one-reload guard for stale split chunks
(`lib/chunkReloadGuard.ts`). As on main, composer drafts and prompt stashes keep their text,
images, and upload ids in browser storage, and IndexedDB caches each
environment's shell, settled thread snapshots, server config, and full branch lists so a reload
renders before the workspace answers; the workspace remains the source of truth. Open Files tabs and
editor state and provider sessions are memory-only.
Each active workspace accepts one loopback WebSocket at a time. The workspace helper can outlive
that browser connection, so the gateway treats every accepted WebSocket as a distinct RPC session:
it translates browser-local request IDs to helper-lifetime unique IDs, restores the browser IDs on
responses, and interrupts every still-active request when the session detaches. A browser `Eof`
ends only that logical session and is not forwarded to the helper. If interrupted requests do not
terminate within five seconds, the gateway closes the helper instead of retaining unowned work.
The gateway translates frame-delimited browser RPC into newline-delimited helper RPC and does not
persist those application messages. While the helper's stdin is backed up, the gateway stops reading
browser frames until it drains, so a slow helper pushes back instead of growing gateway memory.

The browser estimates workspace latency by timing `server.probe` RPC round-trips over the
workspace's existing WebSocket session, so a sample covers the whole path the user's input takes:
browser, loopback gateway, and workspace helper. Sampling is adaptive — every five seconds per
connected workspace, every second after a high sample until the connection reads fast again — and
pauses while the browser tab is hidden, so no probe traffic occurs in the background. At most one
probe is in flight per workspace. The browser retains the last sample with a stale marker when
probes stop succeeding and shows a slow-connection warning only after consecutive high-latency
samples. The gateway exposes no latency endpoint and starts no ping process of its own.

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
Shell and thread subscriptions use upstream's optional `requestCompletionMarker` negotiation.
The helper advertises `shellResumeCompletionMarker`, `threadResumeCompletionMarker`, and
`threadSnapshotPagination`, and the browser requests the corresponding `synchronized` items.
Restored data stays in `synchronizing` state until the marker arrives, except for upstream's warm
resume behavior: a recently viewed live thread renders its retained snapshot immediately and only
shows synchronization progress if replay changes its contents. The marker follows buffered live
events accumulated during snapshot or replay loading. The browser and helper are built from the
same checkout; helper protocol version 3 remains the transport compatibility fence (version 3 adds
the gateway hub methods; see the linked-environments entry).

Live shell and thread subscriptions are bounded (`LiveStreamBudget.ts`), including batches awaiting
an RPC acknowledgement; overflow detaches that live source, and reconnect uses the existing
snapshot/replay and synchronization marker. Idle thread snapshots follow upstream's resume-snapshot
design with Coder's entry and size cap (`threadRetention.ts`), sized from string lengths so
navigating away never serializes large message bodies. Terminal attaches resume from an event
sequence when the helper's replay window still covers the gap. Thread snapshots and older pages
target bounded encoded sizes but always keep the newest requested turn; older pages use a unary
RPC on the existing connection. Review file snapshots stay in bounded helper memory
(`ReviewService.ts`) and are fetched only when the diff renderer expands omitted context; a file
above the expansion limit returns a typed `tooLarge` outcome rather than an RPC failure. GitLab
merge-request diffs are paged by file below the gateway's `MAX_RPC_MESSAGE_BYTES` frame. Migration
049 stores manual active-thread order in the workspace.

Branch-to-merge-request discovery is workspace-owned. The helper discovers GitLab MR links at
startup, after relevant thread changes, and periodically without an open browser. It uses the
existing repository-scoped GitManager cache and glab-backed MR service, verifies both the
branch and project repository identity before saving, and rejects updates after the lookup inputs
change. Migration 048 adds the branch MR projection independently of explicit links. Migration 050 adds
multiple explicit MR links. Link commands validate
the URL and its host against workspace GitLab metadata at the helper RPC boundary. The helper
refreshes link snapshots and serves linked-thread lookups over the existing stdio connection.
Recent MR summaries are cached beneath the workspace provider-status cache directory. Background summary reads
are upstream's: one merge request detail read each. Settled-thread
backfill has a bounded retry count. Inactivity settlement does not wait for an MR lookup.

Agents reach upstream's T3 toolkits over a workspace file bridge instead of MCP, because work
Claude Code and Codex policies block custom MCP servers. Each provider
session credential from upstream's `McpSessionRegistry` is a private directory under the temporary
directory, named `t3-tools-<hash>` from the environment and thread ids, holding a standalone CLI
(run with the helper's pinned Node runtime) and a read-only tool catalog; no socket, listener, or
MCP server is opened. The CLI writes one request per call into its own call directory,
and the helper runs the named tool through upstream's toolkit handlers with the credential's
thread identity, never one the agent supplies. Plan-mode threads may call only tools upstream marks
read-only. Requests and responses are bounded (`FileBridge.ts`). A call that outlives the inline
budget answers with a `bridge-job:` task id that `task_status` resolves, so long tools never depend
on a provider's shell timeout; the number of such calls per thread and the retention of unread
results are bounded (`T3ToolBridge.ts`). Upstream's lifecycle owns the bridges: credentials are reused across turns and
revoked, which deletes the directory, when the session is released, the thread is archived or
deleted, or the helper stops. The thread's next credential recreates the same directory, so a
command in the agent's history keeps working after its session rotates. Each bridge marks the
directory as its own and, once another helper in the workspace recreates it, stops serving and
leaves it in place. If a bridge cannot be
created, turns run without T3 tools. Workspace processes run as the same OS user; these
directories are not an isolation boundary between mutually untrusted agents.

The bridge carries upstream's orchestrator, thread, project, environment, worktree, pull-request,
and `html_render` toolkits. The pull-request tools accept only merge requests on a GitLab host that a
workspace project uses; project clones go through the same GitLab-only repository service as the
browser. Preview, device, attachment-upload, and `html_preview` toolkits are not carried, and
neither is upstream's MCP HTTP server.

Thread settlement is workspace-owned. The helper's settlement reactor checks persisted workspace
settings at startup, after relevant settings changes, and once per minute, including while no
browser is connected. It resolves saved branches to GitLab merge requests without changing the
checkout and dispatches a guarded internal settlement command through the normal orchestration
engine. The engine rejects settlement if the thread changed after the reactor snapshot or still
has live background work. Clients render the resulting persisted settlement state instead of
deriving it from local timers or merge-request data.

T3 reads `coder list --output json` to distinguish stopped, starting, and running workspaces and to
report whether a template update is available. It does not implicitly connect to a stopped
workspace because Coder SSH would start it without an explicit user action. Starting, stopping,
restarting, or updating a workspace first closes its helper and active sessions and stops its saved
port forwards before invoking the corresponding Coder command through the same deployment-specific
CLI profile. A successful start, restart, or update restores the saved forwards and reconnects; a
successful stop leaves the helper and forwards stopped. The browser reports workspace
and port-forward status as unavailable when their status requests fail; it does not leave a request
checking indefinitely or retain a stale running label.
For an active start build, the browser surfaces Coder's current build deadline as an idle-stop
countdown. It also surfaces `max_deadline`, when present, as the absolute stop required by a template
policy. A stopped or non-start build never exposes either countdown. Status discovery
for starting or temporarily unavailable workspaces backs off from two to thirty seconds and retries
immediately when the browser becomes visible again. Stable workspace status refreshes once per
minute so deadline, health, and template-update state do not remain stale.

The gateway stores each workspace and saved forward in one tagged lifecycle state held by an Effect
`SynchronizedRef`. Workspace connection and action claims, and port-forward start and stop claims,
are serialized transitions. Duplicate requests for the same workspace action share its result;
conflicting actions are rejected instead of being coalesced into a different command. Process exits
can update only the state that still owns that exact connection, so a late exit cannot overwrite a
newer start, stop, or restart transition.

The gateway keeps a bounded number (`MAX_WORKSPACE_DIAGNOSTIC_EVENTS`) of in-memory connection
phase events per workspace for preflight, helper
installation, helper negotiation, connection, and disconnection. Each attempt and phase duration is
visible in Settings and the active phase is shown on the reconnecting screen. This timeline is not
persisted and contains no command output or credentials.

Each saved port-forward rule starts a separate foreground `coder port-forward` process. The rule
contains only a configured workspace, TCP or UDP protocol, and validated local and remote ports. The
gateway always supplies `127.0.0.1` as the local bind address. It reports process state to the
settings UI, does not loop on failures, and stops the exact captured process when a rule changes, is
removed, or the gateway exits.

```text
browser -> 127.0.0.1 gateway -> coder ssh stdio -> workspace helper -> codex / claude
browser -> 127.0.0.1 gateway -> coder ssh stdio -> workspace helper -> git -> Git remote
browser -> 127.0.0.1 gateway -> coder ssh stdio -> workspace helper -> glab -> GitLab
browser -> 127.0.0.1 gateway -> coder ssh -> coder stat in connected workspace
local client -> 127.0.0.1:configured port -> coder port-forward -> workspace service
```

The workspace helper owns the existing T3 orchestration store, project records, threads, provider
sessions, repository-local Git and filesystem operations, terminals, and checkpoints. Its durable
state remains in the workspace. Legacy screenshot artifacts also remain in the workspace;
the local gateway does not open or mirror its SQLite file or artifact directory.

The helper starts workspace-installed provider executables directly with argument-array spawning.
Codex uses its app-server protocol over stdin/stdout; Claude uses streaming JSON over stdin/stdout;
Pi uses its RPC mode (`pi --mode rpc`) over stdin/stdout; Kilo Code speaks ACP over stdin/stdout
(`kilo acp`).
No provider executable or Anthropic Agent SDK runtime is bundled. The Agent SDK is a type-only
development dependency; pnpm's `ignoredOptionalDependencies` keeps its bundled Claude Code
binaries from ever installing, and also skips `@napi-rs/canvas`, pdfjs-dist's Node-only renderer
that the browser PDF viewer never loads, so no native binary lands on the laptop. T3 does not inject its removed
preview MCP server or a local-host transport into Codex. Codex authentication and other
configuration remain workspace-owned and subject to workspace policy, including the MCP servers
and app integrations each provider loads from workspace configuration, as upstream. Each provider
connection remains owned by its workspace executable.
Native context compaction and asynchronous Codex questions use the same provider stdio sessions
and orchestration event stream; they do not introduce another listener or transport. Upstream's
usage/cost dashboard is not carried (remote pricing aggregation and CLI-proxy sources are an
external-data and secret-bearing surface). API-only provider scope is a product rule, not runtime
enforcement: shared provider probes may still report subscription metadata, which is not shown.
The helper also starts repository-scoped Git commands and the workspace-installed `glab`
executable with argument-array spawning and `shell: false` for GitLab source-control operations.
GitLab authentication and network policy remain owned by the workspace CLI; T3 never asks for,
reads, copies, persists, or logs its token.

## Authentication

Coder owns deployment authentication. For the supported Coder CLI 2.25.3, the gateway assigns each
deployment an isolated Coder-owned `--global-config` directory, invokes `coder --no-open login
<url>`, and supplies both that config directory and `--url <url>` to every deployment-specific
command. The directory is keyed by deployment id, so `POST /api/config` rejects a saved
deployment whose URL changed (409); otherwise Coder could send that session to the new host. Coder prints its login URL and hidden token prompt in the terminal running T3 Coder. The
gateway never asks for, reads, copies, logs, or writes tokens. Coder 2.25.3 itself stores the session
token as plaintext in the selected config directory; multi-deployment OS-keyring storage is not
available until Coder 2.29. Network telemetry and direct workspace connections follow the
configured Coder deployment and CLI defaults. All generated Coder invocations include Coder
2.25.3's `--no-version-warning` because the managed deployment may run a newer fixed server version.

The loopback gateway has no application token. It binds only to `127.0.0.1`, validates the exact
`Host` and `Origin` values for commands and upgrades, exposes no CORS policy, and treats local
processes and managed browser extensions as trusted by the deployment environment.

Browser diagnostics stay in DevTools. Filter the Console for `[t3-error]` to see failed RPC
requests and streams, handled command failures, gateway HTTP/network failures, React errors,
and unhandled browser errors/rejections. Reporting is independent of per-action toast handling
and console-suppression options. Entries contain a timestamp, operation, error type, bounded
message and available stack; known credential formats are redacted, and request bodies and
arbitrary error fields are omitted. Repeated observations of the same error object are deduplicated
and normal cancellations are ignored. No diagnostic upload, trace exporter, or saved log file is
created. Errors caught and discarded outside these boundaries cannot be observed automatically.

## Supported hosts

Development is supported on macOS. The production local host is Windows 11, so local paths and
processes must use Node platform APIs and argument-array spawning with `shell: false`; no OpenSSH
client is needed. The initial
workspace target is Linux x86-64. The helper launch is one foreground `coder ssh` session that
first runs the workspace preflight: it checks the remote OS and architecture, realizes a Node.js
24 package from the workspace's configured `nixpkgs` only when that runtime is not already
available (the preflight accepts any Node.js 24, below the root `engines.node` floor the
development suite needs: the server never binds a raw ArrayBuffer, and the SQLite checkpoint
worker falls back to the writer on an older SQLite, so an older 24 is sound in the workspace),
and checks Git, the transfer tools (`tar`, `sha256sum`, `head`), at least one of
Claude Code, Codex, Pi, or Kilo Code, and the workspace state directory. A failed check prints a `T3_CODER_PREFLIGHT_FAILED:` line, which the gateway reports.
The preflight has its own five-minute budget; helper negotiation starts its 60-second budget only
after the launch prints the ready sentinel. As upstream, server settings keep sensitive provider
environment values out of `settings.json` in a `0700` secrets directory in that state directory;
they never leave the workspace. The helper carries its locked Linux x86-64 `node-pty` runtime and
is launched with the Nix package's absolute Node path without changing `PATH`, so workspace shells
and helper children retain the workspace's default Node.js version. Platform and protocol versions
are then negotiated before a helper is used.

## Network and transfer constraints

The gateway makes no external request of its own. The installed Coder CLI is the only local process
that connects to a workspace or deployment; its network telemetry and direct connections follow
the configured deployment and CLI defaults. Structured port-forward rules use foreground
`coder port-forward` processes bound to IPv4 loopback; reverse forwarding, arbitrary bind
addresses, and raw tunnel arguments are not exposed. The helper opens no network listener; Codex,
Claude, Pi, Kilo Code, and user-initiated terminal commands remain subject to workspace policy.

The helper bundle install streams over the stdin of one foreground
`coder ssh <workspace> -- sh -l -c '<command>'` process
(`packages/coder-cli/src/transfer.ts`); no OpenSSH client is involved. Coder 2.25 always allocates
a remote PTY, so the remote command first runs `stty raw -echo` and prints
`T3_CODER_TRANSFER_READY`; only then does the gateway write, and `head -c <size>` reads exactly the
expected byte count because a PTY never delivers end-of-file. The transfer writes a generated
temporary name under `$HOME/.t3-coder/bin`, checks the received size, and renames atomically into
place. The helper bundle travels as a ustar archive built in
Node (Windows has no `tar -c` to stream) and is extracted with `tar -xf`; the workspace shell then
recomputes `hashCoderHelperBundle`'s digest and refuses a mismatch before replacing the helper and
recording `.t3-bundle-sha256`. Failed, damaged, or interrupted transfers are removed by a follow-up
`coder ssh` cleanup. Bytes, local paths, and Coder credentials are never logged, and nothing is
staged on local disk.

`apps/coder-gateway/src/boundaryGuard.test.ts` reads the gateway and coder-cli sources as text and
fails on any non-loopback URL literal, `fetch(`, outbound `node:net`/`tls`/`https` use, child
process import other than `spawn`, spawn target other than an invocation's executable, executable
literal other than `coder`, `open`, `xdg-open`, or `explorer.exe`, or `shell: true`.

Provider version checks are workspace-originated network requests: the helper queries
`registry.npmjs.org` for the latest version of each enabled provider whose installer it can
identify; manual installations are not checked. The workspace setting `enableProviderUpdateChecks`
is on by default; disabling **Settings → Maintenance → Provider update checks** opts that workspace
out. Explicit provider updates run the installation's identified installer inside the workspace.
Versions marked broken or unsupported by the bundled compatibility policy are not offered. The
model manifest and compatibility policy remain bundled-only and are never refreshed over HTTP.

### Composer attachments

Composer attachments are the only laptop-to-workspace upload: an image or file pasted, picked, or
dropped into the message composer or a question answer. They use upstream's upload flow:
`attachments.createUploadUrl` mints a signed upload URL (`assets/AttachmentUpload.ts`), the browser
POSTs the bytes to it with upstream's upload queue, progress, compression, and HEIC decoding
(`heic-to`'s bundled WASM decoder, which the gateway's `wasm-unsafe-eval` script policy allows),
and `attachments.delete` releases an abandoned upload. The gateway serves the URL at
`/api/workspaces/<id>/api/attachments/upload/<token>`: it requires the exact Origin, a
`Content-Length` within `MAX_FORWARDED_UPLOAD_BYTES`, and a connected workspace, then streams the
body to the helper in chunks of `CODER_ASSET_BODY_CHUNK_BYTES` over `coder.writeRequestBody`, each
sent once upstream's upload route has read the previous one (`coderAssets.ts`). The route checks
the token and the exact size and stores upstream's pending-upload name, `pending-<uuid>-<ext>`.
Bytes pass through gateway memory only. Closing the request interrupts the helper's read. The
helper advertises upstream's `attachmentUploads`, `questionAttachments`, and `fileAttachments`
capabilities. Drafts and stashed prompts keep their images and upload ids in browser storage, as
upstream's do. Upstream's data-URL `assets.persistChatAttachments` is not carried (`ws.ts`), and
client-runtime's `state/attachments.ts` keeps `isAssetAttachmentNotFoundFailure` module-private,
because only upstream's mobile app imports it.

As upstream does, the helper claims each pending upload into a thread-scoped copy when it accepts
the message; `AttachmentClaims.ts` reads the staged file once through a no-follow handle at its
exact declared size (and, for images, a matching signature) and writes it exclusively. Files reach
the provider as workspace paths; images are validated again before Codex and Claude read them.
Images Coder stored before upstream's attachment ids (`<uuid>.<ext>`) decode as
`legacy-<uuid>-<ext>` attachments that are never claimable. Sent images and files load back from
upstream's signed attachment URLs for previews, Save, and rewind.

The composer uses upstream's structured context records (`t3-context://v1/<kind>/<id>` links plus
`message.context`) without preview annotations, element captures, or SnapShot frames
(`useComposerContextImport.ts` skips those records when pasting).
`ComposerAttachmentStrip.tsx`'s media row has upstream's image and video tiles without SnapShot
frames, and `TimelineUserMessageRow.tsx`'s message media (#27306) has none either. The work log
uses upstream's client-runtime presentation without provider tool sources, favicons, logos, or
native app icons. File chip icons and size tooltips use upstream's `filesystem.getMetadata`, which
stats absolute workspace paths and reads at most 512 header bytes of an extensionless file to name
its type; it returns no contents.

### Files and search

The Files surface, filename search, and content search are upstream's. Project files are read and
written relative to the project root, and absolute or `~/` paths read host files in the workspace
as upstream does (#20950); writes stay inside a known workspace with upstream's git-folder
refusal, and reads stop at upstream's 1 MiB. Open files and editor state stay in browser memory.
A folder listing returns at most `MAX_PROJECT_DIRECTORY_ENTRIES` children, because a helper reply
larger than the stdio frame ends the helper connection. Content search needs no extra cap: fff
truncates each matched line to 512 bytes and upstream caps a search at 500 matches.

`filesystem.getMetadata`, which file chips use for their icons and size tooltips, is served as
upstream has it: it takes absolute workspace paths (or `~/` paths) with no thread or project-root
check, reads only `stat` plus a header sniff of at most 512 bytes for a file without an extension,
and never returns file contents.

### Media and document previews

Media, documents, and attachments load from upstream's signed asset URLs: `assets.createUrl`,
`assets/AssetAccess.ts`, `assets/MediaFile.ts`, and upstream's asset route (`http.ts`, which
carries only that route; `auth/utils.ts` carries only upstream's token signing helpers, because
upstream's HTTP session auth is not carried). Native app icons (upstream's resolver answers only on macOS) are
not carried, so that resource kind is cut from `contracts/assets.ts`. Upstream's source control
media resource (`SOURCE_CONTROL_MEDIA_ASSET`, with `sourceControlMediaResponse.ts`) is carried for
GitLab's Markdown uploads, which GitLab serves only to a signed-in session: the browser asks for a
signed URL, and the workspace reads the upload through GitLab's API with `glab` (see
[Upstream seams](#upstream-seams)), so only the bytes reach the laptop. Project favicons are upstream's: `ProjectFaviconResolver` with
`T3ProjectFileLoader`, the favicon URL atoms and IndexedDB image cache, and Settings → Project's
file picker, without the desktop-only picker for files outside the project. For the same reason
`shared/projectFavicon.ts` keeps `PROJECT_FAVICON_EXTENSIONS` module-private, and
`shared/t3ProjectFile.ts` drops `buildT3ProjectFileJsonSchema`, which only upstream's marketing
site uses.

The gateway serves a workspace's asset URLs at `/api/workspaces/<id>/api/assets/*`
(`apps/coder-gateway/src/assetProxy.ts`). It forwards `GET` and `HEAD`, with only `Range` and
`If-Range`, over the helper's gateway-only `coder.serveAsset` stream (`coderAssets.ts`), which runs
upstream's route in process and returns its status, an allowlist of its headers (type, length,
range, disposition, caching, validators, and its document CSP), and the body in acknowledged chunks
of at most `CODER_ASSET_BODY_CHUNK_BYTES`. It answers 503 unless the workspace is already connected,
so an asset request never starts a connection. A closed request interrupts the read; the RPC bridge
rejects the method from the browser. Responses keep upstream's caching (`private, max-age=3600`,
and `no-store` for video and audio).

A workspace's `httpBaseUrl` is that gateway path, and client-runtime's `resolveAssetUrl` resolves
upstream's root-relative URL below it (`Coder:`). External web images and videos load from their
host as on main. The gateway page CSP allows `https:`/`http:` and `blob:` in `img-src`,
`media-src`, and `connect-src`, keeps `script-src` to the app, and allows `frame-src 'self' blob:`
and `object-src 'self' blob:` for upstream's sandboxed HTML frames and PDF embeds.

### Source control

Git action control and merge-request detail are upstream's with a GitLab-only provider registry.
Repository status, fetch, pull, commit, push, publishing, merge-request creation, and checkout run
in the workspace over helper RPC, using repository-scoped Git and the workspace `glab`. GitLab
writes are attempted as upstream does, with no write-access pre-check; a write that workspace policy
blocks fails like any other `glab` error. Generated commit and MR
text comes from the workspace Claude CLI. A review guide checks the merge request's head out into
a temporary worktree under the workspace worktrees directory, which the writer model reads
read-only and T3 removes when the run ends. The gateway never runs Git or `glab`, never connects to
GitLab, and receives no GitLab credentials.

## Fixed settings metadata

Settings parity uses two bounded metadata reads in the Linux helper. `projects.getConfig` accepts
only a project ID, resolves an active project through the projection query, and reads the fixed
`t3.json` file at its real root (bounded by `PROJECT_CONFIG_MAX_BYTES`). It returns only decoded script fields, checkout
mode, and worktree submodule mode, or a missing/invalid/unavailable status. The browser uses the
same read to show `t3.json` as a settings tier; new worktrees read the checkout's own `t3.json`
through the same bounded, symlink-checked reader. It accepts no caller path, returns no raw file, and
never logs parser input or file contents. Importing an action remains an explicit settings write.

Workspace themes come only from `<stateDir>/themes/*.json`. The helper examines a bounded number of
candidate files, each and in total bounded in size (`environmentTheme.ts`). Reads reject symlinks, non-regular
files, invalid UTF-8, NUL bytes, and oversized files, and bind the opened file to the expected
directory. A symlinked theme directory is rejected. Reserved theme IDs and invalid or colorless
files are skipped. The watcher is scoped to the helper lifecycle; a sequenced, bounded publication
stream prevents stale changes from overwriting a reconnect snapshot. Only decoded theme metadata
travels over the existing server-config stdio stream. It introduces no listener, general file API,
local file transfer, credential handling, or telemetry.

## Upstream seams

Shared product subsystems are upstream's code with the Coder deltas below layered on top. When
syncing, take upstream's version of these files and reapply only these seams; a difference not
listed here is drift to remove rather than fork behavior to keep.

- **Primary environment.** `state/primaryEnvironment.ts` makes upstream's
  `primaryEnvironmentIdAtom` the active workspace: the first workspace to send its welcome. Upstream's
  `primaryServer*Atom`s, `usePrimaryEnvironmentId`, and `usePrimaryEnvironment` then work unchanged,
  so keybindings, primary settings, providers, the app title, and environment themes follow that
  workspace. Because the welcome picks the primary, `__root.tsx`'s `EventRouter` reads welcome
  events per workspace, while upstream's primary-only `startKeybindingsUpdateToasts` reports
  keybinding reloads. There is no available-editors atom, and the hosted-app case
  of `usePrimarySettingsAvailable` does not exist.
- **Transport and RPC handlers.** `ws.ts`, `server.ts`, and `serverRuntimeStartup.ts` keep
  upstream's paths, and so do client-runtime's `threadSnapshotHttp.ts` and `shellSnapshotHttp.ts`,
  whose loaders use helper stdio rather than HTTP. `ws.ts` and `server.ts` are upstream's files
  minus the cut surfaces, with the differences below marked in place; the fork's own handlers and
  layers live in `coderWs.ts` and `coderServer.ts`. `ws.ts` keeps upstream's `layerWsRpc`,
  handler order, and helper order, builds the upstream methods it carries over the gateway's
  stdio bridge, and returns them merged with `coderWs.ts`'s handlers at one hook as
  `CoderWsRpcGroup`. Upstream's split into two disjoint handler groups, which keeps the layer's
  requirements typed, splits the whole `CoderWsRpcGroup`, fork-only methods included. `server.ts` keeps upstream's declarations for the layers the helper uses and
  exports them at one hook to `coderServer.ts`, whose `makeCoderRuntimeLayer` composes the helper
  runtime: the Coder provider and orchestration layers, `CoderRuntimeStartup`, `StorageCleanup`,
  `DatabaseStorage`, the T3 tool bridge binding, and the RPC layer. In `server.ts`, settings also
  provide the secret
  store, the VCS status broadcaster takes the demand-only background policy, and the terminal
  shares its PTY adapter and process runner with no port scanner or native telemetry. Bootstrap preparation,
  setup activities, cancellation, archive cleanup, clone identity refresh, MR sync-key resolution,
  and `server:` command IDs follow upstream, including its behavior of preserving a worktree
  after a non-cancel bootstrap failure. Reapply only these differences, each marked `Coder:` in
  code (see [Runtime boundary](#runtime-boundary)):
  - No HTTP/WebSocket listener, auth/session scopes, pairing, relay, client-origin attribution,
    analytics, RPC metrics, or trace export; with no session scopes, scheduled task lists show
    every webhook URL. Upstream's span annotations stay; with no tracer they export nothing. The helper's RPC server uses upstream's
    `WS_RPC_SERVER_OPTIONS`, so a handler defect fails only its own request rather than every
    request on the stdio connection. `observability/DefectReporter.ts` logs those defects as
    upstream does, and the helper sends Effect logs to stderr so they never reach the NDJSON
    stdout. The launch discards that stderr (`2>/dev/null`, because Coder's remote PTY merges it
    into stdout), so handler defects are not observable; T3 keeps no log file. `CoderRuntimeStartup` completes before the RPC
    layer is built, replacing upstream's startup command queue, so commands, launches, and project
    mutations run directly. It keeps upstream's recovery order (provider runtimes, then
    `recoverDelegatedTasks`), and `coderServer.ts` starts upstream's delegated-task question
    reactor with the other workers. Lifecycle welcome/ready events
    are synthesized from workspace projections rather than a startup publisher.
  - Config comes from the Coder environment descriptor and omits auth, editors, device hosts,
    remote open targets, telemetry, model-manifest refreshes, usage-limit sources, and upstream's
    `lastEventLoopStall` (`observability/EventLoopMonitor.ts` is not carried, so neither is the
    web's host-freeze toast). A failed
    keybinding-config load falls back to defaults instead of failing the config read. Config updates use upstream's full `providerStatuses` events and gated
    environment themes; subscriptions do not force a provider refresh.
  - `persistence/DatabaseStorage.ts` keeps upstream's background history compaction and
    incremental-vacuum reclaim, built beside `StorageCleanup` once startup completes. Its
    file-size status, which tells the user to run `t3 doctor`, is not carried because the helper
    has no CLI: `server.getDatabaseStorage` is omitted from `CoderWsRpcGroup`, `databaseStorage`
    is in `CODER_OMITTED_CAPABILITIES`, and Settings → Maintenance has no database notice
    (upstream's `DatabaseStorageNotice` and client-runtime's `databaseStorage` atom are not
    carried). Upstream's `persistence/DatabaseMaintenance.ts`, which only `t3 doctor` uses, is
    not carried either, so `orchestration-v2/messageSearchIndex.ts`'s `rebuildMessageSearch` has
    no caller (`knip.jsonc` ignores it); migration 069's backfill and triggers keep the index.
  - Upstream's idle Claude compaction worker (`layerIdleCompactionWorker`) runs in
    `CoderRuntimeCoreLive`. `coderServer.ts`'s `CoderProviderRegistryLive` gives
    `ProviderRegistry` the provider support layer, which upstream's registry now reads for
    `ProviderLatestVersions`.
  - Shell/thread streams, replay validation, live-event budgets and coalescing, and completion-marker
    negotiation follow upstream. `coderEnvironment.ts` advertises upstream's environment
    capabilities and orchestration protocol version except the cut surfaces listed with a reason
    in `CODER_OMITTED_CAPABILITIES` (usage dashboards, server self-update, desktop app update,
    relay activity publishing, server browser, native stack actions, the database storage
    status, and ignored-file listing). `coderEnvironment.test.ts`
    fails when a key of `ExecutionEnvironmentCapabilities` is in neither list, so a sync that adds
    a capability must decide it. The worktree-location setting describes a workspace path. Coder replaces HTTP thread snapshot
    loading with `orchestration.getThreadSnapshot` over stdio. Initial snapshots and older pages
    retain `targetBytes` budgeting and the newest requested turn. Shell and thread snapshots
    that exceed the stdio frame bound fail before transport encoding. Shell snapshot loading
    uses upstream's socket fallback because no HTTP shell loader exists.
  - GitLab uses the workspace's `glab` login without upstream's viewer routing credentials
    (`withPullRequestViewer` is an identity in `ws.ts`).
  - `workspace/WorkspaceFileSystem.ts`, `WorkspaceEntries.ts`, and `WorkspaceSearchIndex.ts` are
    upstream's, except that a folder listing returns at most `MAX_PROJECT_DIRECTORY_ENTRIES`
    children (see [Files and search](#files-and-search)).
  - Upstream's "Add to another machine" (#22180, #22254) is not carried, because it copies a
    project's ignored files, such as `.env`, from one workspace to another through the laptop
    browser. `WorkspaceEntries` has no `listIgnoredFiles`, `ws.ts` serves no
    `projects.listIgnoredFiles` (`ignoredFileListing` is in `CODER_OMITTED_CAPABILITIES`),
    client-runtime's `projectCommands.ts` has no matching command, `BranchToolbar.tsx` has no
    menu entry (`BranchToolbar.logic.ts` has no `ADD_TO_MACHINE_LABEL_CLASS`), and `ChatView.tsx`
    shows no file-copy banner or send block.
  - Coder-only methods live in `coderWs.ts` (`CODER_WS_METHODS`): local ref status, managed
    branch/worktree rename with `moveWorktree`, chunked review files, the gateway's asset
    stream (`coder.serveAsset`), fixed project-config reads, merge-request diffs, and upstream's HTTP bounded thread snapshot,
    history page, and thread transcript over stdio. Their payloads carry the HTTP query's
    `view` (including `work`) and a boolean `deferWork` in place of `deferWork=1`; the history
    page calls upstream's `getThreadHistoryPage` as the route does, and the stdio payloads omit
    `compactIds`. The method set stays `CoderWsRpcGroup`;
    unsupported upstream methods stay omitted. Upstream's thread-family, worktree-thread-id, and
    older-settled-thread reads (`WsOrchestrationV2GetThreadFamilyRpc`,
    `WsOrchestrationV2GetWorktreeThreadIdsRpc`, `WsOrchestrationV2GetOlderSettledThreadsRpc`) are
    served as upstream's handlers; `WsGuestShareCreateRpc` is omitted (see the guest-sharing cut),
    as are the four `WsPeerLinks*` RPCs (see the linked-environments entry),
    `WsServerPrepareTriageRpc` (see the triage cut), and `WsPreviewStopLocalServerRpc` (see the
    dev-servers cut).
  - Guest thread sharing (#24104) is not carried: guests reach a share over upstream's server HTTP
    routes and T3 Connect, neither of which exists here. `apps/server/src/guest/**`, its HTTP
    route, the share RPC handler, web `components/guest/**`, `routes/guest.tsx`, `guestPage.ts`,
    the share controls, menu and palette entries (the "share-guest" thread action in
    `threadActionMenu.logic.ts`, `useThreadActionMenu.ts`, `Sidebar.tsx`, and its `user-plus` icon
    in `contextMenuFallback.ts`), the guest-message footer and bubbles
    (`ChatView.tsx`'s timeline footer, `TimelineUserMessageRow.tsx`, and `QueuedRunsControl.tsx`,
    which has no guest names or per-item `editable` flag), the sidebar's guest-request pill and
    badge (`Sidebar.logic.ts`, `SidebarThreadRow.tsx`), Labs' Beta section with its guest-links row
    (`LabsSettingsPanel.tsx`),
    `mainAppLocation.ts`'s guest page, and the `--guest*` CSS tokens are cut.
    `runtimeLayer.ts` provides no `GuestShareService`. The contracts and upstream's
    orchestration-v2 guest decider, commands, and projection columns stay, because the contract
    unions need them (`knip.jsonc` ignores their unused exports); with no service nothing creates
    a share, so the sidebar `"request"` status and its notification title never fire.
    Guests' screenshots (#26323) are not carried either: `ChatMarkdown.tsx` has no
    `HostImageUrlContext` or `hostImageUrl.ts` (workspace images load through the workspace asset
    route), and `SidebarThreadRow.tsx`'s `TOP_STATUS_ICONS` has no guest `request` entry.
  - Linked environments (#16653–#17130) are carried between Coder workspaces through the gateway
    hub instead of server-to-server HTTP `/mcp` and pairing, which would break `AGENTS.md`
    boundaries 2, 3, and 6. Upstream's `peer/PeerForwarding.ts` and `peer/RemoteDelegation.ts`,
    `mcp/linkOrigin.ts` and its fence, `McpToolAccess`'s forwarding of every tool that takes
    `environmentId`, `McpInvocationContext`'s linked caller, `delegate_task`'s remote branch,
    `ThreadLaunchService`'s `linkOrigin`/`delegatedFrom`, `ThreadManagementService`'s remote stop,
    `ProjectionStore`'s `getOpenRemoteDelegatedTasks`, `t3_environment_links`, the Labs
    "Linked environments" switch, and the linked-machine orchestration instructions are upstream's.
    The transport is one seam: `peer/PeerMcpClient.ts` and `peer/PeerLinks.ts` keep upstream's
    service tags but send calls and read links through `coderHub.ts`, the helper's side of the hub
    (helper protocol v3: `coder.hub.outbox`, `coder.hub.reply`, `coder.hub.invoke` in
    `packages/coder-cli/src/rpc.ts`). The gateway (`apps/coder-gateway/src/hub.ts`) holds each
    v3 helper's outbox open, checks the requester's workspace link rule (`workspaceLinks` in the
    gateway config, edited in Connections' "Linked workspaces" section,
    `WorkspaceLinkSettings.tsx`), runs the call on the target workspace's helper with
    `coder.hub.invoke` as that link's caller (`sessionId` `coder-link:<rule id>`, the rule's access,
    the calling agent's modes as `narrowedTo`), and replies; the browser bridge refuses the hub
    methods. A workspace that is not connected is unreachable (`orchestration_error`, including a
    linked workspace that has not connected since the gateway started), and upstream's follower
    retries; a call with no matching rule is refused for good (`capability_denied`). Editing a
    rule's endpoints mints a new rule id, since the id is the origin the fence compares.
    Differences, each marked `Coder:`: no `T3-Mode-Limit` header (the hub carries the limits);
    `PeerLinks` has no pairing, storage, or expiry (`expiresAt` is a fixed far-future value);
    `t3_environment_link`, `t3_environment_unlink`, `PeerLinkRequests`, the link-request card, and
    the `WsPeerLinks*` handlers are not carried, so `t3_environment_links`' `notListed` and the
    orchestration instructions point to the Links settings; `coder.hub.invoke` refuses calls while
    Labs' switch is off, as upstream's `/mcp` does, with upstream `PeerMcpClient`'s non-final
    `orchestration_error` so a running task resumes once the switch is on again; `T3ToolBridge`'s binding gains `invoke` for a
    linked caller; and upstream's peer tests (`PeerForwarding.test.ts`, `RemoteDelegation.test.ts`,
    `linkOrigin.test.ts`, `PeerLinks.testkit.ts`) are not carried because they pair two HTTP
    servers; `coderHub.test.ts` and the gateway's `hub.test.ts` test the transport. Migrations 070
    and 071 keep their IDs and create nothing; 072's index stays. `peerLinks` and `linkFence` are
    advertised; `mcpModeLimitHeader` is in `CODER_OMITTED_CAPABILITIES`. Remote-task lineage from
    `remoteChild` and `delegatedFrom` (the task row, the delegated thread's parent link and "From"
    badge, the sidebar's tasks under their parent, and subagent request flags across
    environments) is upstream's. Still cut in the clients: web `EnvironmentContextChip.tsx`,
    `chat/LinkRequestCard.tsx`, `settings/LinkAccessPicker.tsx`, `LinkMachineSelect.tsx`,
    `LinkedEnvironmentsSettings.tsx`, `state/peerLinks.ts`, `state/peerPairingCode.ts`;
    client-runtime `linkRequest.ts`, `state/peerLinks.ts`, `state/peerPairingCode.ts` and their
    exports; the `@` machine menu items and machine chips in the composer and drafts
    (`useComposerMenuItems.ts`, `ComposerCommandMenu.tsx`, `composerThreadItems.ts`,
    `composerDraftStore.ts`, `composerContextRecords.ts`, `composerContextPresentation.tsx`,
    `composerContextUndo.ts`, `contextChipAccents.ts`, `ContextChip.tsx`, `useComposerSend.ts`,
    `chatViewSend.ts`, `useQueuedRunEdit.ts`); the link-request timeline
    card (`TimelineV2EventRow.tsx`, `session-logic.ts`); and the `t3_environment_link`/`unlink`
    tool presentations (`t3McpToolPresentation.ts`, `t3ToolSummary.ts`). The contract's
    `environment` record kind keeps upstream's definition in `contextPresentationRegistry.ts` and
    an unavailable-chip handler in `UserMessageContextChips.tsx`, because both registries require
    every contract kind; shared `composerContextReferences.ts` parses it as upstream does.
    `threadShell.test.ts`'s linked-task case drops upstream's switched-off parent step, since
    environments have no per-environment switch here.
  - In-app triage (#22753) is not carried: it clones upstream T3 Code's source into the server's
    cache and starts an agent to help file an upstream issue, which T3 Coder bugs are not.
    `apps/server/src/triage/**`, its layer in `server.ts`, and the `server.prepareTriage` handler
    are cut; `triage` is in `CODER_OMITTED_CAPABILITIES`. Its contracts stay. In the web client,
    `hooks/useStartTriage.ts`, `lib/triageTarget.ts`, `chat/TriageDraftHero.tsx`, the palette's
    "Triage an issue" entry (`CommandPalette.tsx`), the triage draft hero
    (`DraftHeroHeadline.tsx`), `useHandleNewThread`'s `prompt` option (only triage passes it),
    client-runtime's `prepareTriage`, and `docs/user/triage.md` are cut.
  - Secret providers (#25709, #27044) are not carried: provider credentials stay in the
    workspace's own configuration, and the fork adds no credential entry. Web
    `settings/SecretsSettings.tsx`, `SecretProviderDialog*`, the `/settings/secrets` route, its
    nav and search entries, the `T3CODE_FEATURE_SECRETS` flag, and `OnePasswordIcon` are cut.
    Contracts, shared `serverSettings.ts`, and the server's `secretProviders` write check and
    `secretProviderSettings` capability stay as upstream's. Provider environment variables that
    point at a secret provider (#27115) are cut the same way: contracts keep upstream's
    `SecretReference` value, `ResolvedProviderInstanceEnvironment`, and `reloadSecrets`, and the
    server keeps upstream's registry code around a stand-in resolver,
    `secrets/coderSecretResolver.ts`, in place of `@t3tools/secret-provider-core` and the
    server's `secrets/SecretResolver.ts` and `secretProviderDefinitions.ts`. It reads no
    reference, so a variable that points at one makes its instance unavailable with upstream's
    "Could not read …" reason, and it lists no kind, so `serverSettings.ts` rejects every
    `secretProviders` write as an unsupported kind and keeps every stored config from clients
    (`serverSettings.test.ts` expects 1Password's config withheld too).
    `ProviderInstanceRegistry.ts`, its test, `ProviderInstanceRegistryHydration.ts` (which
    also needs no `Crypto`), and `serverSettings.ts` import the stand-in; `ws.ts` does not
    advertise `secretReferences`. Web `settings/SecretSourceInput.tsx` and its browser test are
    cut, and `ProviderSettingsPanel.tsx` reads no secret sources for `AddProviderInstanceDialog`;
    `ProviderInstanceCard.tsx`'s environment field rows keep the plain value and `SecretInput`,
    showing a stored secret reference as no value. #27746's web side (`ProviderSettingsForm.tsx`'s
    secret-source control for `SettingsSecretValue` fields) is not carried; such a field keeps
    `SecretInput`.
  - The thread dev-servers panel (#22542) is not carried: it lists and stops servers that
    upstream's preview `PortScanner` discovers, and the browser preview is not carried.
    `ClaudeAdapterV2.ts`'s query runner gives the CLI's jobs no agent-thread variable and counts
    no agent for port discovery, so it and `ProviderInstanceRegistryHydration.ts` need no
    `PortDiscovery`; the `preview.stopLocalServer` handler is cut, and `localServerStop` is in
    `CODER_OMITTED_CAPABILITIES`. Web `chat/ThreadServersPanel.tsx`, its `ThreadDetailsPanel.tsx`
    section, and its `thread-sidebar.md` paragraph are cut.
  - The `@` picker lists no threads on linked machines (#26201): `composerThreadItems.ts`, shared
    `composerContextReferences.ts` (`threadContextsOutsideEnvironment`), and the composer hooks keep the
    same-server rules from before #26201. Copy thread (#26202) is upstream's.
  - F6 workspace navigation (#25877) is upstream's without the desktop menu-action forwarding in
    `AppSidebarLayout.tsx`; the Merge requests page's area is labelled "Merge requests"
    (`PullRequestsColumn.tsx`). `ui/standalone-page.tsx`'s wordmark (#25281) reads "T3 Coder".
    `QueuedRunsControl.tsx` (#26159) says "Sent by T3 Coder" and shows no guest name or border.
    The replay provider (#26207) has no `DevReplayHost.tsx`, `__root.tsx` mount, or `window.t3dev`
    type. `SidebarChrome.tsx`'s logo link is named "T3 Coder home" (#24209).
  - Desktop back/forward buttons and swipe navigation (#27430) are not carried:
    `HistorySwipeNavigation.tsx`, `navigationHistory.ts`, and their `AppSidebarLayout.tsx` and
    `SidebarChrome.tsx` hunks are cut.
  - `ws.ts` strips workspace snapshots from provider config when a client asks for them on demand
    (`workspaceSnapshotsOnDemand`) without upstream's usage-limit commands, and
    `coderEnvironment.ts` advertises `providerWorkspaceSnapshotsOnDemand`.
  - Office document text for provider input (#21358) runs upstream's `DocumentText.ts` worker in a
    child process of the helper's own entry point: `apps/coder-helper/src/bin.ts` dispatches
    upstream's `__document-text` argument (upstream's server `bin.ts` is not carried) and, like
    upstream's, imports only the worker on that path; the stdio runtime lives in `helper.ts` and is
    imported lazily on the other branch.
    `DocumentText.ts` runs that `bin.ts` from source or the bundle itself (`import.meta.url`).
    `coderServer.ts` provides `DocumentText.layer` at the bottom of the runtime services, where
    upstream's `layerPlatformServices` provides it; `ProviderHostLive` carries upstream's
    `resolveExtractedTextPath`.
  - `Orchestrator.ts` and `ProjectService.ts` have no `withCommandMetrics` wrapper (#23966),
    `ScheduledTaskService.ts` records no webhook metrics, `SecretRequests.ts` counts no consumed
    secret refs, and
    `RunExecutionService.ts` reports no browser-preview agent activity (`PreviewAgentActivity`,
    #25184), since metrics and the browser preview are not carried.
  - A thread dropped on the composer from another workspace attaches upstream's saved transcript
    file, read over `orchestration.getThreadTranscript` in place of upstream's authenticated HTTP
    route; client-runtime's `threadTranscript` is an RPC command, so the orchestration atoms
    need no HTTP client. The handler runs upstream's `ThreadManagementService.getThreadTranscript`
    with upstream's `ServerEnvironmentIdentity`, which `coderEnvironment.ts` declares because
    `environment/` is not carried (`ThreadManagementService.ts` imports it from there). A
    transcript over the attachment limit or the helper stdio frame fails with
    `OrchestrationThreadTranscriptTooLargeError`, which the composer reports as upstream reports
    `thread_transcript_too_large`.
- **Provider and orchestration.** Upstream's orchestrator (`orchestration-v2/`: the orchestrator,
  effect worker, projection store, provider session manager, `ClaudeAdapterV2.ts`,
  `CodexAdapterV2.ts`, thread intake and launch, and attachment claims) runs in the helper with
  its `statev2.sqlite` database, with these Coder deltas. Reapply them to whatever replaces those
  files:
  - Claude runs through `Drivers/ClaudeCli.ts`, which implements the Agent SDK's `query()` and
    `Query` surface over the workspace `claude` executable. Rollback and resume use upstream's
    native `resumeSessionAt` from the conversation head, which the CLI accepts directly.
    Where the SDK's `readline` has no line cap, a stream-json line may be as large as the 32 MiB
    pending-message budget allows, minus whatever is already queued; that fits a tool-result image
    at the provider's 10 MiB base64 limit, and a longer line fails the session.
    `ClaudeCli.ts`'s `Query` implements `interrupt`, `stopTask`, `setModel`, `setPermissionMode`,
    `setMaxThinkingTokens`, `applyFlagSettings`, `getContextUsage`, `getSettings` (read directly
    by `ClaudeProvider.ts`), `getUsage`, `setMcpServers`, `backgroundTasks`,
    `initializationResult`, and `close` as CLI control requests. `backgroundTasks` sends the SDK's
    `{ subtype: "background_tasks", tool_use_id }` and resolves to the response's `backgrounded`
    (true when absent), which upstream's steer backgrounding reads. A `can_use_tool` request hands
    its `matched_ask_rule` and `suppress_always_allow_rule` to `canUseTool` as `matchedAskRule`
    and `suppressAlwaysAllowRule`, as the SDK does, so full-access approvals say why Claude asked.
    `setMcpServers` sends the SDK's `{ subtype: "mcp_set_servers", servers }` with no deadline, as
    the SDK does; upstream's query runner bounds the wait and sends a session's `mcpServers` that
    way instead of as `--mcp-config`. T3 Coder's own sessions carry no MCP servers (T3 tools use
    the bridge), so the runner sends none. `ClaudeAgentSdk.ts`
    maps them onto the SDK `Query` (`getUsage` serves its experimental usage method) and answers
    `supportedCommands`, `supportedModels`, `supportedAgents`, and `accountInfo` from the initialize
    response. Every other SDK `Query` method rejects with "not available through T3 Coder's CLI
    transport", and the shim is typed as the full SDK `Query`, so a method a new SDK adds fails
    typecheck until it is mapped or rejected.
  - `Drivers/ClaudeAgentSdk.ts` provides SDK-typed `query` and `getSubagentMessages` over the CLI,
    so upstream code that calls the SDK changes only its import source. Options the CLI transport
    cannot honour fail instead of being dropped; `mcpServers` becomes `--mcp-config`, as the SDK
    passes it. `executableArgs` go before the CLI's own arguments, as the
    SDK passes them, so upstream's agent scope wrapper launches the CLI. A
    `spawnClaudeCodeProcess` option starts the CLI as the SDK does, with the transport's command,
    arguments, environment, and an abort signal, so upstream's process-group spawner stops what
    the CLI leaves running; such a spawner's stderr is not read. It has no `forkSession`: `ClaudeAdapterV2.forkThread`
    allocates the fork's session id and stores the source session and message boundary as the
    provider thread's `claudeFork` native metadata. The fork's first query then runs
    `--resume <source> --fork-session --resume-session-at <message> --session-id <new>` rather
    than copying transcript files. Upstream's fork-head capture (#21188, `forkHeadMessageId` from
    `getSessionMessages`) is not carried, so rolling a fork back to its start behaves as before.
  - Workspace MCP servers, Codex app integrations, and Codex MCP elicitations follow upstream.
    T3's own MCP server is absent; upstream's T3 toolkits reach agents over the workspace file
    bridge instead (see [Runtime boundary](#runtime-boundary)):
    - `mcp/McpSessionRegistry.ts` keeps upstream's shape and lifecycle, but each credential is a
      bridge (`mcp/bridge/FileBridge.ts`) whose `toolCommand` (a Coder field on provider-core's
      `McpProviderSessionConfig`) runs the tools; `endpoint` is the bridge directory, one hashed
      name per thread that the thread's next credential reuses after waiting for the old bridge
      to close. Upstream's tools act only for a caller that owns a live run, as over MCP. As
      upstream (#19491), records stay until revoked and an idle credential is refreshed by the
      next turn rather than pruned.
    - `mcp/bridge/T3ToolBridge.ts` runs upstream's toolkit handlers by name with the credential's
      `McpInvocationContext`, enforces read-only tools in plan mode, and turns calls that outlive
      its inline budget into `bridge-job:` tasks. `coderServer.ts` binds it once the orchestrator runs.
      `--schema` prints upstream's compact `advertisedJsonSchema`, as its MCP server advertises
      (#25790). Plan mode follows the tool annotation: upstream's action tools (#25423, such as
      `t3_queue` and `t3_pending_request`) are not read-only, so their read actions are refused there,
      as upstream's Claude plan-mode allowlist dropped them.
    - `toolkits/environment/` reads the `CoderEnvironment` descriptor in place of upstream's
      `ServerEnvironment`.
    - provider-core's `server/t3ToolBridgeInstructions.ts` reuses upstream's orchestration
      sections (which no longer carry MCP or ACP transport paragraphs since #24850), rewriting
      only "`html_preview`, then `html_render`" to "`html_render`" and dropping the `preview_*`
      bullet; its test fails if upstream rewords them.
    - `CodexAdapterV2.ts` configures no `mcp_servers`, attaches T3 context only when the bridge
      exists, and never advertises preview or device tools; `CodexDeveloperInstructions.ts` and
      `ClaudeAdapterV2.ts` describe the bridge command (`t3ToolBridgeInstructions.ts`) in
      place of upstream's MCP orchestration text. Codex takes it as `t3ToolBridgeSections`, one
      additional-context entry per section like upstream's, so each stays under Codex's
      `CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES`. Claude pre-approves the command as a Bash
      prefix, limited to read-only tools in a read-only sandbox, as upstream pre-approves its MCP
      tools. provider-core's `runtimeInstructions.ts` is upstream's.
    - `ClaudeAdapterV2.ts` gives bridge sessions upstream's `t3_background_wait` guidance without
      its ToolSearch sentence (`CLAUDE_BRIDGE_BACKGROUND_WAIT_INSTRUCTIONS`). Pasted images still
      go through `resolvePastedImageAttachments`, now counted toward upstream's PDF and
      attachment budget by `sizeBytes`, and forks carry `claudeAttachmentBudget` beside
      `claudeFork`. Upstream's out-of-process `runClaudeWorker` fork is not carried (forks use
      the CLI transport); only its `encodeClaudeJson` helper stays.
    - Preview, device, and attachment-upload toolkits are not carried. provider-core's device
      instructions (#25661) are upstream's but never reach an agent: no session holds the
      `device` capability, and `ClaudeAdapterV2.ts` takes no `deviceToolsAvailable` input and
      adds no `SubagentStart` device hook.
  - Provider input reads images only through `PastedImageAttachments.ts`: native `localImage`
    paths for Codex and base64 blocks for Claude. Read-tool image views are limited to PNG, JPEG,
    and WebP. Tool-result image bytes follow upstream: `stripUnservedToolOutputImageBytes` keeps
    only the bounded set of images a tool output serves and drops the rest.
  - `AttachmentClaims.ts` claims staged uploads as described in
    [Network and transfer constraints](#network-and-transfer-constraints): it reads each staged
    file once through a no-follow handle at exactly its declared size and type limit, rejects
    images whose signature does not match their media type, and writes the validated bytes
    exclusively with mode `0600`. Deleting or reverting a thread never deletes its attachments:
    upstream's `ResourceCleanupService.ts`, which upstream's `runtimeLayer.ts` provides, skips
    attachment deletion and has no preview sessions to close.
  - `provider/builtInDrivers.ts` registers only Codex, Claude, Pi (upstream's
    `@t3tools/provider-pi` package), and Kilo Code (upstream's ACP Registry driver, below),
    `settingsSecrets.ts` reads secret settings fields from Pi's and the ACP Registry's client
    definitions alone among the provider packages, and `ProviderOrchestrationAdapterInfrastructure.ts` provides
    only the Claude query runner and the Codex app-server factory. Only shipped providers have
    replay harnesses. Pi keeps upstream's T3 extension for its permission hook (Supervised and
    Auto-accept edits), skill chips, and T3 tools. The extension speaks MCP over HTTP upstream;
    here `buildPiRpcLaunch` hands it the file bridge instead (`T3_TOOL_COMMAND` and
    `T3_TOOL_CATALOG`), and it registers the bridge catalog's tools under upstream's names,
    running each call through the bridge command with its arguments on stdin. The JSON object a
    call prints is also its `structuredContent`, as T3's MCP server returns it, so upstream's
    structured tool results reach bridge calls (the bridge carries no image blocks). Each catalog
    entry's `readOnly` flag becomes upstream's `readOnlyHint`, so a supervised Pi runs read-only
    T3 tools without asking, as upstream does for its MCP tools. The generated
    extension source (`mcpExtensionSource.ts`) keeps upstream's HTTP MCP client beside the bridge
    path, to stay close to upstream. It is dormant: every Coder MCP session carries a bridge
    `toolCommand`, so `buildPiRpcLaunch` never sets `T3_MCP_URL` and the extension opens no HTTP
    connection. Upstream's other provider packages
    (Cursor, OpenCode, Muse, Grok, Antigravity) are not carried, nor is the dev-only "Replay
    (dev)" provider (#26207): `ProviderInstanceRegistryHydration.ts` seeds no replay instance
    and `apps/server/scripts/dev-replay*` is not carried. Their replay fixtures are not carried
    either; `testkit/DormantProviderCapabilities.ts` is kept on purpose, so orchestrator tests
    can exercise those capability combinations without a registered driver.
  - Kilo Code is upstream's ACP Registry driver (`@t3tools/provider-acp-registry`, driver kind
    `acpRegistry`) on upstream's `effect-acp` and `@t3tools/provider-acp`, limited to the local
    command, as Pi is limited to the workspace's own `pi`. Coder deltas, each marked in the file:
    - `settings.ts` keeps only `commandPath` (default `kilo`, titled "Kilo executable"), hidden
      `commandArgs` (default `["acp"]`), `customModels`, and `enabled` (default off, as Pi's).
      Upstream's `source`, `agentId`, `distribution`, and `authMethodId` are not carried.
      contracts' `DEFAULT_DISABLED_PROVIDER_DRIVERS` lists `acpRegistry` to match that default.
      `client.ts` labels the driver "Kilo Code", inlines Kilo's ACP Registry icon so the browser
      never loads it from the registry CDN, and has a default instance.
    - `AcpRegistrySupport.ts` keeps only upstream's local-command `inspect` and `resolve`; the
      registry index, search (with #26248's index reuse), and binary, npx, and uvx installs (and
      `@noble/hashes`) are not carried, and `acpRegistryManagedBinaryDirectories` is gone, so terminals add no managed
      agent directories to `PATH`.
    - `driver.ts` reports only local readiness, with no registry icon, documentation link, or
      sign-in (`canAuthenticate` is false; an authentication failure tells the user to sign in to
      Kilo Code in the workspace). Upstream's auth controller, confirmed-authentication cache,
      URL authentication action, and `acpSessionManagement` (native session list, import, and
      delete; provider list, set, and disable; logout) are not carried, and neither are their
      `auth.ts`, `authenticationState.ts`, or management requests in `probe.ts`. The probe
      offers no terminal login and declines URL elicitation, and real sessions set
      `authenticateOnAuthRequired: false`, so an unauthenticated Kilo Code fails the session
      instead of T3 calling ACP `authenticate`. Upstream marks a completed probe by the
      `nativeSessions` it reports, which this driver does not (session management is not
      carried), so `ProviderRegistry.ts` also treats a ready snapshot that lists a discovered
      model beyond the `default` placeholder as a completed probe, so removed models leave the
      picker. A probe
      that discovers no models at all cannot be told apart from a readiness snapshot, so it keeps
      the previous list; Kilo Code always lists its models, and upstream keeps the list in the
      same case for an instance never signed in through T3.
    - `driver.ts` keeps `acpRegistrySnapshotReadiness` and `testing.ts` keeps
      `probeAcpRegistryConfiguration` exported (upstream made them private) for the fork's Kilo
      Code driver and probe tests.
    - `AcpRegistryRuntimeCoordinator.ts` has no URL authentication consent or session mutation
      permit. `adapter.ts` has no Devin, GitHub Copilot, or Mistral Vibe flavor (`copilotAcp.ts`
      and `devinAcp.ts` are not carried), so neither Copilot's steering override (#26715) nor its
      test, and no native protocol logging.
    - provider-acp's `adapter.ts` has no self-invocation: every ACP session gets no MCP server,
      and when the thread has a bridge command the first prompt carries
      `t3ToolBridgeInstructions` (moved to provider-core for this) through provider-core's
      `t3AcpPromptWithInstructions`, which takes the bridge text in place of upstream's MCP
      orchestration and browser text. Two upstream modules stay dormant on purpose, as Pi's HTTP
      MCP client does, because cutting them would add about 34 seams to the 7.5k-line adapter:
      `mcpOverAcpBridge.ts` (no Coder session has an MCP endpoint, so it is never created) and
      `clientTerminals.ts` (only the Devin flavor passed `clientTerminals`).
      `nativeLogging.ts` is not carried.
    - The server tests carry upstream's ACP Registry replay harness
      (`AcpRegistryAdapterV2.testkit.ts`, `AcpAdapterV2.testkit.ts`, and `scripts/`'s ACP replay
      and mock agents), its adapter and probe tests without the registry, Devin, and
      session-management cases, and a Coder test that the bridge command reaches the prompt.
      `scripts/acp-mock-agent.ts` keeps `T3_ACP_COMMAND_ADVERTISEMENT_DELAY_MS` (upstream dropped
      it in #26238), because the adapter test reads commands a real child advertises.
      Upstream's 14k-line `AcpAdapterV2.test.ts` is not carried.
    - The user guide is the fork's `docs/user/providers-kilo.md`, adapted from upstream's
      `providers-acp.md` (not carried) to the local command.
  - Thread-title and branch-name generation use only Codex, Claude, or Pi models (Pi through
    upstream's ephemeral `pi --mode rpc --no-session` process). Text generation is
    upstream's except that Codex reads branch-name and title images through
    `PastedImageAttachments.ts`, skipping an unreadable image as upstream does, and Pi's
    process (`provider-pi/src/server/textGeneration.ts`) loads the workspace's Pi extensions
    instead of passing `--no-extensions`, because an extension may register the only model
    providers the workspace can reach. It still passes `--no-tools`. Claude's runner
    (`textGeneration/ClaudeTextGeneration.ts`) drops plain-text stdout lines before the first
    JSON line, because a managed workspace launcher prints a banner there first, as
    `ClaudeCli.ts` allows for stream-json. Upstream's out-of-usage fallback (#26164) is not
    carried in text generation, `t3_thread_launch`'s project default, or the web: it reads
    plan-window usage (`shared/usageLimits.ts`, not carried), which API-key providers never
    report. `fallbackModelSelection` stays in the settings schema only.
  - Agent-session import follows upstream, scanning only the workspace's own Codex, Claude, and
    Pi session stores through the helper. `project/AgentSessionScanner.ts` declares
    `resolvePiSessionsDir` itself, because upstream exports it from provider-pi's usage reader,
    which is not carried. `coderServer.ts` provides the scanner beside the helper RPC
    layer, as upstream does beside its WebSocket layer. Upstream offers the import in its welcome
    wizard, which is not carried; `ImportAgentSessionsDialog.tsx` reuses that import step from
    **Settings → Providers → History** for the selected workspace, with the wizard's Pi source
    labels (#27515).
  - `ProviderAuthService` reports every sign-in, logout, and credential-transfer operation
    unavailable; providers authenticate through the workspace's API configuration.
    `CodexManagedRuntime` keeps only upstream's resolution contract, so upstream's
    `CodexManagedTokenBroker` (which renews the managed runtime's ChatGPT sign-in token,
    #21786/#21787) and the `__managed-chatgpt-token` CLI entry are not carried. `CodexAdapterV2` does not
    rewrite failures through `CodexManagedErrors` (ChatGPT Business admin request, #23361), and
    the server's `threadErrorSummary`, `ProjectionStore.ts`'s shell state, and client-runtime's
    `ThreadRuntimeSummary` carry no `lastErrorCode`; the contract field stays.
  - Provider drivers, snapshots, and the registry are upstream's. Coder deltas: `CodexDriver`
    offers no T3-managed Codex install (`setupMode: "managed"`) and so passes the adapter no
    `compatibility` hook (#27281, which reads `CodexInstallation`), neither driver redeems
    rate-limit reset credits, and `ClaudeDriver` does not read the Claude organization id that
    keys upstream's usage accounts, so its one-probe capability fallback skips upstream's
    same-organization check (API-key logins have no organization either way). `ModelManifest.layerBundled` serves the bundled manifest without
    upstream's hourly fetch or disk cache. Both providers report
    upstream's provider-level `supportedRuntimeModes` from workspace policy: Claude's effective
    `disableAutoMode`/`disableBypassPermissionsMode` settings (read through `ClaudeCli`, failing
    closed to the safe modes) and Codex's `configRequirements/read`, which runs in upstream's
    parallel probe step (safe modes when it cannot be read); before the first probe finishes,
    both report the safe modes. The fork-only `provider/runtimeModeCapabilities.ts` builds the
    mode lists and `provider/CodexRuntimeModes.ts` maps Codex's requirements. At session start,
    `ClaudeAdapterV2.resolveBypassAvailability` reads the settings files (cached remote, user,
    project, local, and managed) where upstream calls the SDK's runtime `resolveSettings`
    (#21806); a mode any source disables is off, so `Drivers/ClaudeSkills.ts` keeps
    `claudeSettingsPaths` exported for it. `resolveSubagentPromptCacheTtl` reads
    `subagentPromptCacheTtl` from the same files (user, project, local, then managed; the last one
    set wins) instead of the SDK's `resolveSettings` (#22841). `CodexDriver` has no `CodexUsageHistory`
    requirement, because Codex usage history (#21898) is not carried. The Claude signed-out message names API
    credentials rather than subscription login. Claude's usage read asks the CLI to skip its local
    transcript scan (`ClaudeCli.getUsage({ skipBehaviors })`), as upstream's SDK call does.
    provider-core's `maintenanceResolver.ts` and `providerStatusCache.ts` log the first cause tag
    in place of the omitted observability helper. `ProviderHostLive` gives drivers no credential
    store: reads find nothing and writes fail.
  - Absent: client-origin attribution, orchestration and provider metrics (including the run
    outcome metrics of `RunMetrics.ts`, #22094, so `EventSink.ts` records none), turn analytics, NDJSON
    event logs (`EventNdjsonLogger` and `ProviderEventLoggers` keep only the no-op service),
    provider sign-in commands and credential-change guards, Codex feedback upload (client-runtime
    `threadCommands.ts` has no `uploadFeedback`), SnapShot
    sources, data-URL uploads, preview-tool metadata, and the agent device shim.
- **Authorization scopes.** Coder owns authentication, so upstream's per-session scopes always
  grant: web `useEnvironmentScope`, `readEnvironmentScope`, and `useFilesystemReadAccess`
  return granted for a known workspace, and client-runtime `commandPermissions` authorizes every
  command and installs the `RpcPermissionGuard` that upstream's guarded RPCs require. Settings
  sync writes to every connected workspace without grant checks, and worktree removal is always
  offered. `state/terminalSessions.ts` reads terminal scopes through `readEnvironmentScope`
  instead of upstream's session-state atom, which the fork does not carry, and
  `files/fileSaveSessions.ts` subscribes to no write-scope changes for the same reason.
- **Agent secret requests.** Upstream's `request_secret` tool, card, and one-use secret store,
  with the value sent only to the workspace store over `secrets.answerRequest`; it never enters
  browser storage, the transcript, projections, model context, or logs.
- **MCP Apps.** Upstream's inline app rows and sandboxed frame, with resource reads and tool calls
  over the helper's MCP Apps RPCs. The frame has no camera, microphone, geolocation, or clipboard
  permission. `ui/download-file` is upstream's: the user confirms, and the host page saves the
  embedded or linked bytes. The captured document loads from upstream's signed asset URL (see
  [Media and document previews](#media-and-document-previews)).
- **HTML renders.** Upstream's `html_render` tool, `HtmlRender` service, and inline frame, with
  these Coder deltas (each marked `Coder:`):
  - The bridge carries `html_render` only. `htmlRender/HtmlRender.ts` keeps upstream's image
    inlining and storage but not `preview` or height measurement, because work workspaces cannot
    obtain the headless browser they need; pages publish at the agent's height and the frame
    shrinks to a shorter page's reported height. Publishing records the page through upstream's
    `McpProviderSessions.recordHtmlRender` (#19796). The tool description omits `html_preview` and
    the mobile-only scroll-cap sentence.
  - Over the bridge the call is a shell command, so `htmlRenderFromBridgeCommand` (shared
    `toolOutput.ts`) recognizes a completed `…/t3-tools-<id>/t3.mjs html_render` command whose
    output is the tool's JSON result. `WireProjection` keeps only that compact reference on the
    wire (other command output stays withheld), and the timeline shows the page there, as
    upstream shows a `dynamic_tool` render. The page loads from upstream's signed attachment URL.
  - Pages are kept like other attachments; deleting a thread does not delete them.
- **Tool output images.** `turnItemOutputImages` lists a fetched item's images, and the inspector
  renders each with `ChatMarkdownAssetImage` from upstream's signed `tool-output-image` URL.
- **Runtime modes.** Modes use upstream's provider-level `supportedRuntimeModes` everywhere (the
  composer's `resolveCompatibleRuntimeMode`, `RuntimePolicy`, and delegated tasks); Claude and Codex
  fill it from workspace policy (see the provider drivers above). One delta: a mode the provider
  does not offer steps down to the broadest offered mode below it, as upstream's
  `delegatedTaskModes.resolveRuntimeMode` already does, where upstream's `resolveCompatibleRuntimeMode`
  (`runtimeModeConfig.ts`) and `RuntimePolicy.providerRuntimeMode` fall back to the narrowest.
- **Contracts.** `packages/contracts` follows upstream, including dormant schemas for surfaces Coder
  does not serve (auth, provider setup, other providers' settings, browser, device, preview, usage
  sources, agent sessions, filesystem browse, background policy). Coder deltas:
  - `rpc.ts` omits RPCs whose schemas belong to excluded modules (chat attachment persistence,
    preview automation, relay, resource telemetry, usage, editor launch, GitHub routing, feedback
    upload, and the OTLP endpoint check) and adds the helper-only methods
    (with the transcript read's `OrchestrationThreadTranscriptTooLargeError`) and
    `CoderWsRpcGroup`, the
    only group the helper serves. That group carries upstream's thread find
    (`searchThread`, `searchThreadStream`), file chip metadata (`filesystem.getMetadata`), turn-item
    reads, passive terminal observation, agent
    secret answers, storage cleanup runs and reports, review guides
    (`pullRequests.reviewGuide`, `pullRequests.generateReviewGuide`), the workflow stop, command
    output streaming (`subscribeCommandOutput`), and the MCP Apps methods. Upstream's
    `WsRpcGroup` stays dormant, unreferenced, with the RPCs only it uses, and `knip.jsonc`
    ignores `rpc.ts`'s unused exports for it. Upstream's `EnvironmentAuthorizationError` stays in
    error unions but is never emitted.
  - `CoderWsRpcGroup` carries `projects.createFromThread` (#26767), and the descriptor advertises
    `threadProjectFromScratch`. `server.ts` mirrors `ipc.ts`'s `DesktopUpdateChannelSchema` for
    `ServerSelfUpdateInput` (#26288), because `ipc.ts` is not carried; the descriptor omits
    `desktopAppChannelSwitch` and `databaseMigration`.
  - `CoderWsRpcGroup` omits `server.getNpmRelease` (#27847), which only server self-update
    (`cloud/npmRelease.ts`, not carried) reads.
  - `ServerConfig` omits auth, editors, remote open targets, and observability, except
    upstream's optional `lastEventLoopStall`, which stays in the schema but is never sent.
  - `vcs.ts` and `git.ts` keep upstream's shapes (GitLab's `GitLabCli` supplies its own
    "Merge request not found." detail), plus the helper-only ref-status and thread-branch rename
    schemas.
  - `assets.ts` omits native app icons.
  - Tool items keep legacy screenshot `artifacts`; rate-limit events carry the raw payload.
  - Terminal attach input adds `afterSequence` and `afterEpoch`, terminal snapshots add
    `attachEpoch`, and the attach stream adds a `resumed` event.
  - Claude launch args reach the workspace CLI except the stream-json transport flags. `ClaudeAgentSdk.ts` passes
    `mcpServers` and `strictMcpConfig` as the SDK does and rejects in-process (`sdk`) MCP servers,
    which the CLI transport cannot host.
  - The web provider list and client-runtime `state/server.ts` stay limited to the methods the
    helper serves and to Codex, Claude, Pi, and Kilo Code (`acpRegistry`) driver instances
    (`isCoderProviderDriver`). Client-runtime's `providerClients.ts` (#24205) registers only those
    four, so web's `providerDriverMeta.ts` re-exports it as upstream's does, and the Add provider
    dialog shows all four as first-class with no "Show more" fold or ACP Registry search (#25753).
  - Client settings keep `providerPreferencesByEnvironment`, the per-workspace favorites and model
    order the browser stored before upstream moved them into server settings, read only as the
    legacy lists each workspace migrates (see [Persistence](#upstream-seams)).
- **Terminals.** `terminal/Manager.ts` is upstream's. Coder deltas: it records each terminal's
  attach events in a bounded replay window (`DEFAULT_ATTACH_REPLAY_*` in `Manager.ts`) and answers an
  attach with `afterSequence` by replaying the missed events and a `resumed` event instead of a
  snapshot when the window still covers the gap. Each shell session restarts its sequences, so
  it also has an `attachEpoch`, and a cursor whose `afterEpoch` names another session gets a
  snapshot. Terminals poll the process table themselves
  (no resource telemetry), register no ports for preview discovery, record no metrics, and get
  no managed ACP install directories on `PATH`. In the browser, the terminal session state, output model,
  drawer, and UI state store are upstream's; client-runtime adds `TerminalBufferCache`, a bounded
  in-memory cache that seeds a reattach and supplies its `afterSequence` and `afterEpoch`, and
  tracks the last applied sequence and session epoch. Each attach attempt reads `afterSequence` from that cache, beside upstream's
  `resume` flag, and a resumed attach of a closed terminal gets upstream's `closed` event. `ThreadTerminalDrawer` never opens terminal links (there is no editor or
  preview surface).
- **Command palette.** `CommandPalette.tsx` and the modules upstream split from it
  (`CommandPaletteAddProject.tsx`, `CommandPaletteLookups.ts`, and the item files) are upstream's, including its add-project browse,
  clone, and new-project flows over `filesystem.browse` and the clone RPCs. Coder deltas (marked
  `Coder:`): the active workspace stands in for upstream's primary environment and supplies
  keybindings; every workspace is remote; Add project always shows the workspace picker, which
  also lists each domain's unconnected workspaces and connects the chosen one; there is no desktop or WSL folder picker, browser
  preview, usage page, or file manager action (the footer holds only the message search notice);
  and review actions say merge request. Opening the palette to add a project runs workspace
  discovery once; with no Coder domain it opens connection settings. The usage, preview, and
  `usage.open` cuts sit in `shortcuts/commandPaletteCommands.ts`, where upstream moved the
  palette's shortcuts (#25733). Clone sources, host icons, and
  publish targets come from the GitLab-only client registry (see Source control below).
  Clone URLs are validated by the helper.
- **Composer, timeline, and work log.** Upstream's context records, upload queue, chips, and
  work-log module (`client-runtime/work-log/toolPresentation.ts`), minus preview annotations,
  element captures, SnapShot (with its open question-draft tracker in `questionAttachments.ts`),
  and remote icons. Upstream's large-paste folding (#11442) is carried: a paste at or over the
  limit becomes a `text/plain` file attachment (`useComposerAttachmentIntake.ts`). `work-log/presentation.ts` formats
  token counts inline, since upstream's `@t3tools/shared/usageFormat` belongs to the omitted usage
  dashboard. Draft file and video attachments
  preview as on main. A context fragment pasted from another workspace downloads its attachments from the
  source workspace's signed asset URLs, as upstream does.
  A thread dropped from another workspace attaches its saved transcript (see Transport and RPC
  handlers). Images and files upload through upstream's signed upload URL (see
  [Composer attachments](#composer-attachments)); `ChatView` gates them on
  the helper's advertised attachment capabilities, as upstream does. Submitted images, sent
  files, rewinds, and queued edits read through upstream's signed attachment URLs (see
  [Media and document previews](#media-and-document-previews)), and the right panel previews a sent
  file in upstream's `FilePreviewPanel`. Native app icons fall back to the tool glyph.
  Upstream's v1 importer carries only messages, and upstream migration 063 drops the v1
  `projection_thread_activities` rows, so screenshots that pre-v2 conversations saved as
  `artifacts` on v1 tool activities are not shown, as on upstream.
- **Project actions.** The thread details panel, action editor, and Settings → Actions are
  upstream's. Coder deltas: repository actions come from the helper's validated `t3.json` read by
  project (`projects.getConfig`), which drops `iconPath` and script preview fields; the editor has
  no preview URL. The thread details card's item choices (#26904) have no Open in, servers, or
  usage items, so `threadDetailsUsageEnabled` is never read, and Labs' 5h, weekly, and context
  limits view (#26859, `ThreadDetailsUsage`) is not carried.
- **Right panel and composer chrome.** `RightPanelTabs.tsx` is upstream's tab strip and
  `PreviewPanelShell` layout without browser, device, and preview surfaces: no launcher rows,
  favicons, browser profiles, audio controls, or device rename. Never-opened preview and device
  surfaces in the store get a plain title and icon. Merge-request rows, tabs, and disabled reasons
  use GitLab wording and `!` references. The branch toolbar is upstream's; workspace options are never primary and use
  the server's machine kind, there is no "Auto balance" run target (upstream's load balancing is
  not carried), and it has no server-update control (server self-update is not carried). The branch picker adds "Rename current branch…" for a
  thread's own branch (`vcs.renameThreadBranch`), which can also rename the T3 worktree folder
  through the driver's `moveWorktree`. Proposed-plan cards are upstream's. There is no default-theme adoption, which follows
  upstream's `t3 theme set` CLI.
- **App entry.** `index.html`, `bootstrap.ts`, and `main.tsx`'s startup (stale-chunk reload,
  splash held until the first route loads, boot error) are upstream's. `main.tsx` renders the app
  inside `CoderBootstrap` and installs `consoleDiagnostics`, with no Electron shell, managed auth,
  or provider auth delivery. It starts upstream's `appInit.tsx` services, trimmed to the browser
  ones: no provider auth delivery, Electron, default-theme adoption, agent-opened previews, SSH
  prompt, host-freeze toast, legacy-permission re-pair notice (`PermissionUpdateNotice`),
  desktop update notice, Electron browser host, preview title recording, browser profile
  reporting, favorite-editor command (OpenInPicker is not carried), or desktop paste-as-text.
  The keybindings reload toast (`KeybindingsUpdateToast.tsx`) shows the reload's message without
  upstream's config-warning actions, which open the desktop editor. `shortcuts/chatRouteCommands.ts`
  has no preview commands (its legacy-sidebar check is upstream's), `state/entities.ts` keeps only
  `initializeActiveEnvironmentId` (the first welcome sets the primary), and client-runtime's
  `state/presentation.ts` shows an available placeholder as connecting without upstream's
  `entry.enabled` and `unsupportedReason`, which Coder entries lack. The "failed to start" screen
  (`lib/bootError.ts`, #25345) keeps reload and copyable error details, without the desktop update
  button, download link, `t3 triage` command, or upstream issue link, since the browser client has
  no desktop bridge or local CLI and T3 Coder bugs are not upstream's. `__root.tsx` keeps the fork's minimal shell, and `_chat.tsx` carries
  upstream's Settings-over-thread modal layout (#24847) with a `beforeLoad` that has no auth gate
  and no prompt-link card; upstream's `_chat.settings.tsx` no longer gates on pairing, so it is
  taken as is. `shortcuts/dispatcher.ts` registers no desktop menu actions or preview focus.
  `hooks/useSettings.ts` runs upstream's `startModelPreferencesMigration` with the per-workspace
  legacy model lists inside it, and client-runtime's `state/runtime.ts` calls `onAnswer` on the
  non-persisted query path as well. The web Vite config carries upstream's office/pdf asset
  handling (the `@betteroffice/fonts-cjk` alias, pdfjs asset names, ES workers) and route code
  splitting, but not the render scenarios project, `VITE_RELEASE_CHANNEL`, source maps, or the
  build manifest.
- **App sidebar.** The layout, header, footer, and provider-update pill are upstream's. Coder
  deltas: there is no usage page, desktop app-update
  pills, desktop window bridge (fullscreen insets and the open-settings menu action), or preview
  keybinding context (`readUsagePageOpen` is always false); the active workspace supplies keybindings and the pill's providers. Without
  upstream's "Update everything" (server self-update), `ProviderUpdatesAction.tsx`'s Update all
  has no `quiet` option or returned runs and `ProviderUpdateRun` no environment id. `index.css` is
  upstream's minus the `wco` window-controls variant, drag regions, and desktop resize inset.
  Without the desktop window-controls overlay (`lib/windowControlsOverlay.ts`), `ui/tooltip.tsx`
  reads a native titlebar height of zero, `chat/ZoomableImage.tsx` sizes the viewer to the whole
  window, and the sidebar sheet gets no window-controls inset.
  `NavigationHistoryShortcuts` and `CommandPalette` read `usagePageOpen` as false, and
  `NavigationHistoryShortcuts` stays unexported, since upstream exports it only for
  `UsageToggleShortcut.browser.test.tsx`. `settings/AddEnvironmentDialog.tsx` is not carried
  (there are no Connections settings).
- **Chat view.** `ChatView.tsx` is upstream's, minus the browser and device preview panels and
  mini-player, automatic machine placement, server self-update and version-skew banners,
  usage-limit panel, Codex feedback upload, local editors (`OpenInPicker`), and the favicon store.
  The active workspace stands in for upstream's primary environment, and drafts read their
  route workspace's config. The Files surface opens for drafts as on main. `chatCanvasLayout.ts` has no preview obstacles (it accepts upstream's `findBar` and ignores it),
  and `chatCanvasLayout.test.ts` and `canvasStore.test.ts` carry no preview cases. Pieces upstream
  moved out of `ChatView` carry the same cuts (each marked `Coder:`): `RightPanelSurfaceContent`
  renders nothing for browser and device surfaces and names merge requests; `useRightPanelSurfaceClose` closes no preview sessions and asks no agent-browser
  confirmation; `useQueuedRunEdit` carries no preview annotations; `useThreadLinkedPullRequest` names merge requests; `useSystemComposerBanners`
  shows only the offline or reconnecting banner, whose Reconnect only retries (no #24691 re-enable,
  since every workspace is enabled), with no connection diagnosis, disconnect action,
  server-update notice, or auto-balanced machines; `useDraftEnvironmentRouting` keeps only the
  manual machine switch; `ChatView.logic.ts`'s send snapshot and title fallbacks and
  `chatViewSend.ts`'s draft restore carry no preview annotations, and a send that redirects
  pending approvals has no direct annotation to allow for. Upstream's `useUsageLimitsPanel`,
  `useAgentOpenedPreviews`, `mergeDirectPreviewAnnotation`, and the Antigravity send block are
  not carried, and `useTimelineRewind`'s rewind reads the message's images back through the
  helper instead of `chatViewSend.ts`'s `prepareRevertedMessageAttachments`. The hooks upstream
  split out of `ChatView` (#23062–#23101) hold the matching cuts: `useComposerSend` has no
  feedback upload, `/usage-limits` command, load balancing, or direct preview-annotation send
  (so `composerSend.logic.ts` carries no load-balancing helpers); `useRightPanelActions` has no
  browser or device surfaces; `useChatTerminalActions` opens no script preview;
  `useProjectCloneBanner` shows no file-copy banner; and `usePullRequestDraftThread` names merge
  requests. Upstream's ChatGPT Business admin request (#23361) is not carried, so
  `ThreadErrorBanner` and `ChatBannerLane` take no error code. The automation message row
  (#22638) has no prompt link.
  `RightPanelTabs.tsx` stays the fork's version without upstream's per-tab memoization (#20853);
  `ChatOverlayHosts.tsx` has no device setup dialog host, and `ProviderSettingsPanel`'s
  `ProviderInstanceRow` passes no ACP sign-in, managed Codex runtime, or provider setup section;
  its `RemoteSessionGatedProviderSettings` (which absorbed upstream's
  `SelectedEnvironmentProviderSettings` in #26238) grants operate access without upstream's
  remote-session check, since the gateway has no auth scopes.
- **Markdown.** `ChatMarkdown.tsx` and the modules upstream split from it (`chat/ChatMarkdownMedia.tsx`
  for images and videos, `chat/MarkdownFileLink.tsx` and its `.logic.ts` for file chips) are
  upstream's, with these differences (each marked `Coder:` in the files):
  - Workspace images and videos load from upstream's signed asset URLs (see
    [Media and document previews](#media-and-document-previews)). A media file that is not found names the workspace and the checked path, where
    upstream first checks its remote-open mode, because every workspace is remote. Timeline
    galleries are hosted by `ChatView`, as on main.
  - There is no in-app browser, local editor, or file manager: `MarkdownFileLink` never receives
    `onOpen`, `onOpenInBrowser`, or `onReveal`, and the link context menu never offers the
    integrated browser. Without a primary action a chip opens only its copy menu.
  - Relative and non-web links render as inert text.
  - GitLab references open directly: `confirmBeforeOpen` is false and the candidate URL is the
    link itself, because `!N` already names a merge request and `#N` an issue (GitLab's
    `changeRequestUrlFromReferenceAutolink` returns null).
- **Files and search UI.** `components/files/*`, `components/search/*`, the file picker, and the
  keybindings are upstream's. Coder deltas (marked `Coder:`): image, video, audio, PDF, and HTML
  previews load from upstream's signed asset URLs, and HTML files are detected locally because
  upstream's `isBrowserPreviewFile` lives with the in-app browser; there is no open-in-editor,
  reveal, or open-in-browser action. `fileContextMenu.ts` keeps upstream's
  `resolveFileContextMenuAbsolutePath` but replaces its editor and reveal items with Open in Files
  (when the caller passes a thread) and Copy path, which copies that full path; the Files tree,
  the diff panel, and turn change cards use it. Changed files in the Git actions dialog open in the
  Files surface instead of an editor (`ChatView` passes `openFileSurfaceStable` through
  `ThreadDetailsPanel`'s `onOpenFile`), and the dialog closes so the file is visible, keeping its
  commit message for the next open: repository-relative status paths map to the thread's folder,
  and a file outside a subfolder project opens by its absolute path.
  `projectFilesQueryState.ts` has no `isFile`, which only the uncarried `OpenInPicker` reads.
  `env.ts` reports `isElectron = false` for upstream's desktop branches.
- **Merge requests.** Upstream's page, panel, stack menu, and right-panel tabs, GitLab-only. GitHub
  maintainer edits (#25588) have no web control; the service and source-control-core plumbing is
  upstream's, gated on a capability GitLab never advertises. Diffs
  come over the `pullRequests.diff` RPC without upstream's cross-environment GitHub routing,
  a project's default merge method is a workspace setting whose `null` means "last selected",
  and `!` references and GitLab wording are
  used. Label RPCs exist but GitLab does not advertise label editing, and native stack actions are
  never advertised. Video uploads play inline, other uploads link as on main, and `/uploads/`
  links resolve below the repository, where GitLab serves them (client-runtime
  `pullRequestMarkdown.ts`'s `resolveGitLabUploadUrl`; the same file names a GitLab or self-hosted
  upload's host). The markdown context carries `repositoryUrl` beside upstream's `autolinks` for
  that, and `PullRequestMarkdown.tsx`'s `remarkGitLabUploads` applies it to the images, links, and
  reference definitions inside the prose. `!123`, `#123`, and commit autolinks come from GitLab's
  definition (`referenceAutolinks`), which the web's upstream `pullRequestMarkdown.logic.ts` calls.
  Actor avatars load as on main. MR links everywhere
  (Markdown, the sidebar, composer and timeline chips, and the thread MR panel) open through
  upstream's `lib/openPullRequestLink.ts`, which always offers upstream's "Open link" toast when a
  commit link (#19941) names a commit outside the thread's workspace, since links open only in the
  system browser; its browser test uses GitLab `/-/commit/` URLs and drops the merge request
  commit-URL case, which GitLab's definition does not parse. The GitLab-only registry claims only GitLab's
  `/-/merge_requests/` URLs, and project matching (client-runtime `changeRequestLinks.ts`'s
  `isGitLabProject`, also used by `findProjectOnChangeRequestHost`, which #24738 moved there from
  the web's `openPullRequestLink.ts`; the web keeps only `gitLabMergeRequestBrowserUrl`) uses upstream's host
  resolvers but skips checkouts whose provider is neither GitLab nor unknown (the registry reads
  other kinds as the generic host, which would still match by host and path).
  `gitLabMergeRequestBrowserUrl` replaces upstream's GitHub fallback URL (and GitLab's
  definition URL in `LinkPullRequestDialog`'s `resolveLinkPullRequestProject`, which wraps
  client-runtime's `pullRequestLinkProject`) and keeps a self-hosted install's origin and path
  prefix; it stays because nothing sets `RepositoryIdentity.webUrl`, which GitLab's definition
  URL needs for such an install. The link dialog also accepts `!123`, the form "Copy MR number"
  copies (client-runtime `pullRequestLinkInput.ts`). A plain click opens the panel or page, and a
  modifier or middle click or an MR no workspace project can read goes to the system browser.
  Upstream's "Open pull requests in T3 Code" row is defined on the Integrations page, which is not
  carried, so `SettingsPanels.tsx`'s Diffs page defines it in place, with MR and "T3 Coder" wording.
  Upstream's delete-branch action, panel entries, and menu items are carried with merge-request
  wording; GitLab does not declare `deleteBranch`, so they never show, and `PullRequestService`
  runs the action without upstream's verified-credential wrapper. In Markdown
  they are upstream's new-tab anchors with hover previews. The merge requests page resolves a link
  against every workspace that reads merge requests, the primary first. Right-clicking a web link shows upstream's menu (system browser, Copy Link, and
  Link/Unlink to thread through `usePullRequestLinking`).
  - User-facing text says "merge request", "MR", and `!123` wherever upstream says "pull
    request", "PR", or `#123`: the panels, composer, settings, toasts, keybinding labels, and
    the strings the web shows from `client-runtime` (work-log tool labels and MR actions) and
    `shared` (T3 tool presentation, watch descriptions, copy-link toasts, and the command palette's
    match hints). The agent-facing
    text the server writes says "merge request", `!123`, and "T3 Coder" too: the merge-request
    watch wakes and their notification summaries (`pullRequestWatch.ts`,
    `PullRequestWatchReactor.ts`), the merge-request T3 tool descriptions and errors
    (`mcp/toolkits/pullRequests/tools.ts`), the orchestrator's unconfirmed-answer error, and `GitManager`'s
    merge-request ref fetch error. `runtimeInstructions.ts` stays upstream's. Identifiers, wire
    names, and search haystacks keep upstream's spelling, and the composer trigger stays `#`.
    GitLab's definition supplies "MR" and "merge request" wherever upstream reads a host's
    terminology (#23999 made most surfaces read it), and a missing provider reads as GitLab because
    it is the only definition (an `unknown` one gets upstream's generic wording); `!123` is still
    applied by hand, since definitions carry no reference prefix. Text for paths GitLab never reaches (native stacks, stack merges,
    `PullRequestsUnavailableState`'s GitHub link, GitHub-only setting rows) is upstream's. These
    pure wording substitutions are not marked line by line; every other difference is.
- **Source control and merge-request services.** `sourceControl/`, `pullRequest/`, and upstream's
  `@t3tools/source-control-core`, `-definitions`, `-gitlab`, and `-testing` packages are
  upstream's, GitLab-only. Upstream's GitHub, Azure DevOps, Bitbucket, Forgejo, and GitCafe
  packages are not carried. Coder deltas, each marked `Coder:`:
  - `source-control-definitions`' `registry.ts` registers only GitLab's definition, and the
    server's `sourceControl/sourceControlDefinitions.ts` lists only the GitLab driver, so both
    sides iterate GitLab alone: labels, terminology, icons, clone and publish pickers, reference
    parsing, and project matching follow GitLab, and every other kind reads as the generic host.
    `builtInDrivers.ts`, `sourceControlHostSecrets.ts`, and client-runtime's
    `sourceControlClients.ts` are upstream's over that registry, except that
    `sourceControlClients.ts` drops `readHostCredentialSettings` and its credential types, which
    only the uncarried token and account settings use. GitLab declares no host settings, so no
    host secrets exist; upstream's host, token, account, and routing settings are not carried.
    The registry's `parseChangeRequestUrl` (core `shared/definition.ts`) rejects a URL carrying
    credentials, because links persist their URL verbatim.
  - Upstream's forge app sign-in (#26245) is not carried: the server has no
    `SourceControlSignIn` service or sign-in and app-access handlers, and source-control-core
    drops the driver's `signIn`, the definition's `appSignIn` and `signIns` setting, and
    `SourceControlHost.settings.update` (also absent from the test host), because GitLab uses the
    workspace's `glab` login. Contracts keep upstream's sign-in schemas, the dormant `appSignIn`
    field, and the `sourceControl.signIn*` and `sourceControl.appAccess` RPCs in upstream's
    dormant `WsRpcGroup` only; `CoderWsRpcGroup` omits them. Upstream's GitHub star prompt
    (#27832) is cut with it: `CoderWsRpcGroup` omits `sourceControl.starred`, source-control-core
    drops the driver's `isRepositoryStarred`, client-runtime has no `checkStarred` atom, and web has
    no `GitHubStarPrompt` or `useComposerSend` `recordPromptSent` call.
  - Secret provider references in source control host credentials (#27746) are not carried:
    source-control-core's `SourceControlHost.settings` has no `getWithSecrets` (nor the test
    host), and server `sourceControlHostSecrets.ts` has no reference resolution or invalidation,
    so `server.refreshProviders`' `reloadSecrets` invalidates nothing; upstream's
    `secrets/settingsSecretValue.ts` and `sourceControlHostSecrets.test.ts` are not carried. In the clients, web
    `SourceControlAppAccessNotice.tsx`, `T3AppIcon.tsx`, `settings/SourceControlAppSignInSettings.tsx`
    and `sourceControlAppAccessToast.ts` are cut (`state/sourceControlActions.ts` suggests no app
    access after publishing), and client-runtime `state/sourceControl.ts` and
    `sourceControlClients.ts` have no app-access or sign-in atoms and no `appSignInTargetForRemote`.
  - GitLab's definition (`source-control-gitlab/src/shared/definition.ts`) has three deltas:
    `authorProfileUrl` links comment authors under the host root; `referenceAutolinks` (`shared/referenceAutolinks.ts`) links `!N`
    merge requests, `#N` issues, and full commit SHAs below the project with GitLab's `/-/`
    routes, where upstream's GitLab defines none; and `mediaUrl` (`shared/gitLabMedia.ts`) claims
    Markdown uploads below a project's path, below `/-/project/<id>/`, or on the API route, and
    maps each to `/api/v4/projects/<project>/uploads/<secret>/<file>`, where upstream's GitLab
    claims none. The driver's matching `fetchMedia` (`server/GitLabMediaFetch.ts`) runs
    `glab api` on that route in the minted `cwd` without `--hostname`, so the credential goes only
    to the host `glab` already uses for that repository, and buffers at most
    `GITLAB_MEDIA_MAX_BYTES`. Core's `SourceControlMediaRequest` adds `cwd` for it, and
    `sourceControlMediaResponse.ts` passes the claim's. The package exports upstream's two entry
    points plus `server/GitLabCli`, which `ws.projects.test.ts` stubs.
  - GitLab's hover preview and summary reads are upstream's (#22583). `source-control-definitions`'
    `canonicalizeGitCafePullRequestUrl` is an identity function, since GitCafe is not carried. Diff output is capped
    (`DIFF_MAX_OUTPUT_BYTES`) to fit the gateway's `MAX_RPC_MESSAGE_BYTES` ceiling.
  - GitLab fixes for bugs still in upstream's `GitLabCli` (checked against upstream `main`
    32ecd71726):
    merge requests between projects post to the source project with a numeric
    `target_project_id` instead of sending the repository text as `source_project_id`; merge
    request URLs reach `glab` as `--repo <url> ... -- <iid>` because older versions read URLs as
    branch names (options stay before upstream's `--`); `mr checkout` honours `branch` and `force`.
  - `glab auth status` lines carrying a token label or a `glpat-` token are never surfaced. Clones
    accept only GitLab URLs without credentials, query, or fragment, and pass `--` before the URL.
  - `PullRequestService` omits upstream's cross-environment routing (routing identities,
    verified credentials, `expectedAccountId` refs).
  - `coderServer.ts` uses upstream's `layerRepositoryIdentityResolver` from `server.ts`, whose
    refine hook lets GitLab confirm a self-hosted host through its `glab` login, and provides
    `FetchHttpClient` to the runtime because every source-control driver requires an HTTP client.
  - Shared `sourceControl.ts` is upstream's `isSshRemoteUrl` plus the fork's
    `parseGitLabCloneSource`, which keeps a small table of other hosts so their URLs are still
    rejected. A pasted `owner/repo` clone shorthand takes the first registered host's default
    transport, as upstream's does, so it becomes `git@gitlab.com:owner/repo.git`.
  - Review guides are upstream's (`pullRequest/PullRequestReviewGuideService.ts`, migration 061,
    the guide T3 tools, and the web Guide tab). `coderServer.ts` provides the service to the
    helper RPC handlers and the bridged tools. The temporary checkout, its fetches, and the
    change it reads are workspace Git; the writer model runs through upstream's Codex or Claude
    text generation in the workspace, and Pi and Kilo Code refuse, as upstream's runners do. The Guide
    tab reads the diff over `pullRequests.diff`; upstream's head lookup already tries
    `refs/merge-requests/<n>/head`. Coder deltas: the guide tools resolve only merge requests on a
    GitLab host the projects use, as the link tools do; and the service's reader-facing errors say
    merge request and `!N`.
- **Provider drivers.** provider-core's `ProviderDriver.usage` is `never` and its `usage.ts`
  is not carried: there is no usage page, so Claude, Codex, Pi, and Kilo Code register no usage readers
  (provider-pi's `usage.ts` is not carried) and `provider/builtInDrivers.ts` has no usage
  driver list.
- **Git layer.** `vcs/GitVcsDriver.ts`, `vcs/GitVcsDriverCore.ts`, `vcs/VcsProcess.ts`,
  `vcs/VcsStatusBroadcaster.ts`, `git/GitManager.ts`, `git/GitWorkflowService.ts`, and
  `git/remoteRefs.ts` are upstream's. Each difference is marked `Coder:` in the file:
  - The driver core has no Git metrics or span events. It adds `moveWorktree`, which
    renames a thread's worktree folder together with its branch (bounded by the 5-minute
    worktree remove deadline, since upstream dropped the add deadline in #23802), and
    `refStatusLocal`, a
    branch read that never refreshes the real index. Review file expansion allows up to
    `MAX_REVIEW_DIFF_FILE_BYTES` and fails with `ReviewDiffFileTooLargeError` for the chunked
    review RPCs, rejecting malformed UTF-8; `GitVcsDriverCore.test.ts`'s split-output test
    expects that field, with a branded exit code so the comparison typechecks, and its commit
    review test (#19941) reads the error as a `GitCommandError`. A top-level review `sourceKind` returns only that
    source. Worktree creation reads `t3.json` through the bounded `readProjectConfig`.
    Checkpoint commits use the "T3 Coder" identity.
  - `VcsProcess` records no Git command metrics. Its concurrency keys and failure
    classification are upstream's per-call `concurrency` and `classifyFailure` hooks (GitLab's
    `classifyGlabFailure`).
  - `GitManager` is upstream's apart from the merge-request ref fetch error's wording: merge
    request heads come from GitLab's `changeRequestHeadRef` (`refs/merge-requests/<n>/head`), and
    upstream's `targetsOnlyRemote` check is host-neutral through `createsChangeRequestsIn`, which
    GitLab does not define.
  - `GitWorkflowService` adds `moveWorktree` and `localRefStatus` pass-throughs.
  - `VcsStatusBroadcaster` adds `streamRefStatus` for `subscribeVcsRefStatus` and resolves
    auto-pull with `resolveProjectAutoPull`, which honors legacy project auto-pull opt-ins
    (`project.autoPull`); upstream deleted that resolver from shared's `serverSettings.ts` in
    #26238, so `vcs/projectAutoPull.ts` keeps it. Its `BackgroundPolicy` dependency is a
    Coder-owned stub that always allows work, because polling already stops when the last
    status subscription ends. Its `shouldRunOpportunisticWork` is always true too, so
    `ThreadPullRequestService`'s minute-by-minute merge request sweep runs whenever the workspace
    server does, which is only while the gateway holds its helper; `coderServer.ts` provides the
    policy to the runtime as upstream's `layerBackground` does. `server.ts` provides upstream's `layerAutomaticFetchInterval`, so the remote refresh interval follows the background-activity profile as upstream's does.
  - Startup auto-pull (`vcs/projectAutoPull.ts`) is upstream's `autoPullProjects` from
    `serverRuntimeStartup.ts`, enabled per project by the same `resolveProjectAutoPull`.
- **Settings.** Upstream's layout, pages (#25651), navigation, and search, with Coder's Connections
  ("Environments"), Providers, GitLab, and background-activity panels. The access, browser,
  devices, SnapShot, and diagnostics pages are not carried, and `movedSettingsPath` never points at
  them; Labs' Beta section has only the Linked environments switch (no guest links or Simlock row); About has no mobile app row, privacy policy link, or update-track switch (#26288);
  storage cleanup lives on Maintenance and Worktrees as upstream's. `hooks/useEnvironmentDisconnectDelay.ts`
  keeps only upstream's `useEnvironmentStateHeldFor`. No Integrations, SnapShot, desktop, diagnostics,
  pairing, mobile app links (`MobileAppSettingsRow`), or `keybindings.json` editor. Settings
  search carries upstream's `sourceControlHostSearchItems` but not `SOURCE_CONTROL_HOST_LABELS`,
  whose routing and agent-credit rows are not carried; the MR link target row lives on Diffs (see
  the merge request seam) with GitLab search terms. Appearance's **Add theme** is upstream's
  `ThemeImportDialog` without its remote theme catalog search or desktop file picker: the browser
  reads picked, dropped, or pasted theme files itself. `settingsLayout.tsx`'s `SettingsSection` takes a
  `description` for the Coder panels below. Connections holds the Coder deployments,
  workspaces, and TCP/UDP port forwards in place of pairing and network access. Each workspace
  row's menu carries upstream's `EnvironmentIconMenu`; the helper reports no `platform.machine`
  (no hardware detection), so a workspace shows the generic server icon until one is picked.
  Providers is upstream's panel and add-instance dialog limited to Codex, Claude, Pi, and Kilo Code
  drivers (Kilo Code is a plain driver choice, not a registry search), without sign-in, setup or managed install, per-instance environment variables, ACP registry, or
  usage-limit sources. Source Control appends GitLab workspace status. Provider update checks
  and the provider health interval do not mention model catalog updates, because the catalog is
  bundled (`ModelManifest.layerBundled`).
  Background activity uses upstream's profiles without host power-monitor intervals or power and
  lock pauses. Upstream's `EnvironmentRow.tsx` and `itemRows.ts` are carried for the scheduled
  task list and the scope notice; `environmentTransportLabel` names every workspace "Coder
  workspace", because there are no routes, T3 Connect, WSL, or SSH targets, so
  `useEnvironmentTransportLabel` ignores the prepared connection. Older fork links that
  name one checkout by its settings key resolve to its group.
- **Project icons.** Upstream's bounded Lucide names, palette, or emoji (`ProjectEmoji`), persisted
  on workspace project records through the project metadata command stream; migration 047 adds the
  nullable `project_icon_json` column. No image-path lookup or external fetch.
- **Scheduled tasks.** Settings → Scheduled tasks and its draft logic are upstream's, including
  interval and fixed-time schedules, run-now, and webhook draft round-tripping. T3 Coder serves no
  inbound webhook route, so the editor has no "On webhook" option, URL field, token rotation, or
  signature, age-limit, filter, replay, and coalesce fields, and rows have no Deliveries dialog or
  "Listening" status.
  Webhook tasks created another way (for example, through the agent `schedule_task` tool) keep
  their stored schedule when edited, but they never run and do not offer Run now.
- **Migrations.** `persistence/Migrations.ts` is upstream's registry with the same IDs. Upstream's
  auth migrations (20–22, 31, 32, and 41) keep their IDs but create nothing. Databases created
  before the fork adopted upstream's IDs recorded a renumbered registry (IDs 41–58, with the
  Coder-only `CoderLegacy/` migrations 050 and 055). `CoderMigrationHistory.ts` finishes that
  registry, whose final schema matches upstream ID 54, and rewrites the history to upstream's IDs
  before upstream's migrator runs. A V2 preview ledger is reconciled before that rewrite, because
  the Coder legacy registry never recorded `OrchestrationV2`. Any other history is left to
  upstream's migrator and its V2 id-clash check, so `Migrations.test.ts` is upstream's, without
  #26288's file-name check (it serves the npm launcher, and the auth IDs have no files). New
  migrations take upstream's next ID; never add a Coder-only migration ID. `migrationEntries`
  stays exported (upstream made it private) for the Coder legacy-history tests.
- **Persistence.** Upstream's offline query persistence, which only its mobile app
  provides a store for, is not carried: client-runtime's `state/runtime.ts` query atoms take no
  `persistence` option and `state/pullRequests.ts` passes none. Its query key normalizer and web
  `pullRequest/filesViewedStore.ts`'s scope key drop upstream's `expectedAccountId`, which the
  contract does not carry. Model favorites, visibility, and order are upstream's server
  settings, so each workspace keeps its own. Upstream migrates a browser's saved lists into an
  environment whose settings have none; here the legacy lists are the workspace's own
  `providerPreferencesByEnvironment` entry, falling back to the global lists
  (`legacyModelPreferences` in `useSettings.ts`). `storage.ts` keeps
  upstream's IndexedDB environment cache, including project favicons, without the connection
  catalog, credentials, or GitHub routing permissions. The upstream idle thread-snapshot retention lifecycle
  keeps Coder's entry and size cap (`threadRetention.ts`). Upstream clears an environment's cached data and
  composer drafts when it is removed; Coder does this only when a workspace leaves the Coder
  config, because stopped and disconnected workspaces also leave the platform registrations.
  The workspace-to-environment mapping that makes this possible is memory-only, so a workspace
  removed before it reconnects after a reload keeps its drafts.
- **Diff panel.** `DiffPanel.tsx`, `DiffPanelShell.tsx`, `diffFileActions.ts`, and
  `components/diffs/*` are upstream's. Coder deltas, each marked `Coder:` in `DiffPanel.tsx`:
  expanded context loads through the chunked review RPCs (`createChunkedGitDiffFileContentsLoader`),
  and a file over the expansion limit is listed in `DiffFileExpansionErrorNotice` above the viewer
  instead of failing the diff. Branch previews ask for one top-level `sourceKind`. A file title
  opens the Files surface through upstream's `openDiffFilePrimaryAction` with no local-editor
  fallback, and the file menu is `fileContextMenu.ts`'s (see Files and search UI) with the route
  thread passed in. Review diffs (`review/ReviewService.ts`) keep upstream's cwd check, which
  admits the server cwd, managed worktrees, and registered project roots.
- **Diff renderer patch.** `patches/@pierre%2Fdiffs@1.6.1.patch` is upstream's patch plus a guard
  that ignores loaded file contents unless the current diff is still the partial diff that asked
  for them, and lets a contents loader return `null` (`FileDiffContentsLoader` and
  `LoadedPartialDiffContents` types), which 1.6.1 still lacks.
- **Browser shell and connections.** Each marked `Coder:`:
  - `connection/platform.ts` registers only the configured Coder workspaces, reached through the
    loopback gateway; removing a workspace from the Coder config clears its drafts and caches.
    client-runtime's `connection/driver.ts`, `connection/index.ts`, `connection/wakeups.ts`, and
    `platform/persistence.ts` drop upstream's multi-route checks, credential and profile stores,
    saved targets, onboarding, GitHub routing, host updates, and the mobile `network-changed`
    wakeup. `connection/supervisor.ts` gives the one route no route kind, so upstream's probe
    timeouts treat it as remote (#25824): the gateway is on loopback, but every RPC crosses
    `coder ssh`. `connection/driver.ts`'s `checkHost` never answers, because the gateway answers
    whether or not the workspace does; the silent socket check then ends only on a frame, and the
    probe timeout decides. `connectedLeaseEnd` ends a lease only on a disconnect (no better routes
    or relay credentials). Upstream's `connection/supervisor.test.ts` is not carried; its harness
    builds the multi-route driver, routes, and relay credentials the fork cuts. `connection/registry.ts` starts every registered workspace's supervisor
    desired (upstream starts only enabled ones), since the Coder config owns registration, and
    applies every platform reconcile (no #26511 skip of unchanged registrations), since its
    reconcile also re-acquires supervisors. Its entries
    carry no cached unsupported-host rejection, so web `state/server.ts`'s shortcut-keybinding
    fallback presents each workspace's connection state as is. It has no `assertKnownAddress` or
    `register(..., { knownAddressOnly })`, since pairing links (#26178) are not carried, and
    `connection/resolver.ts` keeps no remote HTTP prepare path, so #25754's authorized descriptor
    fetch there is not carried.
    `state/shell.ts` treats every workspace as remote (no primary local target).
  - `lib/runtime.ts` has no primary-environment HTTP client, relay, DPoP, or tracer, and
    `branding.ts` fixes the "T3 Coder" name without a desktop bridge or hosted channel.
  - Upstream's desktop IPC contract (`contracts/ipc.ts`) is not carried, nor `themePalette.ts`'s
    desktop-only `resolveDesktopTheme`; `localApiTypes.ts` keeps
    its context-menu and confirm-dialog types (web modules that import `ContextMenuItem` from
    `contracts` upstream import it from there), and `localApi.ts` opens only HTTP(S) links.
    Since the fork's `Window` type has no `desktopBridge`, `ChatHeader.tsx`'s merge request
    button tests `"desktopBridge" in window` and opens the browser at once, as upstream's web
    build does.
    `ThreadNotificationCoordinator.tsx` focuses the tab on a notification click without
    upstream's desktop window reveal.
  - client-runtime `errors/diagnostics.ts` is the `[t3-error]` DevTools reporting described in
    [Authentication](#authentication); `state/runtime.ts` still exports `executeAtomCommand`
    (private upstream since #26238) for its test. `errors/network.ts` keeps only
    `UNRESPONSIVE_HOST_HINT` for upstream's "stopped responding" message (#22212); there is no
    relay network hint, T3 Connect connection diagnosis (#22172), or host-freeze toast.
  - The server's `config.ts` is paths under the workspace state directory only.
  - A thread whose workspace is not connected shows `WorkspaceConnectionStatus`, and so does
    `_chat.index.tsx` after upstream's draft branch (#20183) while workspaces are pending or
    unreachable; the `/projects/$projectKey` redirect has no auth gate.
  - Dropped or pasted folders are neither uploaded nor referenced
    (only files become composer attachments). `ChatComposer.tsx`'s `addComposerFolders` always
    takes upstream's remote-environment branch and shows its "local desktop environment" toast,
    because every workspace is remote; upstream's desktop path lookup (`folderDrop.ts`) is not
    carried. The worktree setup card says "Use project
    checkout", because the checkout is in the workspace.
- **Codex app-server package.** `packages/effect-codex-app-server` is upstream's, including
  `scripts/generate.ts`, which regenerates `_generated/*` byte-for-byte. Coder deltas (marked
  `Coder:`): a spawned Codex child may print a bounded preamble
  (`CHILD_PROCESS_STARTUP_PREAMBLE_MAX_BYTES`) of non-JSON lines before its first
  protocol message, because managed workspace wrappers can emit a banner first; and the `probe`
  script and its example are not carried, because they launch a local Codex.
- **No tracked shell scripts.** The source archive carries no shell script, because a corporate
  download scanner rejects archives that contain one. Upstream's `codexCollabMockPeer.sh` and
  `GitVcsDriverCore.fixture.sh` are not carried; `ProviderInstanceRegistry.test.ts` and
  `GitVcsDriverCore.test.ts` write the same stand-ins into their temporary directories (marked
  `Coder:`).
- **Build tooling.** `scripts/lib/third-party-licenses.ts` reads no device tool version pins,
  because device tools are not carried (upstream's #26440 already commits the SPDX texts under
  `third-party-licenses/spdx`, so builds never fetch). Upstream's
  CI-only checks are not carried, since the fork has no CI: the built web boot check
  (`apps/web/scripts/verify-built-boot.ts`) and the agent context budget test
  (`apps/server/src/provider/AgentContextBudget.test.ts` and `agentContextBudget.json`), which
  measures MCP tool context the file bridge replaces.
  `pnpm-workspace.yaml` sets `supportedArchitectures` (Linux x64 glibc) on every host, because
  the helper bundle ships those native modules to the workspace; upstream sets it only on Windows
  in `.pnpmfile.cjs`, which is not carried. Its `overrides` pin only the patched packages the
  fork carries, where upstream pins every one of its own, plus upstream's single-copy pins for
  Tailwind and lightningcss. `@effect/platform-node>undici` is removed because nothing the fork
  carries uses platform-node's HTTP client, and the gateway pins its own `ws`/`@types/ws`
  instead of upstream's `ws@^8` collapse.
  Packages typecheck with `tsc --noEmit` from Microsoft's TypeScript 7 (`typescript: 7.0.2` in
  the catalog). Upstream's catalog makes `typescript` the `@tsc-rs/typescript` drop-in, whose
  Windows `tsc.exe` is an unsigned third-party binary that the laptop's endpoint security may
  block, while Microsoft's is Authenticode-signed; so the fork keeps TypeScript 7 and omits the
  `@tsc-rs/typescript` build approval, upstream's `typescript` peer rule, and its
  `.pnpmfile.cjs` peer-range hook. The fork never ran upstream's Effect language-service
  diagnostics (`@effect/tsgo`) either.
  Root `engines.node` stays `^24.13.1`; upstream pins `26.12.1` for its standalone executable
  builds, which the fork does not carry.
  `patches/@ff-labs__fff-node@0.11.0.patch` is upstream's plus the native grep struct's
  `fuzzy_score` read at its real u16 width; 0.11.0 still reads it as a u32, which shifts
  `has_fuzzy_score`, `is_binary`, and `is_definition` one field late.
  `patches/@legendapp__list@3.3.5.patch` is upstream's `react.js` and `react.mjs` sections only,
  since the other sections patch React Native builds. `knip.jsonc` lists the upstream files whose exports are used only by surfaces the fork
  does not carry, so `pnpm knip:check` still catches fork-introduced dead exports elsewhere.
  The real-Coder live harness behind `pnpm coder:live:*` and `pnpm test:coder:live`
  (`scripts/coder-live-test.mjs` and `scripts/coder-live-template/`) is kept local and is not
  committed, because it provisions external tooling; `.gitignore` excludes both, so those scripts
  fail in a fresh clone. Its two checks are tracked: `scripts/coder-live-images.mjs` drives a
  running gateway's signed upload and asset URLs against a connected workspace, and
  `scripts/coder-live-provider-images.mjs` (`pnpm coder:live:providers`) runs one real turn per
  provider, which needs authenticated workspace or local Codex and Claude Code CLIs and spends
  their quota.
- **Upstream tests.** `storageCleanup.test.ts` roots its test config at the temp directory's real
  path, and its orphan-report test expects the orphan's real path, so its path checks pass on
  macOS, where the temp directory is behind the `/var` symlink.
  `serverSettings.test.ts` omits upstream's source control host secret tests, and drops the host
  tokens from its shared secret-lifecycle test, because no carried host definition declares
  settings; it also omits the credential-migration test, which reads the uncarried Antigravity
  and OpenCode settings schemas. `ClaudeAdapterV2.test.ts` drives upstream's MCP control-channel
  tests through a fake `claude` executable, since the CLI transport has no SDK spawn hook, and
  `ClaudeAgentSdkQueryRunner.test.ts` stubs the CLI transport's `query` shim rather than the
  Agent SDK's, and omits upstream's SDK transcript-copy fork tests, since the CLI forks natively. `ProviderSessionManager.test.ts`'s parallel shutdown test waits briefly in real time
  after moving the test clock, because each release closes a T3 tool bridge on the real file
  system. Upstream's GitHub and Azure DevOps fixtures in the GitManager, review-guide, guide-tool,
  T3 tool bridge, sync-key, and linked-thread tests use GitLab projects and merge request URLs
  (`refs/merge-requests/<n>/head`, "MR" toasts); `GitManager.test.ts` is upstream's fake-provider
  harness with a GitLab default kind, and the fork's old fake-`gh` only-remote, template,
  fast-forward-only checkout, and merge-request-ref cases are not carried, since upstream moved
  host behaviour tests into the forge packages (#24000). Tests of uncarried hosts' behaviour
  (Azure key canonicalisation and aliases, Forgejo ports, Bitbucket and Azure list cases, GitHub
  legacy actions and term cases) are cut from the pull-request, linked-thread, handler, client
  link, thread pull request, git action, and list-logic tests. `linkCreatedPullRequest.test.ts`
  uses GitLab merge request URLs; `PullRequestSyncReactor.test.ts` runs its close-command case on
  `glab mr merge`/`glab mr close` and does not carry the native stack auto-link test. `ProviderInstanceRegistry.test.ts` runs upstream's Claude one-probe fallback test
  against the CLI transport's `query`, without the organization change the fork does not read.
  `SourceControlRepositoryService.test.ts` and `RepositoryIdentityResolver.test.ts` carry
  upstream's new publish-push, local-remote, display-casing, partial-clone, and missing-parent
  clone cases on GitLab remotes with the fork's mocks. `ProviderRegistry.test.ts` runs upstream's
  startup settings-change hydration tests without the uncarried Antigravity and OpenCode layers.
  `PullRequestService.test.ts`'s shared merge request read tests (#24392) pass branded GitLab
  kinds to the fork's typed project helper. Shared `AgentScope.ts` leaves out upstream's
  `agentScopeLauncherScript` (#27239), which only the uncarried preview browser launches, and
  `AgentScope.test.ts` drops its launcher check.
  `ThreadDetailsPrRows.browser.test.tsx` checks the run context, not the editor picker. `CommandPalette.browser.test.tsx`
  mocks `useCoder`, and `GitLabPullRequestCli.legacy.test.ts` expects the fork's `DIFF_MAX_OUTPUT_BYTES`.
  `SourceControlProviderRegistry.test.ts` is upstream's fake-driver file, with its unknown-host
  fallback on a GitLab remote and a GitHub URL among the URLs no host claims.
  `SourceControlRepositoryService.test.ts` does not carry upstream's two new lookup-detail tests. `DatabaseStorage.test.ts` omits upstream's two `t3 doctor` status tests,
  `storageCleanup.test.ts` its saved-usage-cache test, and `PullRequestService.test.ts` its
  GitHub-credential branch deletion, GitHub Enterprise listing, Bitbucket paging, routing,
  Forgejo, replacement-read retry, Azure environment viewed-file, and repository-identity
  resolution tests; client-runtime's `pullRequests.test.ts` uses one connection target without
  upstream's cross-environment routing tests (shared probes, alternates, routed viewed marks and
  writes); upstream's OTLP `config.test.ts` is not carried.
  `presentation.test.ts` omits upstream's disabled and unsupported connection tests, since Coder
  catalog entries have neither state. `GitManager.test.ts`'s pull request draft-status test and
  `SourceControlRepositoryService.test.ts`'s HTTPS clone-retry tests run on GitLab.
  The fork-only `hooks/useThreadActionMenu.test.tsx` keeps upstream's deleted hook test beside
  upstream's `useThreadActionMenu.test.ts`.
  Replay fixtures (`orchestration-v2/testkit/fixtures`) carry only the Claude, Codex, Pi, and ACP
  Registry providers; `ProviderReplayFixtures.ts` lists only those drivers.
  client-runtime's `threadShell.test.ts` omits upstream's switched-off environment test, because
  the Coder config owns registration and there is no per-environment switch.
  client-runtime's `threads-sync.test.ts` and `threads-atoms.test.ts` fake older history pages
  over the helper's history RPC (`threadHistoryHttp.ts`) instead of upstream's HTTP client.
  `ws.test.ts` omits upstream's config-RPC buffering test, which builds upstream's session-scoped
  `layerWsRpc`. Upstream's `composerContextUndo.test.ts` (preview annotations
  only) is not carried; `DiffPanel.browser.test.tsx` passes `onOpenFile` without an editor mock,
  and `ProjectSettingsPanel.browser.test.tsx` keeps `projects.getConfig` pending as upstream
  keeps its file read.
  `pullRequestsRouteSearch.test.ts` runs under happy-dom, because the route module loads the diff
  worker, which needs a browser `self`. Upstream's `*.browser.test.*` files run in headless
  Chromium through Playwright as upstream's `browser` Vitest project, on the development machine
  only; `reactCompilerCoverage.test.ts` skips four fork-only files the compiler bails on
  (`CODER_UNCOMPILED_FILES`). The fork keeps `jsdom` and `react-test-renderer` as web dev
  dependencies for its own unit tests and for fork-adapted suites that stay unit tests in place
  of upstream's browser versions: `ChatMarkdown.test.tsx` (upstream's `ChatMarkdown.browser` and
  `ChatMarkdown.permissions.browser` tests are not carried), `ProjectSettingsPanel.test.tsx`, and `RightPanelTabs.test.tsx`
  (upstream's `RightPanelTabs.browser.test.tsx` is not carried). The carried browser tests omit
  cases for cut surfaces: grant checks in `ProjectSettingsPanel`, uncarried providers in
  `ProviderModelPicker`, and preview mocks in `ReopenClosedViewShortcut`.
- **Omitted surfaces.** Desktop, mobile, hosted web, browser preview, telemetry, OTLP and trace
  export, the diagnostics page, usage dashboards, and hosted providers other than GitLab. Without
  browser preview, `composerDraftStore.ts` does not keep an empty draft alive for an open page,
  and the desktop default-browser handoff (`DesktopWebLinkCoordinator`) is not carried. Without
  the usage page, `timestampFormat.ts` has no `resolveHour12`. Prompt links (upstream's
  `components/promptLinks/`, the "Copy prompt link" actions in the command palette and on user
  messages) are not carried, because they open the hosted web app.

## Distribution

`npm start` builds the web client and a Linux x86-64 helper bundle from the checked-out source and
lockfile, including the locked native runtime packages needed by terminals and workspace search,
then starts the local gateway and opens its loopback URL in the default browser. Connecting never installs from npm or
downloads an application update. The first connection may download the pinned Node.js package
through Nix if it is not already in the workspace's Nix store. The gateway hashes the locally
built helper bundle (SHA-256 over its relative paths and contents) once per session and passes the
hash to the helper launch, which compares it with the `.t3-bundle-sha256` file in the installed
helper directory. When they differ, the launch prints `T3_CODER_HELPER_INSTALL_REQUIRED` and exits
before starting the helper; the gateway then replaces the remote helper directory with the local
bundle over `coder ssh` stdin, verifies and records the hash, and launches again. A workspace whose helper
is current therefore connects with one `coder ssh` session and no transfer. Connection diagnostics
show the preflight, any installation, and helper negotiation as separate phases.

### Workspace retention

The helper runs upstream's opt-in storage cleanup policies. Worktree cleanup holds the same
workspace lease as provider startup and terminal open, rechecks sessions and Git state,
and preserves branches and thread history. Artifact retention maps upstream's browser-artifact
store to the legacy `screenshotArtifactsDir`; it never visits `attachmentsDir` or current image
source paths. Artifact, worktree, and rotated-log policies are disabled by default.
Upstream's **Delete now** action and latest cleanup report travel over the helper's
`server.runStorageCleanup` and `server.getStorageCleanupReport` RPCs; the report keeps only the
latest sweep in helper memory. Each of these is marked `Coder:`:

- `coderServer.ts` builds `StorageCleanup.layer` after `CoderRuntimeStartup` completes, where upstream
  parks its sweeps until server activation.
- The report calls artifact rows "saved image artifacts".
