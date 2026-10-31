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

The header's workspace health card shows Coder's workspace health from the status loop's
`coder list --output json`. While the card is open, the browser asks the connected helper for
CPU, memory, and home-disk usage every ten seconds over its existing RPC connection
(`coder.workspaceResourceUsage`). The helper runs Coder's `coder stat` commands in the workspace
and accepts only their fixed JSON result shape, so the laptop starts no process for it. Nothing
samples resources while the card is closed.

For every connected workspace, the gateway starts one foreground process through the authenticated
Coder CLI. The process runs a version-matched helper in the Linux workspace and carries T3's Effect
RPC envelopes as newline-delimited JSON over stdin and stdout. The helper has no HTTP server,
WebSocket server, or other listening socket. Closing the Coder connection stops the helper and any
active turn: the gateway sends the helper the gateway-only `coder.helper.shutdown` request, so the
helper exits and `coder ssh` closes its session itself (Coder's remote PTY never delivers
end-of-file, and on Windows a signal force-stops `coder.exe`), then escalates to SIGTERM and SIGKILL
one grace period apart (`packages/coder-cli/src/processTermination.ts`, shared by every Coder
child process). The helper launch switches the remote PTY to raw mode before its ready line and
reports a preflight failure if `stty` cannot. Reloading or temporarily disconnecting the browser does not stop the helper; the
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
merge-request diffs are paged by file below the `CODER_RPC_FRAME_MAX_BYTES` frame. Migration
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
directory as its own and, once another helper in the workspace recreates it (the mark differs or
is gone), stops serving and leaves it in place; a call directory a killed CLI left behind is
removed once it is older than `STALE_CALL_MS`. If a bridge cannot be
created, turns run without T3 tools. Workspace processes run as the same OS user; these
directories are not an isolation boundary between mutually untrusted agents.

The bridge carries upstream's orchestrator, thread, attachment, project, environment, worktree,
pull-request, and `html_render` toolkits. The pull-request tools accept only merge requests on a
GitLab host that a workspace project uses; project clones go through the same GitLab-only repository
service as the browser. With no HTTP origin to upload to, `t3_attachment_prepare_upload` takes the
absolute workspace path of a file the agent already has and stores it as a pending upload in
process, so attachment bytes never pass through the bridge's request files. Attachments reach only
threads in the caller's own workspace: the attachment tools take no `environmentId`, as upstream's,
so a thread in a linked workspace answers `thread_not_found`, and an upload forwarded through the
gateway hub is refused because its path would name a file in the other workspace. Preview, device,
and `html_preview` toolkits are not carried, and neither is upstream's MCP HTTP server.

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
browser -> 127.0.0.1 gateway -> coder ssh stdio -> workspace helper -> coder stat
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

Provider version checks are workspace-originated network requests: the helper asks the
workspace's own `npm view` (its configured registry, #27847) and otherwise `registry.npmjs.org`
for the latest version of each enabled provider whose installer it can identify; manual installations are not checked. The workspace setting `enableProviderUpdateChecks`
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
listed here or under [Cut surfaces](#cut-surfaces) is drift to remove rather than fork behavior to
keep. Each entry names the file or symbol and the delta; the code carries a `Coder:` comment at each
one, except the merge-request wording swap ([Wording](#wording)). `node scripts/seams-check.mjs`
checks that every name here still exists and that every modified upstream file is marked or listed.

### Helper runtime and transport

- `ws.ts`, `server.ts`, `serverRuntimeStartup.ts`: upstream's files minus the cut surfaces; the
  fork's handlers and layers live in `coderWs.ts` and `coderServer.ts`. `ws.ts` keeps upstream's
  `layerWsRpc` and handler order, builds the methods it carries over the gateway's stdio bridge, and
  returns them merged with `coderWs.ts`'s at one hook as `CoderWsRpcGroup` (upstream's two disjoint
  handler groups split the whole group, fork-only methods included).
- `server.ts` exports the layer declarations the helper uses at one hook; `coderServer.ts`'s
  `makeCoderRuntimeLayer` composes them with the Coder provider and orchestration layers,
  `CoderRuntimeStartup`, `StorageCleanup`, `DatabaseStorage`, the T3 tool bridge binding, and the
  RPC layer. In `server.ts`, settings also provide the secret store, the VCS status broadcaster
  takes the demand-only background policy, and the terminal shares its PTY adapter and process
  runner with no port scanner or native telemetry.
- `CoderRuntimeStartup` completes before the RPC layer is built, replacing upstream's startup
  command queue, with upstream's recovery order (provider runtimes, then `recoverDelegatedTasks`);
  `coderServer.ts` starts the delegated-task question reactor with the other workers, and
  welcome/ready events are synthesized from workspace projections.
- The helper sends Effect logs to stderr, which the launch discards (`2>/dev/null`, because Coder's
  remote PTY merges it into stdout), so handler defects are not observable; T3 keeps no log file.
- Server config comes from the Coder environment descriptor. A failed keybinding-config load falls
  back to defaults; config subscriptions do not force a provider refresh.
- `coderEnvironment.ts` advertises upstream's capabilities and protocol version except
  `CODER_OMITTED_CAPABILITIES`, each with a reason; `coderEnvironment.test.ts` fails on a key in
  neither list. It also declares `ServerEnvironmentIdentity`, which `ThreadManagementService.ts`
  imports from the uncarried `environment/`, with upstream's `makeIdentity` persistence carried as
  is (temp file linked without replacing, so concurrent helpers agree on one id), and advertises
  `providerWorkspaceSnapshotsOnDemand`.
- `coderWs.ts` (`CODER_WS_METHODS`) adds local ref status, branch and worktree rename
  (`moveWorktree`), chunked review files, the gateway's asset stream (`coder.serveAsset`) and upload
  body (`coder.writeRequestBody`), fixed project-config reads, merge-request diffs, and upstream's
  HTTP thread snapshot (`orchestration.getThreadSnapshot`), history page (`getThreadHistoryPage`),
  and transcript (`orchestration.getThreadTranscript`) over stdio. Their payloads carry `view` and a
  boolean `deferWork` and omit `compactIds`. Snapshots and pages keep `targetBytes` budgets and the
  newest requested turn, and fail before encoding when over the stdio frame; a transcript over the
  limit fails with `OrchestrationThreadTranscriptTooLargeError`.
- `ws.ts`: `withPullRequestViewer` is an identity (GitLab uses the workspace's `glab` login); the
  on-demand workspace-snapshot stripping (`workspaceSnapshotsOnDemand`) has no usage-limit commands.
- `persistence/DatabaseStorage.ts` is built beside `StorageCleanup` once startup completes; its
  `t3 doctor` file-size status is cut (no CLI in the helper).
- `coderServer.ts` runs upstream's idle Claude compaction worker (`layerIdleCompactionWorker`) in
  `CoderRuntimeCoreLive` and gives `ProviderRegistry` the provider support layer
  (`CoderProviderRegistryLive`).
- `workspace/WorkspaceFileSystem.ts`, `WorkspaceEntries.ts`, `WorkspaceSearchIndex.ts`: a folder
  listing returns at most `MAX_PROJECT_DIRECTORY_ENTRIES` children, because a larger reply ends the
  helper connection.
- Office document text (#21358): `apps/coder-helper/src/bin.ts` dispatches upstream's
  `__document-text` argument and imports only the worker on that path (the stdio runtime in
  `helper.ts` loads lazily); `DocumentText.ts` runs that `bin.ts` from source or the bundle
  (`import.meta.url`); `coderServer.ts` provides `DocumentText.layer`, and `ProviderHostLive`
  carries `resolveExtractedTextPath`.
- `config.ts` (server) is paths under the workspace state directory only.
- Transcript drops: client-runtime's `threadTranscript` is an RPC command, so the orchestration
  atoms need no HTTP client; the composer reports `OrchestrationThreadTranscriptTooLargeError` as
  upstream reports `thread_transcript_too_large`.
- Linked environments (#16653–#17130) run between Coder workspaces through the gateway hub instead
  of server-to-server HTTP `/mcp` and pairing (`AGENTS.md` boundaries 2, 3, and 6).
  `peer/PeerMcpClient.ts` and `peer/PeerLinks.ts` keep upstream's service tags but send calls and
  read links through `coderHub.ts` (helper protocol v3: `coder.hub.outbox`, `coder.hub.reply`,
  `coder.hub.invoke` in `packages/coder-cli/src/rpc.ts`); the gateway (`hub.ts`) checks the
  requester's `workspaceLinks` rule (edited in `WorkspaceLinkSettings.tsx`) and runs the call on the
  target helper as `coder-link:<rule id>` with the rule's access and the caller's modes as
  `narrowedTo`. A workspace that is not connected answers `orchestration_error`; no matching rule
  answers `capability_denied`; editing a rule's endpoints mints a new id. No `T3-Mode-Limit` header;
  `PeerLinks` has no pairing, storage, or expiry (`expiresAt` is far-future); `coder.hub.invoke`
  refuses calls while Labs' switch is off with a non-final `orchestration_error`; `T3ToolBridge`'s
  binding gains `invoke`; `t3_environment_links`' `notListed` and the orchestration instructions
  point to the Links settings. Migrations 070 and 071 keep their IDs and create nothing. `peerLinks`
  and `linkFence` are advertised; `mcpModeLimitHeader` is omitted. `threadShell.test.ts`'s
  linked-task case drops the switched-off parent step. Cut client pieces are under [Cut
  surfaces](#cut-surfaces).
- The `@` picker lists no threads on linked machines (#26201): `composerThreadItems.ts`, shared
  `composerContextReferences.ts` (`threadContextsOutsideEnvironment`), and the composer hooks keep
  the same-server rules.

### Providers and orchestration

- `Drivers/ClaudeCli.ts` implements the Agent SDK's `query()` and `Query` over the workspace
  `claude` executable. Rollback and resume use `resumeSessionAt`. A stream-json line may use the 32
  MiB pending-message budget (a 10 MiB base64 tool-result image fits); longer fails the session.
  Plain-text stdout lines before the first JSON line are dropped (managed launchers print a banner).
  `Query` methods sent as control requests: `interrupt`, `stopTask`, `setModel`,
  `setPermissionMode`, `setMaxThinkingTokens`, `applyFlagSettings`, `getContextUsage`,
  `getSettings`, `getUsage` (with `skipBehaviors`), `setMcpServers` (no deadline), `backgroundTasks`
  (resolves to `backgrounded`, true when absent), `initializationResult`, and `close`.
  `can_use_tool` passes `matchedAskRule` and `suppressAlwaysAllowRule` to `canUseTool`.
- `Drivers/ClaudeAgentSdk.ts` provides SDK-typed `query` and `getSubagentMessages` over the CLI,
  typed as the full SDK `Query` so a new method fails typecheck until mapped or rejected; it answers
  `supportedCommands`, `supportedModels`, `supportedAgents`, and `accountInfo` from the initialize
  response and rejects every other method. Options the CLI cannot honour fail
  (`SUPPORTED_QUERY_OPTIONS`); `mcpServers` becomes `--mcp-config` and in-process (`sdk`) servers
  are rejected; `executableArgs` go before the CLI's arguments; `spawnClaudeCodeProcess` starts the
  CLI as the SDK does (its stderr is not read). Launch args reach the CLI except the stream-json
  transport flags.
- No `forkSession`: `ClaudeAdapterV2.forkThread` stores the source session and boundary as
  `claudeFork` metadata, and the fork's first query runs
  `--resume --fork-session --resume-session-at --session-id`. Fork-head capture (#21188,
  `forkHeadMessageId`) is not carried. Forks also carry `claudeAttachmentBudget`.
- `ClaudeAdapterV2.ts`: pasted images go through `resolvePastedImageAttachments`, counted toward
  the PDF and attachment budget by `sizeBytes`; bridge sessions get
  `CLAUDE_BRIDGE_BACKGROUND_WAIT_INSTRUCTIONS` (no ToolSearch sentence); the query runner gives CLI
  jobs no agent-thread variable and counts no agent for port discovery; no `deviceToolsAvailable`
  input or `SubagentStart` device hook; `resolveBypassAvailability` reads the settings files (cached
  remote, user, project, local, managed) where upstream calls the SDK's `resolveSettings`, and
  `resolveSubagentPromptCacheTtl` reads `subagentPromptCacheTtl` from them (last set wins).
  `Drivers/ClaudeSkills.ts` keeps `claudeSettingsPaths` exported for that. Upstream's out-of-process
  `runClaudeWorker` is not carried; only `encodeClaudeJson` stays.
- T3 tools over the file bridge, not MCP (`AGENTS.md` boundary 6): `mcp/McpSessionRegistry.ts`
  keeps upstream's lifecycle, but each credential is a bridge (`mcp/bridge/FileBridge.ts`) whose
  `toolCommand` (a Coder field on provider-core's `McpProviderSessionConfig`) runs the tools and
  whose `endpoint` is the per-thread directory; `mcp/bridge/T3ToolBridge.ts` runs upstream's
  handlers by name with the credential's `McpInvocationContext`, refuses non-read-only tools in plan
  mode (and any call when the thread cannot be read), turns slow calls into `bridge-job:` tasks
  (the per-thread cap counts running tasks and is checked before a call starts; a finished result
  stays until its reply is published), and prints `advertisedJsonSchema` for `--schema`.
- `toolkits/environment/` reads the `CoderEnvironment` descriptor in place of `ServerEnvironment`.
- provider-core's `server/t3ToolBridgeInstructions.ts` reuses upstream's orchestration sections,
  rewriting "`html_preview`, then `html_render`" to "`html_render`" and dropping the `preview_*`
  bullet; its test fails if upstream rewords them.
- `CodexAdapterV2.ts` configures no `mcp_servers`, attaches T3 context only when the bridge exists,
  and takes the bridge text as `t3ToolBridgeSections` (one context entry per section, under
  `CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES`); `CodexDeveloperInstructions.ts` and
  `ClaudeAdapterV2.ts` describe the bridge command, and Claude pre-approves it as a Bash prefix
  (read-only tools in a read-only sandbox). `CodexAdapterV2` does not rewrite failures through
  `CodexManagedErrors`.
- `PastedImageAttachments.ts` is the only provider image reader: `localImage` paths for Codex,
  base64 for Claude; Read-tool image views are limited to PNG, JPEG, and WebP; Codex branch-name and
  title generation read images through it.
- `AttachmentClaims.ts` reads each staged upload once through a no-follow handle at its exact size,
  checks image signatures, and writes `0600` copies; `ResourceCleanupService.ts` skips attachment
  deletion and closes no preview sessions.
- `attachmentStore.ts` resolves the fork's pre-upstream `<uuid>.<ext>` images as
  `legacy-<uuid>-<ext>` ids that are never claimable.
- `provider/builtInDrivers.ts` registers only Codex, Claude, Pi, and Kilo Code, with no usage
  driver list; `settingsSecrets.ts` reads secret fields from Pi's and the ACP Registry's client
  definitions only; `ProviderOrchestrationAdapterInfrastructure.ts` provides only the Claude query
  runner and the Codex app-server factory; `ProviderInstanceRegistryHydration.ts` seeds no replay
  instance and needs no `PortDiscovery` or `Crypto`; `testkit/DormantProviderCapabilities.ts` is
  kept for orchestrator tests.
- Pi: `buildPiRpcLaunch` hands upstream's T3 extension the file bridge (`T3_TOOL_COMMAND`,
  `T3_TOOL_CATALOG`); it registers the catalog's tools under upstream's names, runs each through the
  bridge with arguments on stdin, returns the printed JSON as `structuredContent`, and maps
  `readOnly` to `readOnlyHint`. `mcpExtensionSource.ts` keeps upstream's HTTP MCP client dormant
  (never given `T3_MCP_URL`).
- Pi text generation (`provider-pi/src/server/textGeneration.ts`) loads the workspace's Pi
  extensions (no `--no-extensions`), since one may register the only reachable model providers.
- `textGeneration/ClaudeTextGeneration.ts` drops plain-text stdout lines before the first JSON
  line, as `ClaudeCli.ts` does.
- Kilo Code is upstream's ACP Registry driver (`@t3tools/provider-acp-registry`, kind
  `acpRegistry`) limited to the local `kilo acp` command: `settings.ts` keeps only `commandPath`
  (default `kilo`), hidden `commandArgs` (`["acp"]`), `customModels`, and `enabled` (default off;
  contracts' `DEFAULT_DISABLED_PROVIDER_DRIVERS` lists `acpRegistry`); `client.ts` labels it "Kilo
  Code", inlines its icon, and has a default instance; `AcpRegistrySupport.ts` keeps only
  local-command `inspect` and `resolve` (no `acpRegistryManagedBinaryDirectories`); `probe.ts` sends
  no session-management requests; `driver.ts` reports only local readiness (`canAuthenticate` false,
  sign-in told to happen in the workspace), and real sessions set
  `authenticateOnAuthRequired: false`; the probe declines URL elicitation; `driver.ts` keeps
  `acpRegistrySnapshotReadiness` and `testing.ts` keeps `probeAcpRegistryConfiguration` exported for
  the fork's tests; `AcpRegistryRuntimeCoordinator.ts` has no URL-auth consent or session mutation
  permit; `adapter.ts` has no Devin, Copilot, or Mistral Vibe flavor or native logging.
- `ProviderRegistry.ts` treats a ready Kilo Code snapshot listing a model beyond `default` as a
  completed probe, since this driver reports no `nativeSessions`.
- provider-acp's `adapter.ts` gives ACP sessions no MCP server and sends `t3ToolBridgeInstructions`
  with the first prompt through provider-core's `t3AcpPromptWithInstructions`; `mcpOverAcpBridge.ts`
  and `clientTerminals.ts` stay dormant (cutting them would add about 34 seams).
  `scripts/acp-mock-agent.ts` keeps `T3_ACP_COMMAND_ADVERTISEMENT_DELAY_MS` for the adapter test.
  The user guide is the fork's `docs/user/providers-kilo.md`, adapted from upstream's
  `providers-acp.md` (not carried).
- `project/AgentSessionScanner.ts` declares `resolvePiSessionsDir` (upstream exports it from Pi's
  uncarried usage reader); `coderServer.ts` provides the scanner; `ImportAgentSessionsDialog.tsx`
  runs the welcome wizard's import step from **Settings → Providers → History**.
- `ProviderAuthService` reports every sign-in, logout, and credential transfer unavailable;
  `CodexManagedRuntime` keeps only upstream's resolution contract; `ProviderHostLive` gives drivers
  no credential store.
- `CodexDriver` offers no managed install (`setupMode: "managed"`, so no `compatibility` hook), has
  no `CodexUsageHistory`, and redeems no rate-limit reset credits; `ClaudeDriver` reads no
  organization id, so its one-probe fallback skips the same-organization check; the Claude
  signed-out message names API credentials. `ModelManifest.layerBundled` serves the bundled manifest
  with no fetch or disk cache.
- Runtime modes: Claude and Codex fill upstream's provider-level `supportedRuntimeModes` from
  workspace policy (Claude's `disableAutoMode`/`disableBypassPermissionsMode` through `ClaudeCli`,
  Codex's `configRequirements/read`), reporting the safe modes until the first probe and on failure
  (`provider/runtimeModeCapabilities.ts`, `provider/CodexRuntimeModes.ts`). A mode the provider does
  not offer steps down to the broadest offered mode below it in `runtimeModeConfig.ts`'s
  `resolveCompatibleRuntimeMode` and `RuntimePolicy.providerRuntimeMode`, as
  `delegatedTaskModes.resolveRuntimeMode` already does.
- No metrics: `Orchestrator.ts` and `ProjectService.ts` have no `withCommandMetrics`,
  `ProviderSessionManager.ts` no session or turn metrics, `ScheduledTaskService.ts` no webhook
  metrics, `SecretRequests.ts` no consumed-ref count, `EventSink.ts` no run outcome metrics
  (`RunMetrics.ts`), and `RunExecutionService.ts` no `PreviewAgentActivity`. `EventNdjsonLogger` and
  `ProviderEventLoggers` keep only the no-op service. provider-core's `maintenanceResolver.ts` and
  `providerStatusCache.ts` log the first cause tag in place of the omitted observability helper.
- No `lastErrorCode`: the server's `threadErrorSummary`, `ProjectionStore.ts`'s shell state,
  client-runtime's `ThreadRuntimeSummary` and `state/models.ts` drop it (the contract field stays).
- `mcp/toolkits/orchestrator/handlers.ts` has no `t3_environment_link` or `t3_environment_unlink`.
- `mcp/toolkits/attachment/tools.ts`: `t3_attachment_prepare_upload` takes a `path` beside
  `upload`, needs storage's services, returns only `attachmentId`, and its description names the
  path instead of a URL to POST to. `handlers.ts` stores the file through upstream's
  `validateAttachmentUploadToken` and `storeAttachmentUpload` (`storeWorkspaceFile`) after checking
  it is an absolute path to a regular file of exactly `upload.sizeBytes`, and refuses a call the
  gateway hub forwards (`client.linked`). Upstream's `core.test.ts` attachment cases run in
  `attachment/handlers.test.ts`.
- `persistence/Errors.ts` has no pairing-link correlation or auth repository errors.

### HTML renders

- The bridge carries `html_render` only. `htmlRender/HtmlRender.ts` keeps image inlining and
  storage without `preview` or height measurement (work workspaces cannot obtain the headless
  browser); the tool description omits `html_preview` and the mobile scroll-cap sentence.
- `htmlRenderFromBridgeCommand` (shared `toolOutput.ts`) recognizes a completed
  `t3.mjs html_render` bridge command; `WireProjection` keeps only that compact reference.
- Pages are kept like other attachments; deleting a thread does not delete them.

### Contracts

- `rpc.ts` omits RPCs whose schemas belong to cut modules (chat attachment persistence, preview
  automation, relay, resource telemetry, usage, editor launch, GitHub routing, feedback upload, OTLP
  check) and adds the helper-only methods and `CoderWsRpcGroup`, the only group the helper serves.
  Upstream's `WsRpcGroup` stays dormant (`knip.jsonc` ignores `rpc.ts`'s unused exports).
  `CoderWsRpcGroup` omits `server.getDatabaseStorage`, `server.getNpmRelease`,
  `server.prepareTriage`, `preview.stopLocalServer`, guest share creation, the peer-link RPCs, and
  the `sourceControl.signIn*`, `sourceControl.appAccess`, and `sourceControl.starred` RPCs.
- `server.ts` (contracts) mirrors `ipc.ts`'s `DesktopUpdateChannelSchema` for
  `ServerSelfUpdateInput`, because `ipc.ts` is not carried.
- `ServerConfig` omits auth, editors, remote open targets, and observability; the optional
  `lastEventLoopStall` stays in the schema but is never sent.
- `vcs.ts` and `git.ts` add the helper-only ref-status and thread-branch rename schemas;
  `assets.ts` omits native app icons; tool items keep legacy screenshot `artifacts`; rate-limit
  events carry the raw payload.
- Terminal attach input adds `afterSequence` and `afterEpoch`, snapshots add `attachEpoch`, and the
  attach stream adds a `resumed` event.
- Client settings keep `providerPreferencesByEnvironment`, read only as the legacy lists each
  workspace migrates (see [Web state and persistence](#web-state-and-persistence)).

### Terminals

- `terminal/Manager.ts` keeps a bounded attach replay window (`DEFAULT_ATTACH_REPLAY_*`) and
  answers an attach with `afterSequence` by replaying the gap and a `resumed` event; each shell
  session has an `attachEpoch`, and a cursor naming another epoch gets a snapshot. Terminals poll
  the process table themselves, register no ports, record no metrics, and get no managed ACP
  directories on `PATH`.
- client-runtime adds `TerminalBufferCache`, a bounded memory cache that seeds a reattach and
  supplies its `afterSequence` and `afterEpoch`; a resumed attach of a closed terminal gets
  upstream's `closed` event. `ThreadTerminalDrawer` never opens terminal links.

### Source control and merge requests

- `source-control-definitions`' `registry.ts` registers only GitLab's definition and the server's
  `sourceControl/sourceControlDefinitions.ts` only the GitLab driver, so every other kind reads as
  the generic host. `sourceControlClients.ts` drops `readHostCredentialSettings` and its types. The
  registry's `parseChangeRequestUrl` (core `shared/definition.ts`) rejects a URL with credentials.
  `canonicalizeGitCafePullRequestUrl` is an identity.
- source-control-core drops the driver's `signIn` and `isRepositoryStarred`, the definition's
  `appSignIn` and `signIns`, and `SourceControlHost.settings.update` and `getWithSecrets` (also from
  the test host); core's `SourceControlMediaRequest` adds `cwd`, which
  `sourceControlMediaResponse.ts` passes from the claim.
- `sourceControlHostSecrets.ts` has no secret-reference resolution or invalidation, so
  `server.refreshProviders`' `reloadSecrets` invalidates nothing.
- GitLab's definition (`source-control-gitlab/src/shared/definition.ts`): `authorProfileUrl` links
  authors under the host root; `referenceAutolinks` (`shared/referenceAutolinks.ts`) links `!N`,
  `#N`, and full SHAs with GitLab's `/-/` routes; `mediaUrl` (`shared/gitLabMedia.ts`) claims
  Markdown uploads and maps them to the projects uploads API, which the driver's `fetchMedia`
  (`server/GitLabMediaFetch.ts`) reads with `glab api` in the minted `cwd` (no `--hostname`),
  buffering at most `GITLAB_MEDIA_MAX_BYTES`. The package also exports `server/GitLabCli`, which
  `ws.projects.test.ts` stubs.
- `GitLabCli.ts` fixes bugs still in upstream (checked against upstream `main` 80a2351fcb): merge
  requests between projects post to the source project with a numeric `target_project_id`; merge
  request URLs reach `glab` as `--repo <url> … -- <iid>`. `glab auth status` lines with a token
  label or `glpat-` token are never surfaced; clones accept only GitLab URLs without credentials,
  query, or fragment and pass `--` before the URL; diff output is capped (`DIFF_MAX_OUTPUT_BYTES`)
  under `CODER_RPC_FRAME_MAX_BYTES`; `GitLabCli` supplies "Merge request not found." as its detail.
- `PullRequestService` omits cross-environment routing (routing identities, verified credentials,
  `expectedAccountId` refs) and runs delete-branch without the verified-credential wrapper.
- `coderServer.ts` uses `server.ts`'s `layerRepositoryIdentityResolver`, whose refine hook lets
  GitLab confirm a self-hosted host through `glab`, and provides `FetchHttpClient`.
- Shared `sourceControl.ts` adds `parseGitLabCloneSource`, which keeps a small table of other hosts
  so their URLs are still rejected.
- Review guides: `coderServer.ts` provides `PullRequestReviewGuideService` to the RPC handlers and
  bridged tools; the guide tools resolve only merge requests on a GitLab host the projects use, and
  the service's reader-facing errors say merge request and `!N`.
- The pull-request T3 tools accept only merge requests on a GitLab host a workspace project uses.
- Web merge requests: diffs come over `pullRequests.diff` without GitHub routing; a project's
  default merge method is a workspace setting whose `null` means "last selected"; client-runtime
  `pullRequestMarkdown.ts`'s `resolveGitLabUploadUrl` resolves `/uploads/` below the repository, and
  `PullRequestMarkdown.tsx`'s `remarkGitLabUploads` applies the context's `repositoryUrl`; video
  uploads play inline.
- `lib/openPullRequestLink.ts` always offers the "Open link" toast for a commit outside the
  thread's workspace; `changeRequestLinks.ts`'s `isGitLabProject` (also used by
  `findProjectOnChangeRequestHost`) skips checkouts whose provider is neither GitLab nor unknown;
  `gitLabMergeRequestBrowserUrl` replaces the GitHub fallback URL and the definition URL in
  `LinkPullRequestDialog`'s `resolveLinkPullRequestProject`, keeping a self-hosted origin and path
  prefix (nothing sets `RepositoryIdentity.webUrl`). The link dialog accepts `!123`
  (`pullRequestLinkInput.ts`); a plain click opens the panel or page, a modifier click or an
  unreadable MR the system browser.
- `SettingsPanels.tsx`'s Diffs page defines the "Open merge requests in T3 Coder" row, because
  upstream's Integrations page is not carried.
- `pullRequestList.logic.ts`'s filter haystack also matches `!123`.
- `pullRequestEditing.ts` has no `canEditPullRequestMaintainerEdits`; GitHub maintainer edits
  (#25588) have no web control.
- `GitManager.ts`: merge request wording in its ref fetch and uncommitted-changes errors.

### Git layer

- `vcs/GitVcsDriverCore.ts` has no Git metrics or span events; adds `moveWorktree` (renames a
  thread's worktree folder with its branch, under the 5-minute worktree remove deadline) and
  `refStatusLocal` (never refreshes the real index); review file expansion allows up to
  `MAX_REVIEW_DIFF_FILE_BYTES` and fails with `ReviewDiffFileTooLargeError`, rejecting malformed
  UTF-8; a top-level review `sourceKind` returns only that source; worktree creation reads `t3.json`
  through the bounded `readProjectConfig`; checkpoint commits use the "T3 Coder" identity.
- `vcs/VcsProcess.ts` records no Git command metrics.
- `git/GitWorkflowService.ts` adds `moveWorktree` and `localRefStatus` pass-throughs.
- `vcs/VcsStatusBroadcaster.ts` adds `streamRefStatus` for `subscribeVcsRefStatus` and resolves
  auto-pull with `resolveProjectAutoPull` (`vcs/projectAutoPull.ts`, which honors legacy
  `project.autoPull` and holds upstream's `autoPullProjects` startup step); its `BackgroundPolicy`
  is a Coder stub that always allows work (`shouldRunOpportunisticWork` is always true), so
  `ThreadPullRequestService`'s sweep runs while the gateway holds the helper.
- `review/ReviewService.ts` replaces `getDiffFileContents` with chunked file snapshots
  (`openDiffFileContents`, `readDiffFileChunk`) held in bounded helper memory.

### Web shell and connections

- `state/primaryEnvironment.ts` makes `primaryEnvironmentIdAtom` the active workspace (the first to
  send its welcome); `__root.tsx`'s `EventRouter` reads welcome events per workspace,
  `state/entities.ts` keeps only `initializeActiveEnvironmentId`, there is no available-editors
  atom, and `usePrimarySettingsAvailable` has no hosted-app case.
- Always-grant scopes (Coder owns authentication): `useEnvironmentScope`, `readEnvironmentScope`,
  and `useFilesystemReadAccess` grant for a known workspace; client-runtime `commandPermissions`
  authorizes every command and installs the `RpcPermissionGuard`; settings sync writes without grant
  checks and worktree removal is always offered; `state/terminalSessions.ts` reads terminal scopes
  through `readEnvironmentScope`, and `files/fileSaveSessions.ts` subscribes to no write-scope
  changes.
- `connection/platform.ts` registers only the configured Coder workspaces through the gateway.
  client-runtime's `connection/driver.ts`, `connection/index.ts`, `connection/wakeups.ts`, and
  `platform/persistence.ts` drop multi-route checks, credential and profile stores, saved targets,
  onboarding, GitHub routing, host updates, and the mobile `network-changed` wakeup.
  `connection/supervisor.ts` gives the route no kind, so probe timeouts treat it as remote (#25824);
  `checkHost` never answers (the gateway answers either way); `connectedLeaseEnd` ends a lease only
  on a disconnect. `connection/registry.ts` starts every registered supervisor desired, applies
  every reconcile (no #26511 skip), carries no cached unsupported-host rejection, and has no
  `assertKnownAddress` or `knownAddressOnly`; `connection/resolver.ts` has no remote HTTP prepare
  path. `state/shell.ts` treats every workspace as remote.
- client-runtime's `threadSnapshotHttp.ts`, `shellSnapshotHttp.ts`, and `threadHistoryHttp.ts` keep
  upstream's paths but load over helper stdio; shell snapshots use upstream's socket fallback.
- client-runtime's `rpc/protocol.ts` builds its client from `CoderWsRpcGroup`, and `rpc/index.ts`
  exports it without the HTTP client; `client-runtime/environment/index.ts` and
  `client-runtime/platform/index.ts` export no endpoint, descriptor, capability, or storage document
  modules.
- `lib/runtime.ts` has no primary-environment HTTP client, relay, DPoP, or tracer; `branding.ts`
  fixes the "T3 Coder" name.
- `localApiTypes.ts` keeps the context-menu and confirm-dialog types upstream takes from
  `contracts/ipc.ts`, so `confirmDialog.ts`, `externalLinkContextMenu.ts`, and
  `pullRequestLinkContextMenu.ts` import them from there; `localApi.ts` opens only HTTP(S) links.
  `ChatHeader.tsx`'s merge request button tests `"desktopBridge" in window`;
  `threadNotifications.ts` always badges the favicon; `ThreadNotificationCoordinator.tsx` focuses
  the tab without the desktop reveal; `vite-env.d.ts` declares no desktop bridge or hosted, relay,
  or desktop env vars.
- client-runtime `errors/diagnostics.ts` is the `[t3-error]` DevTools reporting (see
  [Authentication](#authentication)); `state/runtime.ts` exports `executeAtomCommand` for its test
  and calls `onAnswer` on the non-persisted query path; `errors/network.ts` keeps only
  `UNRESPONSIVE_HOST_HINT`.
- `state/environments.ts` has no relay discovery, `relayManaged`, or `useEnvironmentHttpBaseUrl`.
- A thread whose workspace is not connected shows `WorkspaceConnectionStatus`, as does
  `_chat.index.tsx` after the draft branch (#20183) while workspaces are pending; the
  `/projects/$projectKey` redirect has no auth gate.
- App entry: `main.tsx` renders inside `CoderBootstrap` and installs `consoleDiagnostics`;
  `appInit.tsx` starts no provider auth delivery, Electron service, default-theme adoption,
  agent-opened previews, SSH prompt, host-freeze toast, `PermissionUpdateNotice`, desktop update
  notice, browser host, preview title recording, browser profile reporting, favorite-editor command,
  or desktop paste-as-text; `AppRoot.tsx` mounts no `ElectronBrowserHost` or `QuitHoldOverlay`;
  `__root.tsx` keeps the fork's minimal shell; `_chat.tsx`'s `beforeLoad` has no auth gate or
  prompt-link card; `shortcuts/dispatcher.ts` registers no desktop menu actions or preview focus;
  `shortcuts/chatRouteCommands.ts` has no preview commands; `KeybindingsUpdateToast.tsx` shows no
  config-warning actions; client-runtime `state/presentation.ts` shows an available placeholder as
  connecting (no `entry.enabled` or `unsupportedReason`); `lib/bootError.ts` keeps reload and error
  details only.
- `AppSidebarLayout.tsx`: `readUsagePageOpen` is always false and
  `registerNavigationHistoryCommands` stays unexported (upstream exports it for an uncarried test);
  no desktop menu-action forwarding, fullscreen insets, or preview keybinding context.
  `shortcuts/commandPaletteCommands.ts` reads `usagePageOpen` as false and has no usage or preview
  commands.
- `ProviderUpdatesAction.tsx`'s Update all has no `quiet` option or returned runs, and
  `ProviderUpdateRun` no environment id (no "Update everything"). `index.css` drops the `wco`
  variant, drag regions, and desktop resize inset; without `lib/windowControlsOverlay.ts`,
  `ui/tooltip.tsx` reads a zero titlebar height, `chat/ZoomableImage.tsx` sizes to the window, and
  the sidebar sheet gets no inset. `env.ts` reports `isElectron = false`.
- Branding: `ui/standalone-page.tsx`'s wordmark reads "T3 Coder", `SidebarChrome.tsx`'s logo link
  is "T3 Coder home", `QueuedRunsControl.tsx` says "Sent by T3 Coder", and `PullRequestsColumn.tsx`
  labels its F6 area "Merge requests".

### Web chat, composer, and files

- `ChatView.tsx`: no browser or device panels, mini-player, automatic machine placement,
  self-update or version-skew banners, usage-limit panel, feedback upload, `OpenInPicker`, or
  favicon store; the active workspace stands in for the primary environment and drafts read their
  route workspace's config. The modules upstream split from it carry the matching cuts:
  `RightPanelSurfaceContent` renders nothing for browser and device surfaces;
  `useRightPanelSurfaceClose` closes no preview sessions; `useSystemComposerBanners` shows only the
  offline or reconnecting banner, whose Reconnect only retries; `useDraftEnvironmentRouting` keeps
  only the manual machine switch; `useComposerSend` has no feedback upload, `/usage-limits`, load
  balancing, or preview-annotation send (`composerSend.logic.ts` has no load-balancing helpers);
  `useRightPanelActions` has no browser or device surfaces; `useChatTerminalActions` opens no script
  preview; `useProjectCloneBanner` shows no file-copy banner; `useComposerResume` and
  `useThreadLifecycle` call no `clearUsageLimitsFor`; `ThreadErrorBanner` and `ChatBannerLane` take
  no error code; `ChatOverlayHosts.tsx` has no device setup host.
- `useTimelineRewind` reads the message's images back through the helper instead of
  `chatViewSend.ts`'s `prepareRevertedMessageAttachments`.
- `chatCanvasLayout.ts` has no preview obstacles (it accepts `findBar` and ignores it).
- `RightPanelTabs.tsx` is upstream's strip and `PreviewPanelShell` without browser, device, and
  preview surfaces or per-tab memoization (#20853); never-opened preview surfaces get a plain title
  and icon. The branch toolbar's workspace options are never primary and use the server's machine
  kind, with no "Auto balance" or server-update control; the branch picker adds "Rename current
  branch…" (`vcs.renameThreadBranch`).
- Preview annotations, element captures, and SnapShot frames are absent from the composer and
  timeline: `useComposerContextImport.ts` skips their records, `ComposerAttachmentStrip.tsx` and
  `TimelineUserMessageRow.tsx` show no SnapShot frames, `composerCommandKey.ts`,
  `useComposerStash.ts`, `useQueuedRunEdit`, `ChatView.logic.ts`, and `chatViewSend.ts` carry no
  annotations, and `questionAttachments.ts` has no SnapShot draft tracker.
- `work-log/presentation.ts` formats token counts inline (`@t3tools/shared/usageFormat` belongs to
  the usage dashboard); native app icons fall back to the tool glyph; client-runtime's
  `state/attachments.ts` keeps `isAssetAttachmentNotFoundFailure` private.
- Markdown (`ChatMarkdown.tsx`, `chat/ChatMarkdownMedia.tsx`, `chat/MarkdownFileLink.tsx`):
  workspace media load from signed asset URLs and a missing file names the workspace and path;
  `MarkdownFileLink` never gets `onOpen`, `onOpenInBrowser`, or `onReveal`, and the link menu never
  offers the integrated browser; relative and non-web links render as inert text; GitLab references
  open directly (`confirmBeforeOpen` false, the candidate URL is the link itself).
- Files and search UI: previews load from signed asset URLs, and HTML files are detected locally
  (`isBrowserPreviewFile` lives with the in-app browser); `fileContextMenu.ts` keeps
  `resolveFileContextMenuAbsolutePath` but offers Open in Files and Copy path; the Git actions
  dialog opens changed files in the Files surface (`openFileSurfaceStable` through
  `ThreadDetailsPanel`'s `onOpenFile`), mapping repository-relative paths to the thread's folder,
  and closes, keeping its commit message; `projectFilesQueryState.ts` has no `isFile`.
- Diff panel (`DiffPanel.tsx`): expanded context loads through the chunked review RPCs
  (`createChunkedGitDiffFileContentsLoader`), a file over the limit is listed in
  `DiffFileExpansionErrorNotice`, branch previews ask for one top-level `sourceKind`, and a file
  title opens the Files surface with no local-editor fallback.
- `patches/@pierre%2Fdiffs@1.6.1.patch` adds a guard that ignores loaded contents unless the diff
  is still the partial diff that asked, and lets a contents loader return `null`
  (`FileDiffContentsLoader` and `LoadedPartialDiffContents` types), which 1.6.1 still lacks.
- Project actions: repository actions come from `projects.getConfig`, which drops `iconPath` and
  script preview fields; the editor has no preview URL; the thread details card has no Open in,
  servers, or usage items, so `threadDetailsUsageEnabled` is never read.
- The worktree setup card says "Use project checkout"; `ChatComposer.tsx`'s `addComposerFolders`
  always takes the remote-environment branch and its toast.
- Command palette (`CommandPalette.tsx` and its split modules): every workspace is remote; Add
  project always shows the workspace picker, which also lists unconnected workspaces and connects
  the chosen one, runs workspace discovery once, and opens connection settings with no Coder domain;
  there is no desktop or WSL folder picker, browser preview, usage page, or file manager action;
  review actions say merge request.

### Web state and persistence

- client-runtime's `state/runtime.ts` query atoms take no `persistence` option and
  `state/pullRequests.ts` passes none (upstream's offline query store is mobile-only); its query key
  normalizer and `pullRequest/filesViewedStore.ts`'s scope key drop `expectedAccountId`.
- `hooks/useSettings.ts` runs `startModelPreferencesMigration` with the legacy lists from the
  workspace's `providerPreferencesByEnvironment` entry, falling back to the global lists
  (`legacyModelPreferences`).
- `storage.ts` keeps the IndexedDB environment cache without the connection catalog, credentials,
  or GitHub routing permissions; `threadRetention.ts` caps idle thread snapshots by entries and
  size.
- Cached data and drafts are cleared only when a workspace leaves the Coder config (stopped and
  disconnected workspaces also leave the platform registrations); the mapping is memory-only.
- `state/server.ts` (client-runtime) and the web provider list stay limited to the helper's methods
  and the four drivers (`isCoderProviderDriver`); `providerClients.ts` registers only those, and the
  Add provider dialog shows all four with no "Show more" fold or ACP Registry search (#25753).
- `ProviderSettingsPanel`'s `ProviderInstanceRow` passes no ACP sign-in, managed Codex runtime, or
  provider setup section, and `RemoteSessionGatedProviderSettings` grants operate access without the
  remote-session check.

### Settings

- Upstream's layout, pages, navigation, and search with Coder's Connections, Providers, GitLab, and
  background-activity panels; no access, browser, devices, SnapShot, diagnostics, Integrations,
  secrets, pairing, or `keybindings.json` editor pages. `_chat.settings.connections.tsx` renders the
  Coder deployments, workspaces, port forwards, and workspace links; `settingsLayout.tsx`'s
  `SettingsSection` takes a `description` for them. `SettingsSidebarNav.tsx` and
  `useAvailableSettingsSearchItems.ts` take no settings scope search and have no T3 Connect sign-in,
  local backend, cloud, or WSL entries; `movedSettingsPath` never points at a cut page; Labs' Beta
  section has only the Linked environments switch (no guest links or Simlock row); About has no
  mobile app row, privacy link, or update track switch.
- Search carries `sourceControlHostSearchItems` but not `SOURCE_CONTROL_HOST_LABELS`; the MR link
  target row lives on Diffs with GitLab search terms.
- Appearance's **Add theme** is `ThemeImportDialog` without the remote catalog or desktop picker.
- Each workspace row carries `EnvironmentIconMenu`; the helper reports no `platform.machine`.
  `environmentTransportLabel` names every workspace "Coder workspace", so
  `useEnvironmentTransportLabel` ignores the prepared connection; older links naming one checkout
  resolve to its group.
- Providers lists only the four drivers, without sign-in, setup, managed install, per-instance
  environment variables, ACP registry, or usage-limit sources; Source Control appends GitLab
  workspace status; update checks and the health interval do not mention model catalog updates.
- `ProviderInstanceCard.tsx`, `ProviderSettingsPanel.tsx`, and `ProviderSettingsForm.tsx` keep the
  plain value and `SecretInput` for environment and secret fields (no secret sources).
- Background activity uses upstream's profiles without power-monitor intervals or lock pauses.
  `hooks/useEnvironmentDisconnectDelay.ts` keeps only `useEnvironmentStateHeldFor`.
- Scheduled tasks: no "On webhook" option, URL, token rotation, signature, filter, replay, or
  coalesce fields, Deliveries dialog, or "Listening" status (no inbound webhook route); webhook
  tasks created another way keep their schedule but never run or offer Run now.
- `useNewProject.ts` suggests no app access after publishing; `state/sourceControlActions.ts`
  neither.

### Migrations

- `persistence/Migrations.ts` is upstream's registry with the same IDs; the auth migrations (20–22,
  31, 32, 41) and 070–071 keep their IDs and create nothing. `CoderMigrationHistory.ts` finishes the
  fork's old renumbered registry (IDs 41–58 with the `CoderLegacy/` migrations 050 and 055) and
  rewrites the history to upstream's IDs before upstream's migrator runs, reconciling a V2 preview
  ledger first. `migrationEntries` stays exported for those tests; `Migrations.test.ts` omits
  #26288's file-name check. New migrations take upstream's next ID; never add a Coder-only ID.

### Wording

- User-facing text says "merge request", "MR", and `!123` wherever upstream says "pull request",
  "PR", or `#123`, and "T3 Coder" for "T3 Code": the web panels, composer, settings, toasts, and
  keybinding labels; the strings the web shows from client-runtime and shared; and the agent-facing
  server text (`pullRequestWatch.ts`, `PullRequestWatchReactor.ts`,
  `mcp/toolkits/pullRequests/tools.ts`, the orchestrator's unconfirmed-answer error, `GitManager`
  errors). Identifiers, wire names, and search haystacks keep upstream's spelling; the composer
  trigger stays `#`; `runtimeInstructions.ts` stays upstream's. GitLab's definition supplies "MR"
  wherever upstream reads a host's terminology, and `!123` is applied by hand. Text for paths GitLab
  never reaches (native stacks, `PullRequestsUnavailableState`'s GitHub link, GitHub-only rows)
  stays upstream's. These pure substitutions are not marked line by line; the seams check recognizes
  them.

### Build tooling and tests

- `apps/web/vite.config.ts` carries upstream's office/pdf asset handling and route splitting but
  not the render scenarios project, `VITE_RELEASE_CHANNEL`, source maps, or the build manifest.
- Root `vite.config.ts` is upstream's without the remote task cache and cached test tasks (`infra/`
  is cut), the per-package test projects (`vite.coder.config.ts` replaces upstream's
  `apps/server/vite.config.ts` and extends this file, which therefore loads `gitConfig.setup.ts`),
  and the `oxlint-plugin-t3code` and `@shadcn/lint` rules.
- `pnpm-workspace.yaml` sets `supportedArchitectures` (Linux x64 glibc) on every host, because the
  helper bundle ships those native modules (upstream sets it in the uncarried `.pnpmfile.cjs`);
  `overrides` pin only the patched packages the fork carries plus Tailwind and lightningcss;
  `@effect/platform-node>undici` is removed; the gateway pins its own `ws`/`@types/ws`;
  `ignoredOptionalDependencies` keeps the Agent SDK's Claude binaries and `@napi-rs/canvas` off the
  laptop.
- TypeScript is Microsoft's TypeScript 7 (`typescript: 7.0.2`), not the `@tsc-rs/typescript`
  drop-in whose unsigned Windows `tsc.exe` endpoint security may block; the fork omits its build
  approval, peer rule, and `.pnpmfile.cjs` hook, and never ran `@effect/tsgo`. Root `engines.node`
  stays `^24.13.1`.
- Package manifests (`package.json`) and `tsconfig.json` files drop dependencies, scripts, exports,
  and includes for cut surfaces and uncarried tooling; `routeTree.gen.ts` is regenerated without cut
  routes; `third-party-licenses.config.json` lists no desktop bundle or desktop-only assets;
  `scripts/lib/third-party-licenses.ts` reads no device tool version pins.
- `patches/@ff-labs__fff-node@0.11.0.patch` adds the native grep struct's `fuzzy_score` read at its
  real u16 width; `patches/@legendapp__list@3.3.5.patch` keeps only the `react.js` and `react.mjs`
  sections.
- `knip.jsonc` lists upstream files whose exports only cut surfaces use.
- `packages/effect-codex-app-server`: a spawned Codex child may print a bounded non-JSON preamble
  (`CHILD_PROCESS_STARTUP_PREAMBLE_MAX_BYTES`) before its first message; the `probe` script is not
  carried.
- No tracked shell scripts (a corporate download scanner rejects archives with one):
  `ProviderInstanceRegistry.test.ts` and `GitVcsDriverCore.test.ts` write upstream's
  `codexCollabMockPeer.sh` and `GitVcsDriverCore.fixture.sh` into their temp directories.
- The real-Coder live harness (`scripts/coder-live-test.mjs`, `scripts/coder-live-template/`) is
  local only and listed in `.gitignore`; `scripts/coder-live-images.mjs` and
  `scripts/coder-live-provider-images.mjs` (`pnpm coder:live:providers`) are tracked;
  `pnpm coder:live:*` and `pnpm test:coder:live` fail in a fresh clone.
- Test adaptations, each marked: upstream's GitHub and Azure DevOps fixtures in the GitManager,
  review-guide, guide-tool, T3 tool bridge, sync-key, and linked-thread tests use GitLab projects
  and `refs/merge-requests/<n>/head`; tests of uncarried hosts' behaviour are cut;
  `GitManager.test.ts` is upstream's fake-provider harness with a GitLab default kind;
  `PullRequestSyncReactor.test.ts` closes with `glab mr merge`/`glab mr close`;
  `ClaudeAdapterV2.test.ts` drives the MCP control-channel tests through a fake `claude`;
  `ClaudeAgentSdkQueryRunner.test.ts` stubs the CLI transport's `query`;
  `ProviderSessionManager.test.ts`'s parallel shutdown test waits in real time;
  `storageCleanup.test.ts` uses real temp paths; `serverSettings.test.ts`,
  `DatabaseStorage.test.ts`, `PullRequestService.test.ts`, `SourceControlRepositoryService.test.ts`,
  `presentation.test.ts`, `pullRequests.test.ts`, `threadShell.test.ts`, and `ws.test.ts` omit cases
  for cut surfaces; `threads-sync.test.ts` and `threads-atoms.test.ts` fake history pages over the
  helper RPC; `pullRequestsRouteSearch.test.ts` runs under happy-dom;
  `linkCreatedPullRequest.test.ts` and `openPullRequestLink`'s browser test use GitLab URLs (no
  merge request commit-URL case); `GitVcsDriverCore.test.ts` expects `ReviewDiffFileTooLargeError`
  with a branded exit code; `ProviderInstanceRegistry.test.ts` runs the Claude one-probe fallback
  against the CLI `query`; `ProviderRegistry.test.ts` runs without the Antigravity and OpenCode
  layers; `SourceControlProviderRegistry.test.ts`, `SourceControlRepositoryService.test.ts`, and
  `RepositoryIdentityResolver.test.ts` run upstream's cases on GitLab remotes with the fork's mocks;
  `PullRequestService.test.ts` passes branded GitLab kinds; `chatCanvasLayout.test.ts` and
  `canvasStore.test.ts` carry no preview cases; the ACP Registry replay harness
  (`AcpRegistryAdapterV2.testkit.ts`, `AcpAdapterV2.testkit.ts`) runs without registry, Devin, and
  session-management cases, plus a Coder test that the bridge command reaches the prompt;
  `AgentScope.test.ts` drops the launcher check (`agentScopeLauncherScript` is cut);
  `GitLabPullRequestCli.legacy.test.ts` expects `DIFF_MAX_OUTPUT_BYTES`; `ProviderReplayFixtures.ts`
  lists only the carried drivers.
- Upstream's `*.browser.test.*` files run in headless Chromium as the `browser` Vitest project;
  `reactCompilerCoverage.test.ts` skips `CODER_UNCOMPILED_FILES`. The fork keeps `jsdom` and
  `react-test-renderer` for its unit tests and for `ChatMarkdown.test.tsx`,
  `ProjectSettingsPanel.test.tsx`, and `RightPanelTabs.test.tsx`, which stand in for uncarried
  browser tests (`ChatMarkdown.browser`, `ChatMarkdown.permissions.browser`).
  `CommandPalette.browser.test.tsx` mocks `useCoder`; upstream's `composerContextUndo.test.ts`
  (preview annotations only) is not carried. Carried browser tests drop cut-surface cases:
  `CommandPalette.composition` mocks `useCoder` and picks the workspace first, `StorageSettings`
  keys on the saved-image-artifacts title, `useComposerContextImport` drops linked environments,
  images, and annotations, `FilePreviewPanel` has no remote-open mock, `PullRequestMarkdown` runs on
  the GitLab-only registry, `ProjectSettingsPanel` keeps `projects.getConfig` pending, and
  `ProviderSettingsForm`, `ProviderModelPicker.composition`, and `ReopenClosedViewShortcut` drop
  secret-source, provider, and preview cases. The fork-only `hooks/useThreadActionMenu.test.tsx`
  keeps upstream's deleted hook test.

## Cut surfaces

Files the fork deletes are listed, with a reason per category, in `DELETED_PATHS` in
`scripts/sync-resolve-deleted.mjs`; that list is the source of truth for whole deleted files and
directories. The surfaces below are cut; where a carried upstream file only loses code for one of
them, the file is named here.

- **Desktop, mobile, hosted web, and T3 Connect.** No Electron shell, desktop IPC
  (`contracts/ipc.ts`, `resolveDesktopTheme`), desktop update notices or pills, window controls,
  `DesktopWebLinkCoordinator`, desktop folder path lookup (`folderDrop.ts`), back/forward swipe
  navigation (`HistorySwipeNavigation.tsx`, `navigationHistory.ts`), mobile app links
  (`MobileAppSettingsRow`), hosted app, or prompt links (`components/promptLinks/`, the "Copy prompt
  link" actions, the automation row's link). `Icons.tsx` drops `OnePasswordIcon`.
- **Auth, pairing, and relay.** No HTTP/WebSocket listener, session scopes, pairing, DPoP, relay,
  or connection catalog; `settings/AddEnvironmentDialog.tsx` is cut. With no session scopes,
  scheduled task lists show every webhook URL.
- **Browser preview and devices.** No in-app browser, preview panel, mini-player, preview MCP
  toolkits, device hosts, or agent device shim; provider-core's device instructions never reach an
  agent. Without browser preview, `composerDraftStore.ts` keeps no empty draft alive for an open
  page, and `mergeDirectPreviewAnnotation` is not carried.
- **Telemetry, usage, and diagnostics.** No T3 telemetry, analytics, client-origin attribution,
  metrics, OTLP or trace export (upstream's OTLP `config.test.ts`), diagnostics page, NDJSON event
  logs, resource telemetry, `observability/EventLoopMonitor.ts` (no host-freeze toast or
  `lastEventLoopStall`), usage page or dashboard (`shared/usageLimits.ts`, provider-core and
  provider-pi `usage.ts`; `ProviderDriver.usage` is `never`), Labs' usage view
  (`ThreadDetailsUsage`), `useUsageLimitsPanel`, or upstream's out-of-usage fallback (#26164;
  `fallbackModelSelection` stays in the schema only). Without the usage page, `timestampFormat.ts`
  has no `resolveHour12`.
- **Server self-update and CLI.** No npm release check (`cloud/npmRelease.ts`), "Update
  everything", update tracks, `t3 doctor` storage status (`DatabaseStorageNotice`, client-runtime's
  `databaseStorage` atom), `persistence/DatabaseMaintenance.ts` (so `rebuildMessageSearch` has no
  caller), `t3 triage`, or desktop update button in `lib/bootError.ts`.
- **Local editors and open targets.** No `OpenInPicker`, open-in-editor, reveal, file manager, or
  remote open mode (`MarkdownFileLink.logic.ts` has no `canUseMarkdownFileShellActions`).
- **Other providers and provider setup.** Cursor, OpenCode, Muse, Grok, Antigravity, fx, the
  dev-only replay provider (#26207: `DevReplayHost.tsx`, `apps/server/scripts/dev-replay*`,
  `window.t3dev`), their replay fixtures (`testkit/fixtures/index.ts` and `shared.ts` drop their
  entries), managed Codex (`CodexManagedTokenBroker`, `__managed-chatgpt-token`, ChatGPT Business
  admin requests #23361), provider sign-in, and Kilo Code's registry index, installs, auth
  controller, and session management (`acpSessionManagement`, `copilotAcp.ts`, `devinAcp.ts`,
  `nativeLogging.ts`, `@noble/hashes`), and the Antigravity send block. Codex feedback upload
  (client-runtime `threadCommands.ts` has no `uploadFeedback`) and SnapShot sources are cut.
- **Hosted source control other than GitLab.** GitHub, Azure DevOps, Bitbucket, Forgejo, and
  GitCafe packages, host settings, tokens, accounts, routing, forge app sign-in (#26245,
  `SourceControlSignIn`), app-access notices (`sourceControlAppAccessToast.ts`), and the GitHub star
  prompt (#27832, `GitHubStarPrompt`, `checkStarred`, `useComposerSend`'s `recordPromptSent`). Web
  `SourceControlAppAccessNotice.tsx`, `T3AppIcon.tsx`, and
  `settings/SourceControlAppSignInSettings.tsx` are cut, and client-runtime `state/sourceControl.ts`
  and `sourceControlClients.ts` have no app-access or sign-in atoms or `appSignInTargetForRemote`.
- **Linked-environment client pieces.** The hub replaces pairing, so web
  `EnvironmentContextChip.tsx`, `chat/LinkRequestCard.tsx`, `settings/LinkAccessPicker.tsx`,
  `LinkMachineSelect.tsx`, `LinkedEnvironmentsSettings.tsx`, `state/peerLinks.ts`,
  `state/peerPairingCode.ts`, client-runtime `linkRequest.ts`, `PeerLinkRequests`, the `@` machine
  menu items and machine chips (`useComposerMenuItems.ts`, `ComposerCommandMenu.tsx`,
  `composerDraftStore.ts`, `composerContextRecords.ts`, `composerContextPresentation.tsx`,
  `composerContextUndo.ts`, `contextChipAccents.ts`, `ContextChip.tsx`, `useComposerSend.ts`,
  `useQueuedRunEdit.ts`), the link-request timeline card (`TimelineV2EventRow.tsx`,
  `session-logic.ts`), and the `t3_environment_link`/`unlink` tool presentations
  (`t3McpToolPresentation.ts`, `t3ToolSummary.ts`) are cut. The contract's `environment` record kind
  keeps a definition in `contextPresentationRegistry.ts` and an unavailable chip in
  `UserMessageContextChips.tsx`. The peer tests that pair two HTTP servers
  (`PeerForwarding.test.ts`, `RemoteDelegation.test.ts`, `linkOrigin.test.ts`,
  `PeerLinks.testkit.ts`, `PeerMcpClient.test.ts`) are not carried; `coderHub.test.ts` and the
  gateway's `hub.test.ts` test the transport.
- **Guest sharing** (#24104). Guest routes, pages, share controls, the "share-guest" thread action
  (`threadActionMenu.logic.ts`, `useThreadActionMenu.ts`, `Sidebar.tsx`, `contextMenuFallback.ts`),
  guest footers and bubbles (`ChatView.tsx`, `TimelineUserMessageRow.tsx`, `QueuedRunsControl.tsx`,
  which has no guest names or per-item `editable` flag), the guest-request pill (`Sidebar.logic.ts`,
  `SidebarThreadRow.tsx`), Labs' guest-links row (`LabsSettingsPanel.tsx`), `mainAppLocation.ts`'s
  guest page, the `--guest*` CSS tokens, and guest screenshots (#26323: `HostImageUrlContext`,
  `hostImageUrl.ts`, `TOP_STATUS_ICONS`' guest entry). `runtimeLayer.ts` provides no
  `GuestShareService`; the contracts, decider, commands, and projection columns stay for the unions.
- **Triage** (#22753). `apps/server/src/triage/**`, `server.prepareTriage`, the palette entry
  (`CommandPalette.tsx`), the draft hero (`DraftHeroHeadline.tsx`), `useHandleNewThread`'s `prompt`
  option, client-runtime's `prepareTriage`, and `docs/user/triage.md`.
- **Secret providers** (#25709, #27044, #27115, #27746). The secrets settings, 1Password, the
  `T3CODE_FEATURE_SECRETS` flag, the `/settings/secrets` route, `@t3tools/secret-provider-core`, and
  the server's `secrets/SecretResolver.ts`, `secretProviderDefinitions.ts`, and
  `secrets/settingsSecretValue.ts`. `secrets/coderSecretResolver.ts` stands in for the resolver in
  `ProviderInstanceRegistry.ts`, `ProviderInstanceRegistryHydration.ts`, and `serverSettings.ts`: it
  reads no reference (an instance whose variable points at one is unavailable with upstream's "Could
  not read …" reason) and lists no kind (`secretProviders` writes are rejected); `ws.ts` does not
  advertise `secretReferences`.
- **Dev servers** (#22542). `chat/ThreadServersPanel.tsx`, its `ThreadDetailsPanel.tsx` section and
  `thread-sidebar.md` paragraph, and `preview.stopLocalServer`; `localServerStop` is omitted.
- **Add to another machine** (#22180, #22254). It copies ignored files such as `.env` between
  workspaces through the browser: no `listIgnoredFiles`, `projects.listIgnoredFiles`
  (`ignoredFileListing` omitted), client-runtime `projectCommands.ts` command, `BranchToolbar.tsx`
  menu entry (`BranchToolbar.logic.ts`'s `ADD_TO_MACHINE_LABEL_CLASS`), or `ChatView.tsx` file-copy
  banner.
- **Offline query persistence and upstream's mobile-only helpers.** See [Web state and
  persistence](#web-state-and-persistence).
- **Upstream repository tooling and CI-only checks.** `apps/web/scripts/verify-built-boot.ts`,
  `AgentContextBudget.test.ts` and `agentContextBudget.json`, `.pnpmfile.cjs`, and upstream's
  14k-line `AcpAdapterV2.test.ts`. The v1 importer carries only messages, so pre-v2 screenshot
  `artifacts` are not shown, as on upstream.
- Shared helpers only cut surfaces used: `shared/projectFavicon.ts` keeps
  `PROJECT_FAVICON_EXTENSIONS` private, `shared/t3ProjectFile.ts` drops
  `buildT3ProjectFileJsonSchema`, shared `AgentScope.ts` drops `agentScopeLauncherScript`, and
  `PullRequestsPage.tsx` drops its preview-session placeholders.

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
