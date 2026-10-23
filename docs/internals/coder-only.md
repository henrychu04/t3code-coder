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
written to local disk. Browser UI preferences
such as theme and panel size may use browser storage; as on main, `uiStateStore` keeps sidebar
project expansion, order, and scope, thread visit times, changed-file folder expansion, and the
last merge method there, and session storage holds main's one-reload guard for stale split chunks
(`lib/chunkReloadGuard.ts`). Composer drafts and prompt stashes retain
text in browser storage, but never image bytes or upload IDs. As on main, IndexedDB caches each
environment's shell, settled thread snapshots, server config, and full branch lists so a reload
renders before the workspace answers; the workspace remains the source of truth. Open Files tabs and
editor state, provider sessions, and screenshot artifact object URLs are memory-only.
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
same checkout; helper protocol version 2 remains the transport compatibility fence.

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
that arrive together share one aliased `glab api graphql` request per checkout and fall back to
individual REST reads. Settled-thread
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
binaries from ever installing. T3 does not inject its removed
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

Both laptop-to-workspace transfers, the helper bundle install and composer attachments, stream over
the stdin of one foreground `coder ssh <workspace> -- sh -l -c '<command>'` process
(`packages/coder-cli/src/transfer.ts`); no OpenSSH client is involved. Coder 2.25 always allocates
a remote PTY, so the remote command first runs `stty raw -echo` and prints
`T3_CODER_TRANSFER_READY`; only then does the gateway write, and `head -c <size>` reads exactly the
expected byte count because a PTY never delivers end-of-file. Each transfer writes a generated
temporary name under `$HOME/.t3-coder/bin` or `$HOME/.t3-coder/attachments`, checks the received
size, and renames atomically into place. The helper bundle travels as a ustar archive built in
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
is on by default; disabling **Settings → General → Provider update checks** opts that workspace
out. Explicit provider updates run the installation's identified installer inside the workspace.
Versions marked broken or unsupported by the bundled compatibility policy are not offered. The
model manifest and compatibility policy remain bundled-only and are never refreshed over HTTP.

### Composer attachments

Composer attachments are the only laptop-to-workspace upload: an image or file pasted, picked, or
dropped into the message composer or a question answer. The browser posts it only to the loopback
gateway: `clipboard-image` accepts signature-validated PNG, JPEG, or WebP within
`PROVIDER_SEND_TURN_MAX_IMAGE_BYTES`, and `attachment-file` accepts any non-empty file within
`PROVIDER_SEND_TURN_MAX_FILE_BYTES`, using the name only for the stored extension
(`@t3tools/shared/attachmentFileExtension`). HEIC and HEIF photos are decoded to JPEG in the
browser before that upload, as upstream does (`heic-to`'s bundled WASM decoder, which the
gateway's `wasm-unsafe-eval` script policy allows); no image leaves the laptop undecoded. The gateway streams the bytes from memory to
upstream's pending-upload name, `pending-<uuid>-<ext>.<ext>`, and returns the workspace path, id,
size, and (for images) media type. The helper advertises upstream's `attachmentUploads`,
`questionAttachments`, and `fileAttachments` capabilities. The browser uses upstream's upload queue,
progress steps, and compression with the gateway as transport; percentage progress covers only the
loopback upload. Closing the HTTP response interrupts the transfer's Effect scope, which stops its
exact child process and removes the partial remote copy. Drafts and stashed prompts never store
image bytes or upload ids.

As upstream does, the helper claims each pending upload into a thread-scoped copy when it accepts
the message; `AttachmentClaims.ts` reads the staged file once through a no-follow handle at its
exact declared size (and, for images, a matching signature) and writes it exclusively. Files reach
the provider as workspace paths; images are validated again before Codex and Claude read them.
Images Coder stored before upstream's attachment ids (`<uuid>.<ext>`) decode as
`legacy-<uuid>-<ext>` attachments that are never claimable. Sent images and files are read back by
id through bounded helper chunks for previews, Save, and rewind.

The composer uses upstream's structured context records (`t3-context://v1/<kind>/<id>` links plus
`message.context`) without preview annotations, element captures, or SnapShot frames.
`ComposerAttachmentStrip.tsx`'s media row shows image tiles only; videos list with the other
files (`composerOtherFilesForPresentation` keeps them, so a video attached to a question answer
stays visible and removable), and a draft file previews only while its bytes are still in memory.
In sent messages, `TimelineUserMessageRow.tsx` lists videos with the other files and opens them
like files, because a submitted attachment is a workspace path the browser cannot read. The work log
uses upstream's client-runtime presentation without provider tool sources, favicons, logos, or
native app icons. File chip icons and size tooltips use upstream's `filesystem.getMetadata`, which
stats absolute workspace paths and reads at most 512 header bytes of an extensionless file to name
its type; it returns no contents.

### Files and search

The Files surface is a contained text-editing capability. The browser supplies the active project
root plus a project-relative path; the helper verifies that the root is the requesting thread's
checkout or managed worktree (a draft names its project, whose checkout or a worktree one of its
threads owns qualifies). Reads are bounded by `PROJECT_FILE_MAX_BYTES`; binary files are rejected,
larger text files are truncated and read-only, and lexical traversal and symlinks resolving outside
the project are rejected. Writes apply only to an existing, non-truncated text file, use the read's
revision to reject stale edits, and replace the file atomically. `projects.createFile`, used by the
proposed plan's Save to workspace, creates only a new file inside the verified root. Open files and
editor state stay in browser memory.

`filesystem.getMetadata`, which file chips use for their icons and size tooltips, is served as
upstream has it: it takes absolute workspace paths (or `~/` paths) with no thread or project-root
check, reads only `stat` plus a header sniff of at most 512 bytes for a file without an extension,
and never returns file contents. Like `filesystem.browse`, it is not subject to the Files
surface's project containment.

Filename and path search use a lightweight path-only FFF index. Project-content search uses a
separate, on-demand, content-enabled `@ff-labs/fff-node` index whose `basePath` is the verified real
project root, never a filesystem root or home directory, with a hard time budget, per-file and
per-request match caps, cursor pagination, and an idle TTL (the `PROJECT_CONTENT_SEARCH_*` and
`PROJECT_SEARCH_INDEX_IDLE_TTL` constants). FFF output is untrusted: the helper rejects absolute,
traversing, NUL-containing, malformed, and escaping paths and binary matches, returns only
project-relative paths, bounded line snippets, and match ranges, and keeps query text, contents,
and absolute paths out of errors and logs. Cancellation and timeouts yield so search cannot
monopolize the stdio connection.

### Media and document previews

Media previews follow main's on-demand file flow. The helper verifies the thread's root, resolves
relative paths from it, and also accepts exact absolute image paths elsewhere on the workspace
machine. It checks the opened file's identity, rejects non-files, validates each signature against
its extension (main's image, video, and audio formats), and keeps a file revision constant across
chunks. Images are bounded by `MAX_SCREENSHOT_ARTIFACT_BYTES`, video and audio by
`MAX_PROJECT_MEDIA_BYTES`, and each stdio chunk by `MAX_SCREENSHOT_ARTIFACT_CHUNK_BYTES`. No
artifact copies, capture budgets, or quotas exist, and saved v1 screenshot artifacts are no longer
shown (see the v1 import note below).

The browser keeps main's thumbnails, gallery, and `MediaActions` menu (copy path or URL, Save, Copy
image). Workspace media has no signed URL, so the browser reads it whole into a memory-only blob
(`imageResources.ts` bounds concurrent reads and bytes), and byte actions use that blob or the web
URL. Inline videos show a play card and read only when pressed. External web images and videos load
from their host as on main; the gateway CSP allows `https:`/`http:` and `blob:` in `img-src`,
`media-src`, and `connect-src`, keeps `script-src` to the app, and allows `frame-src 'self' blob:`.

In Files, PDF and HTML files preview as on main, project files only, within `MAX_PROJECT_PDF_BYTES`
(`%PDF-` signature) and `MAX_PROJECT_HTML_BYTES` (no NUL bytes). A PDF renders from a memory-only
blob in the browser's built-in viewer; an HTML page is written into the gateway's document shell
`/html-document-frame.html`, whose CSP sandbox is upstream's file frame (`allow-scripts allow-forms
allow-popups allow-downloads`, never `allow-same-origin`). Its relative assets do not load, because
there is no asset server.

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
  and config events per workspace. There is no available-editors atom, and the hosted-app case
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
    is in `CODER_OMITTED_CAPABILITIES`, and Settings → Storage has no database notice
    (upstream's `DatabaseStorageNotice` and client-runtime's `databaseStorage` atom are not
    carried). Upstream's `persistence/DatabaseMaintenance.ts`, which only `t3 doctor` uses, is
    not carried either.
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
  - Files listings, reads, writes, file creation, content search, and media reads verify the requesting thread's
    project root; Files listings, reads, writes, and media reads from a draft verify its named
    project's root or a worktree one of that project's threads owns (`draftProjectId`). `workspace/WorkspaceFileSystem.ts`, `WorkspaceEntries.ts`, and
    `WorkspaceSearchIndex.ts` implement the Files surface and file-search boundaries above in place
    of upstream's absolute-path and `~/` host reads (#20950), create-anywhere writes, and
    `searchContents`. A read with upstream's `allowMissing` (#19949, the optional `t3.json`)
    applies to project-relative paths and returns `exists: false` for an absent file.
    A folder listing stops at `MAX_PROJECT_DIRECTORY_ENTRIES` children and labels ignored ones
    with a single `git check-ignore` call, so upstream's wide-folder shortcut (asking whether the
    folder itself is ignored, #20062) has nothing to save and is not carried.
    `projects.createFile` serves upstream's proposed-plan "Save to workspace": it creates a new
    text file inside the verified root and never replaces an existing path, where upstream's
    `writeFile` overwrites. Both write paths keep upstream's write-target hardening: the cwd must
    be a `KnownWorkspaces` folder, the root resolves after `path.resolve`, and a target in a git
    folder (`.git`, a bare repository, a linked worktree's git folder, as named or resolved) is
    refused, with new files checked before any folder is made. `ProjectImages.ts` and `ScreenshotArtifacts.ts` are Coder-only. Path-only FFF errors and stale-write errors retain the fork's bounded-service
    error mapping. `coderWs.ts` wraps `ws.ts`'s upstream Files list, read, and write handlers in
    the root verification, so those handlers stay upstream's code.
  - Upstream's "Add to another machine" (#22180, #22254) is not carried, because it copies a
    project's ignored files, such as `.env`, from one workspace to another through the laptop
    browser. `WorkspaceEntries` has no `listIgnoredFiles`, `ws.ts` serves no
    `projects.listIgnoredFiles` (`ignoredFileListing` is in `CODER_OMITTED_CAPABILITIES`),
    client-runtime's `projectCommands.ts` has no matching command, `BranchToolbar.tsx` has no
    menu entry, and `ChatView.tsx` shows no file-copy banner or send block.
  - Coder-only methods live in `coderWs.ts` (`CODER_WS_METHODS`): local ref status, managed
    branch/worktree rename with `moveWorktree`, chunked review files,
    bounded text/content/media, sent-file (`workspace.readAttachmentFile`), and legacy-artifact
    reads, new-file creation (`projects.createFile`), fixed project-config reads, workspace
    directory listing, merge-request diffs, and upstream's HTTP bounded thread snapshot,
    history page, and thread transcript over stdio. The method set stays `CoderWsRpcGroup`;
    unsupported upstream methods stay omitted.
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
    - `toolkits/environment/` reads the `CoderEnvironment` descriptor in place of upstream's
      `ServerEnvironment`.
    - provider-core's `server/t3ToolBridgeInstructions.ts` reuses upstream's orchestration
      sections without their MCP and ACP transport paragraphs or the `html_preview` step; its
      test fails if upstream rewords them.
    - `CodexAdapterV2.ts` configures no `mcp_servers`, attaches T3 context only when the bridge
      exists, and never advertises preview or device tools; `CodexDeveloperInstructions.ts` and
      `ClaudeAdapterV2.ts` describe the bridge command (`t3ToolBridgeInstructions.ts`) in
      place of upstream's MCP orchestration text. Codex takes it as `t3ToolBridgeSections`, one
      additional-context entry per section like upstream's, so each stays under Codex's
      `CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES`. Claude pre-approves the command as a Bash
      prefix, limited to read-only tools in a read-only sandbox, as upstream pre-approves its MCP
      tools. provider-core's `runtimeInstructions.ts` keeps upstream's `link_pull_request` block,
      worded for T3 tools.
    - Preview, device, and attachment-upload toolkits are not carried.
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
    (Cursor, OpenCode, Muse, Grok, Antigravity) are not carried. Their replay
    fixtures (`orchestration-v2/testkit/fixtures/{grok_*,muse_*,opencode*}`) and
    `testkit/DormantProviderCapabilities.ts` are kept on purpose: orchestrator tests replay them
    to exercise those capability combinations, and no driver for them is registered.
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
      registry index, search, and binary, npx, and uvx installs (and `@noble/hashes`) are not
      carried, and `acpRegistryManagedBinaryDirectories` is gone, so terminals add no managed
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
      and `devinAcp.ts` are not carried) and no native protocol logging.
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
    `ClaudeCli.ts` allows for stream-json.
  - Agent-session import follows upstream, scanning only the workspace's own Codex and Claude
    session stores through the helper. `coderServer.ts` provides the scanner beside the helper RPC
    layer, as upstream does beside its WebSocket layer. Upstream offers the import in its welcome
    wizard, which is not carried; `ImportAgentSessionsDialog.tsx` reuses that import step from
    **Settings → Providers → History** for the selected workspace.
  - `ProviderAuthService` reports every sign-in, logout, and credential-transfer operation
    unavailable; providers authenticate through the workspace's API configuration.
    `CodexManagedRuntime` keeps only upstream's resolution contract, so upstream's
    `CodexManagedTokenBroker` (which renews the managed runtime's ChatGPT sign-in token,
    #21786/#21787) and the `__managed-chatgpt-token` CLI entry are not carried. `CodexAdapterV2` does not
    rewrite failures through `CodexManagedErrors` (ChatGPT Business admin request, #23361), and
    the server's `threadErrorSummary` and client-runtime's `ThreadRuntimeSummary` carry no
    `lastErrorCode`; the contract field stays.
  - Provider drivers, snapshots, and the registry are upstream's. Coder deltas: `CodexDriver`
    offers no T3-managed Codex install (`setupMode: "managed"`), neither driver redeems
    rate-limit reset credits, and `ClaudeDriver` does not read the Claude organization id that
    keys upstream's usage accounts, so its one-probe capability fallback skips upstream's
    same-organization check (API-key logins have no organization either way). `ModelManifest.layerBundled` serves the bundled manifest without
    upstream's hourly fetch or disk cache. Both providers attach
    per-model `supportedRuntimeModes` from workspace policy: Claude's effective
    `disableAutoMode`/`disableBypassPermissionsMode` settings (read through `ClaudeCli`, failing
    closed; the same modes on every model, since the CLI itself drops a mode the model or policy
    forbids) and Codex's `configRequirements/read`, which runs in upstream's parallel probe step
    and attaches after its custom-model and service-tier step. At session start,
    `ClaudeAdapterV2.resolveBypassAvailability` reads the settings files (cached remote, user,
    project, local, and managed) where upstream calls the SDK's runtime `resolveSettings`
    (#21806); a mode any source disables is off, so `Drivers/ClaudeSkills.ts` keeps
    `skillOverrideSettingsPaths` exported for it. `resolveSubagentPromptCacheTtl` reads
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
    provider sign-in commands and credential-change guards, Codex feedback upload, SnapShot
    sources, data-URL uploads, preview-tool metadata, and the agent device shim.
- **Authorization scopes.** Coder owns authentication, so upstream's per-session scopes always
  grant: web `useEnvironmentScope`, `readEnvironmentScope`, and `useFilesystemReadAccess`
  return granted for a known workspace, and client-runtime `commandPermissions` authorizes every
  command and installs the `RpcPermissionGuard` that upstream's guarded RPCs require. Settings
  sync writes to every connected workspace without grant checks, and worktree removal is always
  offered.
- **Agent secret requests.** Upstream's `request_secret` tool, card, and one-use secret store,
  with the value sent only to the workspace store over `secrets.answerRequest`; it never enters
  browser storage, the transcript, projections, model context, or logs.
- **MCP Apps.** Upstream's inline app rows and sandboxed frame, with resource reads and tool calls
  over the helper's MCP Apps RPCs. The frame has no camera, microphone, geolocation, or clipboard
  permission. `ui/download-file` is upstream's: the user confirms, and the host page saves the
  embedded or linked bytes. Upstream frames the captured document through a signed asset URL. Here
  `workspace.readTurnItemAsset` reads it in bounded chunks, but only the document that the named
  stored tool item references, opened without following symlinks. The frame then loads the
  gateway's `/mcp-app-frame.html` shell, and the page posts the document to it. The shell checks
  that the message came from its parent and writes the document over itself.
  A blob, `srcdoc`, or `data:` frame would inherit the page's Content-Security-Policy and block the
  app's scripts. The shell's own policy is `sandbox allow-scripts allow-forms; frame-ancestors
  'self'`, so the shell and the app keep an opaque origin even when the shell is opened directly.
  The app's CSP comes with its stored document, as upstream injects it. Upstream's asset route
  adds its theme and cookie bootstraps (`injectMcpAppThemeBootstrap`,
  `injectMcpAppCookieBootstrap`) to the served document; here `McpAppFrame` adds them before
  posting the document to the shell. The page policy allows
  `frame-src 'self'`, and every other gateway response keeps `frame-ancestors 'none'`. The shell's
  load and the written document's load both count as the app's own; a third load means the app
  navigated away.
- **HTML renders.** Upstream's `html_render` tool, `HtmlRender` service, and inline frame, with
  these Coder deltas (each marked `Coder:`):
  - The bridge carries `html_render` only. `htmlRender/HtmlRender.ts` keeps upstream's image
    inlining and storage but not `preview` or height measurement, because work workspaces cannot
    obtain the headless browser they need; pages publish at the agent's height, the frame shrinks to a shorter page's
    reported height, and a page with its images inlined is capped at `MAX_TURN_ITEM_ASSET_BYTES`, the
    bounded turn-item read. Publishing records the page through upstream's
    `McpProviderSessions.recordHtmlRender` (#19796). The tool description omits `html_preview` and
    the mobile-only scroll-cap sentence.
  - Over the bridge the call is a shell command, so `htmlRenderFromBridgeCommand` (shared
    `toolOutput.ts`) recognizes a completed `…/t3-tools-<id>/t3.mjs html_render` command whose
    output is the tool's JSON result. `WireProjection` keeps only that compact reference on the
    wire (other command output stays withheld), and the timeline shows the page there, as
    upstream shows a `dynamic_tool` render. Any command could print such output, so
    `workspace.readTurnItemAsset` (`html-render` asset) serves only a page stored in the item's own
    thread, opened without following symlinks.
  - `chat/HtmlRenderFrame.tsx` reads the page through that read and `files/BrowserDocumentFrame.tsx`
    writes it into the MCP App shell with the theme in the shell URL's fragment, as upstream's
    signed URL carries it. **Open full screen** shows the same in-memory page in upstream's
    `chat/HtmlRenderDialog.tsx`, which takes the page (`html`) where upstream mints a fresh
    signed URL, so the frame has no "Page unavailable" toast. `BrowserDocumentFrame.tsx` keeps
    upstream's image dialog and load handling. Links in a page open as
    upstream's chat links do; `SentAttachmentFilePreview` passes the thread for them where
    upstream's `FilePreviewPanel` does, and with no in-app browser `browser/useOpenLink.ts`
    sends every other link to the system browser.
  - Pages are kept like other attachments; deleting a thread does not delete them.
- **Tool output images.** `turnItemOutputImages` lists a fetched item's images, and the inspector
  renders each with `ChatMarkdownAssetImage`, as upstream does. The image is read by index from the
  stored item through `workspace.readTurnItemAsset` into the shared bounded image store, in place
  of upstream's signed `tool-output-image` asset URL.
- **Runtime modes.** New threads use upstream's `defaultRuntimeMode` setting (`full-access` by
  default), limited to the modes the workspace provider reports. Until a provider reports its
  supported modes, the composer and the Codex adapter offer only the safe modes; an unsupported
  selection falls back to the most permissive supported mode. `RuntimePolicy` applies the same
  per-model clamp when it starts a run, so the provider receives the mode the composer shows.
- **Contracts.** `packages/contracts` follows upstream, including dormant schemas for surfaces Coder
  does not serve (auth, provider setup, other providers' settings, browser, device, preview, usage
  sources, agent sessions, filesystem browse, background policy). Coder deltas:
  - `rpc.ts` omits RPCs whose schemas belong to excluded modules (assets, attachment upload URLs,
    preview automation, relay, resource telemetry, usage, editor launch, GitHub routing, feedback
    upload, HTTP content search, and the OTLP endpoint check) and adds the helper-only methods
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
  - `ServerConfig` omits auth, editors, remote open targets, and observability, except
    upstream's optional `lastEventLoopStall`, which stays in the schema but is never sent.
  - `VcsProcessExitError`'s not-found detail drops upstream's `gh`/`az` "Pull request" text.
    The rest of `vcs.ts` and `git.ts` keep upstream's shapes, plus the helper-only ref-status
    and thread-branch rename schemas.
  - `ModelCapabilities` carries the provider-reported `supportedRuntimeModes`; custom models use
    `CustomModelCapabilities`, which cannot declare them.
  - Tool items keep legacy screenshot `artifacts`; rate-limit events carry the raw payload.
  - Terminal attach input adds `afterSequence` and `afterEpoch`, terminal snapshots add
    `attachEpoch`, and the attach stream adds a `resumed` event.
  - Claude launch args reach the workspace CLI except the stream-json transport flags. `ClaudeAgentSdk.ts` passes
    `mcpServers` and `strictMcpConfig` as the SDK does and rejects in-process (`sdk`) MCP servers,
    which the CLI transport cannot host.
  - The web provider list and client-runtime `state/server.ts` stay limited to the methods the
    helper serves and to Codex, Claude, Pi, and Kilo Code (`acpRegistry`) driver instances
    (`isCoderProviderDriver`).
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
  preview, or usage page; and review actions say merge request. Clone sources, host icons, and
  publish targets come from the GitLab-only client registry (see Source control below).
  Clone URLs are validated by the helper.
- **Composer, timeline, and work log.** Upstream's context records, upload queue, chips, and
  work-log module (`client-runtime/work-log/toolPresentation.ts`), minus preview annotations,
  element captures, SnapShot (with its open question-draft tracker in `questionAttachments.ts`),
  upstream's large-paste-to-file folding, and remote icons. Draft file
  and video attachments preview from their in-memory bytes as on main: files open in
  `files/AttachmentFilePreview.tsx` (upstream's viewer, with Save writing the in-memory bytes
  instead of a signed-URL download) and videos in the gallery. A draft restored after a reload has no bytes, so it has no
  preview. A context fragment pasted from another workspace
  brings only its PNG, JPEG, and WebP images, read through the helper's bounded attachment chunks,
  unless this browser copied the fragment from an unsent draft: then upstream's
  `copiedComposerAttachments.ts` supplies the draft's in-memory images and files.
  A thread dropped from another workspace attaches its saved transcript (see Transport and RPC
  handlers). Images
  and files move through the gateway's Coder CLI transfer (see
  [Network and transfer constraints](#network-and-transfer-constraints)); `ChatView` gates them on
  the helper's advertised attachment capabilities, as upstream does. Upstream's `assetEnvironment` (`state/assets.ts`) is replaced by atom families
  that read each image through the helper into the bounded image store and release it when the
  atom unmounts. `assets/assetUrls.ts` keeps upstream's `useAssetUrlState`, `useAssetUrlRefresh`,
  and `useAssetUrls` over them: a URL is the store's object URL, a refresh rereads the store
  entry, a read waiting for room in the store is `Loading` with `deferred`, and
  `useAssetUrlState` takes a `priority` option for the image the user opened. Upstream's asset
  URL also carries an image's header size; `assetEnvironment.imageSize`, read through
  `useAssetImageSize`, stands in for it. It reads the first `IMAGE_SIZE_PROBE_BYTES` of a workspace
  image for the helper's header size, keeps the size the browser decodes for other formats and
  resources, and outlives the bytes for `IMAGE_SIZE_IDLE_TTL_MS`, upstream's asset URL idle TTL.
  Only images use
  this layer. Workspace video and audio, Files PDFs and HTML, HTML renders, and MCP App documents
  keep their own reads (`useProjectMedia`, `readTurnItemAsset`), where upstream uses the same
  hooks, because each needs the whole file or the document text and a size an image store entry
  does not hold. Those memory-only blobs never re-sign, so `FilePreviewPanel` passes no
  `revision` to `MediaVideoPlayer` or `AudioPreview` (upstream's file-revision reload, #23106);
  both components' revision handling is upstream's. Submitted images are read by id
  (`AttachmentImageResource` carries the media type and size the read verifies). Reads start only once the workspace is connected, because cached
  threads render before the helper is reachable. Rewind re-stages a message's images through the
  same reads.
  Sent file attachments keep upstream's preview and download actions; the helper reads them by
  id (`workspace.readAttachmentFile`, bounded by the composer file limit) into memory, and the
  right panel shows them in `files/SentAttachmentFilePreview.tsx` where upstream's
  `FilePreviewPanel` loads a signed URL. Native app icons fall back to the tool glyph.
  `WorkspaceEntryIcon.tsx`, `UserMessageContextChips.tsx`, the composer, and its attachment
  strip format sizes and limits with the web's `lib/attachmentDisplay.ts`, because
  client-runtime's attachment upload module is not carried.
  Upstream's v1 importer carries only messages, and upstream migration 063 drops the v1
  `projection_thread_activities` rows, so screenshots that pre-v2 conversations saved as
  `artifacts` on v1 tool activities are not shown, as on upstream. `workspace.readScreenshotArtifact`
  reads submitted image attachments only.
- **Project actions.** The thread details panel, action editor, and Settings → Actions are
  upstream's. Coder deltas: repository actions come from the helper's validated `t3.json` read by
  project (`projects.getConfig`), which drops `iconPath` and script preview fields; the editor has
  no preview URL.
- **Right panel and composer chrome.** `RightPanelTabs.tsx` is upstream's tab strip and
  `PreviewPanelShell` layout without browser, device, and preview surfaces: no launcher rows,
  favicons, browser profiles, audio controls, or device rename. Never-opened preview and device
  surfaces in the store get a plain title and icon. Merge-request rows, tabs, and disabled reasons
  use GitLab wording and `!` references. The branch toolbar is upstream's; workspace options are never primary and use
  the server's machine kind, there is no "Auto balance" run target (upstream's load balancing is
  not carried), and it has no server-update control (server self-update is not carried). The branch picker adds "Rename current branch…" for a
  thread's own branch (`vcs.renameThreadBranch`), which can also rename the T3 worktree folder
  through the driver's `moveWorktree`. Proposed-plan cards are upstream's; Save to workspace uses
  `projects.createFile`, so it fails on an existing path. There is no default-theme adoption, which follows
  upstream's `t3 theme set` CLI.
- **App entry.** `index.html`, `bootstrap.ts`, and `main.tsx`'s startup (stale-chunk reload,
  splash held until the first route loads, boot error) are upstream's. `main.tsx` renders the app
  inside `CoderBootstrap` and installs `consoleDiagnostics`, with no Electron shell, managed auth,
  or provider auth delivery.
- **App sidebar.** The layout, header, footer, and provider-update pill are upstream's. Coder
  deltas: there is no legacy sidebar (or its Settings switch), usage page, desktop app-update
  pills, desktop window bridge (fullscreen insets and menu actions), or preview keybinding
  context; the active workspace supplies keybindings and the pill's providers. Without
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
  route workspace's config. The Files surface opens for drafts as on main; a draft's Files
  requests name its project so the helper can verify the root. `chatCanvasLayout.ts` has no preview obstacles (it accepts upstream's `findBar` and ignores it),
  and `ChatCanvas.test.tsx` covers only the details card inset below Find; the right panel keeps
  Coder's per-thread width storage instead of upstream's preview inline size. Pieces upstream
  moved out of `ChatView` carry the same cuts (each marked `Coder:`): `RightPanelSurfaceContent`
  renders nothing for browser and device surfaces, previews sent attachments through
  `SentAttachmentFilePreview`, passes the project id to `FilePreviewPanel`, and names merge
  requests; `useRightPanelSurfaceClose` closes no preview sessions and asks no agent-browser
  confirmation; `useQueuedRunEdit` carries no preview annotations and previews only images the
  helper reads; `useThreadLinkedPullRequest` names merge requests; `useSystemComposerBanners`
  shows only the offline or reconnecting banner, with no connection diagnosis, disconnect action,
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
  `ProviderInstanceRow` passes no ACP sign-in, managed Codex runtime, or provider setup section.
- **Markdown.** `ChatMarkdown.tsx` and the modules upstream split from it (`chat/ChatMarkdownMedia.tsx`
  for images and videos, `chat/MarkdownFileLink.tsx` and its `.logic.ts` for file chips) are
  upstream's, with these differences (each marked `Coder:` in the files):
  - Workspace media has no signed asset URL. `ChatMarkdownAssetImage` keeps upstream's body over
    `useAssetUrlState` and `useAssetUrlRefresh` for `media-file` and `tool-output-image`
    resources, without `fallbackSrc` or `originalUrl`. Upstream's `workspaceMutationId` refresh
    rereads a Markdown file preview's images after an edit, waiting on the workspace's helper
    connection where upstream waits on its prepared HTTP connection, and on `Loading` alone, since
    the image store has no refreshing state. A workspace file
    needs the thread root (`cwd`), which the helper verifies, and reads only near the viewport;
    until it loads, a placeholder keeps its box (`useAssetImageSize`) and opens the gallery. Its
    `inline-flex` wrapper is exactly its child's height, so once the size is known, the swap
    never resizes its row.
    Failed reads offer **Retry image**; with no signed asset there is no upstream "not found on
    <host>" toast. Videos show a play card that reads the file when pressed.
    Images in formats the helper does not read show "Unsupported image format" without a read,
    and authored `id`s stay on workspace images.
  - The gallery item (`ExpandedImagePreview.tsx`) is upstream's shape plus `projectImage`,
    `projectVideo`, legacy `artifact`, `loading`, and `retry`. `resolveMarkdownMediaPreview`
    returns helper sources rather than asset URLs. The dialog reads the selected image with
    priority, the gallery also collects `[data-project-image]` wrappers so unloaded images stay
    navigable, and byte actions use the blob the dialog shows. `wrapExpandedImageIndex` stays (upstream removed
    it) because the fork's `ExpandedImageDialog` wraps gallery navigation with it. Timeline galleries are hosted by
    `ChatView`, as on main.
  - There is no in-app browser, local editor, or file manager: `MarkdownFileLink` never receives
    `onOpen`, `onOpenInBrowser`, or `onReveal`, and the link context menu never offers the
    integrated browser. Without a primary action a chip opens only its copy menu.
  - File chips open only project-relative files in the Files surface; other host paths do not
    open the panel. Media outside the project opens the gallery. Upstream's chip menu may copy
    the chip's relative or full path, which is the path already written in the message; this is
    separate from the Files surface, whose Copy path action stays project-relative.
  - Relative and non-web links render as inert text. GitHub-authenticated media (`githubMedia`)
    is omitted; web images and videos load directly from their host.
- **Files and search UI.** `components/files/*`, `components/search/*`, the file picker, and the
  keybindings are upstream's. Coder deltas (marked `Coder:`): file reads, listings, writes, and
  content search name the thread so the helper can verify the project root; reads return a
  revision that each write must match, and a rejected save offers **Reload and discard edits**;
  content search uses the helper's time-budgeted search (`projects.searchText`), showing its first
  page; image, video, and audio previews read through the helper instead of signed asset URLs
  (the image preview through `useAssetUrlState` with priority; a workspace mutation rereads an
  open image, but video and audio reread only on retry or
  reopen because each read moves the whole file); a draft names its project rather than a thread;
  PDF and HTML previews read through the same helper media chunks, project files only (see
  [Network and transfer constraints](#network-and-transfer-constraints)), and a PDF keeps the
  built-in viewer's frame where upstream uses `<embed>`, which the gateway's `object-src 'none'`
  blocks; there is no
  open-in-editor or reveal action, and the tree adds Copy path. Changed files in the Git actions
  dialog open in the Files surface, with repository-relative status paths mapped to the thread's
  folder; a file outside a subfolder project cannot be opened there.
  `projectFilesQueryState.ts` has no `isFile`, which only the uncarried `OpenInPicker` reads.
  `env.ts` reports `isElectron = false` for upstream's desktop branches.
- **Merge requests.** Upstream's page, panel, stack menu, and right-panel tabs, GitLab-only. Diffs
  come over the `pullRequests.diff` RPC without upstream's cross-environment GitHub routing,
  snapshots and the last merge method stay in memory (a project's default merge method is a
  workspace setting whose `null` means "last selected"), and `!` references and GitLab wording are
  used. Label RPCs exist but GitLab does not advertise label editing, and native stack actions are
  never advertised. Video uploads play inline, other uploads link as on main, and `/uploads/`
  links resolve against the repository host (client-runtime `pullRequestMarkdown.ts`, which also
  names a GitLab or self-hosted upload's host; the `!123` autolinks stay in the web's
  `pullRequestMarkdown.logic.ts`). Actor avatars load as on main. MR links everywhere
  (Markdown, the sidebar, composer and timeline chips, and the thread MR panel) open through
  upstream's `lib/openPullRequestLink.ts`. Its `parseChangeRequestUrl` (client-runtime's
  `pullRequestLinkInput.ts` filter, re-exported) accepts only a URL a shipped host definition
  claims (GitLab's `/-/merge_requests/`), and project matching uses upstream's host
  resolvers but skips checkouts whose provider is neither GitLab nor unknown (the registry reads
  other kinds as the generic host, which would still match by host and path). A linked MR's
  snapshot status needs a GitLab URL, with no fallback host. `gitLabMergeRequestBrowserUrl` replaces upstream's GitHub fallback URL (and GitLab's
  definition URL in `LinkPullRequestDialog`'s `resolveLinkPullRequestProject`, which wraps
  client-runtime's `pullRequestLinkProject`) and keeps a self-hosted install's origin and path
  prefix. A plain click opens the panel or page, and a
  modifier or middle click or an MR no workspace project can read goes to the system browser.
  Upstream's "Open pull requests in T3 Code" client setting lives on the Integrations page, which
  is not carried, so it keeps its default and MR links always open in the app.
  Upstream's delete-branch action, panel entries, and menu items are carried with merge-request
  wording; GitLab does not declare `deleteBranch`, so they never show, and `PullRequestService`
  runs the action without upstream's verified-credential wrapper. In Markdown
  they are upstream's new-tab anchors with hover previews. The merge requests page resolves a link
  against every workspace that reads merge requests, the primary first. Right-clicking a web link shows upstream's menu (system browser, Copy Link, and
  Link/Unlink to thread through `usePullRequestLinking`). GitLab autolinks keep their
  `merge-request`, `issue`, and `commit` kinds, so upstream's GitHub reference confirmation is
  unused.
  - User-facing text says "merge request", "MR", and `!123` wherever upstream says "pull
    request", "PR", or `#123`: the panels, composer, settings, toasts, keybinding labels, and
    the strings the web shows from `client-runtime` (work-log tool labels and MR actions) and
    `shared` (T3 tool presentation, watch descriptions, and copy-link toasts). The agent-facing
    text the server writes says "merge request", `!123`, and "T3 Coder" too: the merge-request
    watch wakes and their notification summaries (`pullRequestWatch.ts`,
    `PullRequestWatchReactor.ts`), the merge-request T3 tool descriptions and errors
    (`mcp/toolkits/pullRequests/tools.ts`, with GitLab example URLs), and `GitManager`'s
    merge-request ref fetch error. `runtimeInstructions.ts` stays upstream's. Identifiers, wire
    names, and search haystacks keep upstream's spelling, and the composer trigger stays `#`.
    GitLab's client definition supplies "MR" and "merge request" wherever upstream reads a host's
    terminology, and a missing provider reads as GitLab because it is the only definition; `!123`
    is still applied by hand, since definitions carry no reference prefix. Text for paths GitLab never reaches (native stacks, stack merges,
    `PullRequestsUnavailableState`'s GitHub link, GitHub-only setting rows) is upstream's. These
    pure wording substitutions are not marked line by line; every other difference is.
- **Source control and merge-request services.** `sourceControl/`, `pullRequest/`, and upstream's
  `@t3tools/source-control-core`, `-gitlab`, and `-testing` packages are upstream's, GitLab-only.
  Upstream's GitHub, Azure DevOps, Bitbucket, and Forgejo packages are not carried. Coder deltas,
  each marked `Coder:`:
  - `sourceControl/builtInDrivers.ts` lists and provides only the GitLab driver, so both
    registries iterate GitLab alone. Upstream's client host definitions are carried the same way:
    client-runtime's `sourceControlClients.ts` registers only GitLab's definition, so labels,
    terminology, icons, clone and publish pickers, reference parsing, and project matching follow
    GitLab alone, and every other kind reads as the generic host. The server's
    `sourceControl/sourceControlHostSecrets.ts` reads only GitLab's definition, which declares no
    host settings, so no host secrets exist; upstream's `SourceControlHostSettings` form is not
    carried.
  - GitLab's client definition (`source-control-gitlab/src/client/definition.ts`) has three
    deltas: `isChangeRequestReference` accepts a merge request URL on any HTTP(S) host, because
    self-hosted hostnames need not contain "gitlab"; `authorProfileUrl` links comment authors
    under the host root; and `referenceAutolinkRepositoryUrl` gives the web's GitLab autolinks
    (`pullRequestMarkdown.logic.ts`) the repository URL, where upstream's definition returns null.
  - GitLab implements upstream's optional hover-preview and summary (batched through aliased
    GraphQL) reads, which upstream implements only for GitHub. Diff output is capped
    (`DIFF_MAX_OUTPUT_BYTES`) to fit the gateway's `MAX_RPC_MESSAGE_BYTES` ceiling.
  - GitLab fixes for bugs still in upstream's `GitLabCli` (checked against upstream `main`
    eb1510d249):
    merge requests between projects post to the source project with a numeric
    `target_project_id` instead of sending the repository text as `source_project_id`; merge
    request URLs reach `glab` as `--repo <url> ... -- <iid>` because older versions read URLs as
    branch names (options stay before upstream's `--`); `mr checkout` honours `branch` and `force`.
  - `glab auth status` lines carrying a token label or a `glpat-` token are never surfaced. Clones
    accept only GitLab URLs without credentials, query, or fragment, and pass `--` before the URL.
  - `PullRequestService` omits upstream's cross-environment routing (routing identities,
    verified credentials, `expectedAccountId` refs) and Forgejo SSH-alias refinement. It keeps
    `allowStale: false`, which the merge-request watcher uses to read past the held detail.
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
    renames a thread's worktree folder together with its branch, and `refStatusLocal`, a
    branch read that never refreshes the real index. Review file expansion allows up to
    `MAX_REVIEW_DIFF_FILE_BYTES` and fails with `ReviewDiffFileTooLargeError` for the chunked
    review RPCs, rejecting malformed UTF-8. A top-level review `sourceKind` returns only that
    source. Worktree creation reads `t3.json` through the bounded `readProjectConfig`.
    Checkpoint commits use the "T3 Coder" identity.
  - `VcsProcess` has no GitHub CLI semaphore and classifies only `glab` failures.
  - `GitManager` fetches merge-request heads from `refs/merge-requests/<n>/head`. It has no `targetsOnlyRemote`: with no origin, the only
    remote is the repository `glab` targets, so upstream's check of gh's `GH_REPO` and
    `gh-resolved` mark (and its `source-control-github` import) is not carried.
    Upstream's GitHub and Forgejo branches stay verbatim but are unreachable with the GitLab-only
    registry.
  - `GitWorkflowService` adds `moveWorktree` and `localRefStatus` pass-throughs.
  - `VcsStatusBroadcaster` adds `streamRefStatus` for `subscribeVcsRefStatus` and resolves
    auto-pull with `resolveProjectAutoPull`. Its `BackgroundPolicy` dependency is a
    Coder-owned stub that always allows work, because polling already stops when the last
    status subscription ends. `server.ts` provides upstream's `layerAutomaticFetchInterval`, so the remote refresh interval follows the background-activity profile as upstream's does.
  - Startup auto-pull (`vcs/projectAutoPull.ts`) is upstream's `autoPullProjects` from
    `serverRuntimeStartup.ts`, with the same per-project enablement.
- **Settings.** Upstream's layout, navigation, and search, with Coder's Connections, Providers,
  GitLab, and background-activity panels. No Integrations, SnapShot, desktop, diagnostics,
  pairing, mobile app links (`MobileAppSettingsRow`), or `keybindings.json` editor. Appearance's **Add theme** is upstream's
  `ThemeImportDialog` without its remote theme catalog search or desktop file picker: the browser
  reads picked, dropped, or pasted theme files itself. Connections holds the Coder deployments,
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
  workspace", because there are no routes, T3 Connect, WSL, or SSH targets. Older fork links that
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
  upstream's migrator and its V2 id-clash check, so `Migrations.test.ts` is upstream's. New
  migrations take upstream's next ID; never add a Coder-only migration ID. `migrationEntries`
  stays exported (upstream made it private) for the Coder legacy-history tests.
- **Persistence.** Merge-request snapshots, right-panel tabs, diff-panel selections, closed-view
  history, the last merge method, and the last project grouping mode stay in memory where
  upstream uses browser storage. Upstream's offline query persistence, which only its mobile app
  provides a store for, is not carried: client-runtime's `state/runtime.ts` query atoms take no
  `persistence` option and `state/pullRequests.ts` passes none. Its query key normalizer drops
  upstream's `expectedAccountId`, which the contract does not carry. Model favorites, visibility, and order are upstream's server
  settings, so each workspace keeps its own. Upstream migrates a browser's saved lists into an
  environment whose settings have none; here the legacy lists are the workspace's own
  `providerPreferencesByEnvironment` entry, falling back to the global lists
  (`legacyModelPreferences` in `useSettings.ts`). `storage.ts` keeps
  upstream's IndexedDB environment cache without the connection catalog, credentials, GitHub
  routing permissions, or project favicons. The upstream idle thread-snapshot retention lifecycle
  keeps Coder's entry and size cap (`threadRetention.ts`). Composer drafts and the prompt stash keep text in browser
  storage but never image bytes. Upstream clears an environment's cached data and
  composer drafts when it is removed; Coder does this only when a workspace leaves the Coder
  config, because stopped and disconnected workspaces also leave the platform registrations.
  The workspace-to-environment mapping that makes this possible is memory-only, so a workspace
  removed before it reconnects after a reload keeps its drafts.
- **Diff panel.** `DiffPanel.tsx`, `DiffPanelShell.tsx`, `diffFileActions.ts`, and
  `components/diffs/*` are upstream's. Coder deltas, each marked `Coder:` in `DiffPanel.tsx`:
  expanded context loads through the chunked review RPCs (`createChunkedGitDiffFileContentsLoader`),
  and a file over the expansion limit is listed in `DiffFileExpansionErrorNotice` above the viewer
  instead of failing the diff. Branch previews ask for one top-level `sourceKind`. A file title
  opens the Files surface through ChatView's `onOpenFile` and has no local-editor fallback. The
  context menu offers Copy path (project-relative) in place of upstream's editor actions.
  Review diffs (`review/ReviewService.ts`) keep upstream's cwd check, which admits the server cwd,
  managed worktrees, and registered project roots, rather than the Files surface's
  requesting-thread verification, because every root it admits already belongs to a registered
  project.
- **Diff renderer patch.** `patches/@pierre%2Fdiffs@1.5.2.patch` is upstream's patch plus a guard
  that ignores loaded file contents unless the current diff is still the partial diff that asked
  for them.
- **Browser shell and connections.** Each marked `Coder:`:
  - `connection/platform.ts` registers only the configured Coder workspaces, reached through the
    loopback gateway; removing a workspace from the Coder config clears its drafts and caches.
    client-runtime's `connection/driver.ts`, `connection/index.ts`, `connection/wakeups.ts`, and
    `platform/persistence.ts` drop upstream's multi-route checks, credential and profile stores,
    saved targets, onboarding, GitHub routing, host updates, and the mobile `network-changed`
    wakeup. `connection/registry.ts` starts every registered workspace's supervisor desired
    (upstream starts only enabled ones), since the Coder config owns registration. Its entries
    carry no cached unsupported-host rejection, so web `state/server.ts`'s shortcut-keybinding
    fallback presents each workspace's connection state as is.
    `state/shell.ts` treats every workspace as remote (no primary local target).
  - `lib/runtime.ts` has no primary-environment HTTP client, relay, DPoP, or tracer, and
    `branding.ts` fixes the "T3 Coder" name without a desktop bridge or hosted channel.
  - Upstream's desktop IPC contract (`contracts/ipc.ts`) is not carried; `localApiTypes.ts` keeps
    its context-menu and confirm-dialog types, and `localApi.ts` opens only HTTP(S) links.
    `ThreadNotificationCoordinator.tsx` focuses the tab on a notification click without
    upstream's desktop window reveal.
  - client-runtime `errors/diagnostics.ts` is the `[t3-error]` DevTools reporting described in
    [Authentication](#authentication). `errors/network.ts` keeps only `UNRESPONSIVE_HOST_HINT`
    for upstream's "stopped responding" message (#22212); there is no relay network hint, T3
    Connect connection diagnosis (#22172), or host-freeze toast.
  - The server's `config.ts` is paths under the workspace state directory only.
  - A thread whose workspace is not connected shows `WorkspaceConnectionStatus`, and so does
    `_chat.index.tsx` after upstream's draft branch (#20183) while workspaces are pending or
    unreachable; the `/projects/$projectKey` redirect has no auth gate.
  - Merge-request list preferences remember presentation controls only, never repository
    identities or search text. Dropped or pasted folders are neither uploaded nor referenced
    (only files become composer attachments). `ChatComposer.tsx`'s `addComposerFolders` always
    takes upstream's remote-environment branch and shows its "local desktop environment" toast,
    because every workspace is remote; upstream's desktop path lookup (`folderDrop.ts`) is not
    carried. Project icons come from saved
    metadata or monograms, without favicon reads. The worktree setup card says "Use project
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
- **Build tooling.** `scripts/lib/third-party-licenses.ts` never fetches during a build: SPDX
  texts are committed under `licenses/spdx`, and only `pnpm licenses:sync` downloads missing
  ones. It reads no device tool version pins, because device tools are not carried.
  `pnpm-workspace.yaml` sets `supportedArchitectures` (Linux x64 glibc) on every host, because
  the helper bundle ships those native modules to the workspace; upstream sets it only on Windows
  in `.pnpmfile.cjs`, which is not carried. Its `overrides` pin only the patched packages the
  fork carries, where upstream pins every one of its own.
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
  running gateway's upload and helper image reads against a connected workspace, and
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
  system. Upstream's GitHub and Azure DevOps fixtures in the GitManager and guide-tool
  tests use GitLab projects, with GitLab merge request templates in place of GitHub's; GitManager's `GH_REPO` and `gh-resolved` only-remote cases are not
  carried. `ProviderInstanceRegistry.test.ts` runs upstream's Claude one-probe fallback test
  against the CLI transport's `query`, without the organization change the fork does not read.
  `SourceControlRepositoryService.test.ts` and `RepositoryIdentityResolver.test.ts` carry
  upstream's new publish-push, local-remote, display-casing, partial-clone, and missing-parent
  clone cases on GitLab remotes with the fork's mocks. `ProviderRegistry.test.ts` runs upstream's
  startup settings-change hydration tests without the uncarried Antigravity and OpenCode layers.
  `ThreadDetailsPrRows.browser.test.tsx` checks the run context, not the editor picker. `CommandPalette.focus.browser.test.tsx`
  mocks `useCoder` and sends `mod+p` with the platform's modifier (upstream's Ctrl+P matches only
  off macOS), and `GitLabPullRequestCli.legacy.test.ts` expects the fork's `DIFF_MAX_OUTPUT_BYTES`.
  `McpAppFrame.browser.test.tsx` reads its app through a mocked helper read into a stand-in for
  the gateway's document shell, where upstream serves a data-URL asset.
  `SourceControlProviderRegistry.test.ts` runs
  upstream's registry tests (its `makeRegistry` with remotes, process, and server settings) for
  the GitLab-only registry, with the "asks once" and "asks again" auth-probe tests driving
  `glab`. `WorkspaceSearchIndex.native.test.ts` is upstream's native decoding test plus the
  fork's content-search characterization (fff's `Result` imported as `FffResult` beside
  Effect's). `DatabaseStorage.test.ts` omits upstream's two `t3 doctor` status tests,
  `storageCleanup.test.ts` its saved-usage-cache test, and `PullRequestService.test.ts` its
  GitHub-credential branch deletion test; upstream's OTLP `config.test.ts` is not carried.
  `presentation.test.ts` omits upstream's disabled and unsupported connection tests, since Coder
  catalog entries have neither state. `GitManager.test.ts`'s pull request draft-status test and
  `SourceControlRepositoryService.test.ts`'s HTTPS clone-retry tests run on GitLab.
  `composerDraftStore.test.ts` keeps the draft-persistence test upstream pruned, because it
  checks that draft image bytes never reach browser storage.
  Replay fixtures (`orchestration-v2/testkit/fixtures`) carry only the Claude, Codex, Pi, and ACP
  Registry providers; `ProviderReplayFixtures.ts` lists only those drivers.
  client-runtime's `threadShell.test.ts` omits upstream's switched-off environment test, because
  the Coder config owns registration and there is no per-environment switch.
  `ws.test.ts` omits upstream's config-RPC buffering test, which builds upstream's session-scoped
  `layerWsRpc`. Upstream's `composerContextUndo.test.ts` (preview annotations
  only), `HtmlRenderFrame.browser.test.tsx`, and `BrowserDocumentFrame.browser.test.tsx` (signed
  URLs) are not carried; `DiffPanel.browser.test.tsx` passes `onOpenFile` without an editor mock,
  and `ProjectSettingsPanel.browser.test.tsx` keeps `projects.getConfig` pending as upstream
  keeps its file read.
  `pullRequestsRouteSearch.test.ts` runs under happy-dom, because the route module loads the diff
  worker, which needs a browser `self`. Upstream's `*.browser.test.*` files run in headless
  Chromium through Playwright as upstream's `browser` Vitest project, on the development machine
  only; `reactCompilerCoverage.test.ts` skips four fork-only files the compiler bails on
  (`CODER_UNCOMPILED_FILES`). The fork keeps `jsdom` and `react-test-renderer` as web dev
  dependencies for its own unit tests and for fork-adapted suites that stay unit tests in place
  of upstream's browser versions: `ChatMarkdown.test.tsx` (upstream's `ChatMarkdown.browser`,
  `.logic`, and `.assets` browser tests are not carried), `AttachmentFilePreview.test.tsx`,
  `ProjectSettingsPanel.test.tsx`, and `RightPanelTabs.test.tsx`
  (upstream's `RightPanelTabs.browser.test.tsx` is not carried). The carried browser tests omit
  cases for cut surfaces: grant checks in `ProjectSettingsPanel`, signed-URL renewal in
  `AttachmentFilePreview`, uncarried providers in
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
workspace lease as provider startup and terminal open/restart, rechecks sessions and Git state,
and preserves branches and thread history. Artifact retention maps upstream's browser-artifact
store to the legacy `screenshotArtifactsDir`; it never visits `attachmentsDir` or current image
source paths. Artifact, worktree, and rotated-log policies are disabled by default.
Upstream's **Delete now** action and latest cleanup report travel over the helper's
`server.runStorageCleanup` and `server.getStorageCleanupReport` RPCs; the report keeps only the
latest sweep in helper memory. Each of these is marked `Coder:`:

- `coderServer.ts` builds `StorageCleanup.layer` after `CoderRuntimeStartup` completes, where upstream
  parks its sweeps until server activation.
- The report calls artifact rows "saved image artifacts".
