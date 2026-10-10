# How T3 Coder keeps work in Coder

> This is a maintainer and reviewer reference. For the user-facing explanation, start with
> [Coder workspaces](../user/workspaces.md) and [Product decisions and upstream
> differences](../product-differences.md).

T3 Coder runs its browser interface on the developer's computer while repository, Codex, Claude,
terminal, checkpoint, and durable orchestration work stays inside Linux Coder workspaces. The
architecture exists to preserve that product promise without using upstream desktop, relay,
Tailscale, hosted-web, or direct remote-server connection paths.

## Repository branch model

The fork keeps two permanent branches with deliberately different responsibilities:

- `main` is a commit-for-commit mirror of `pingdotgg/t3code`'s `main`. The two refs must resolve to
  the same commit. No fork commit, merge commit, or pull request belongs on `main`.
- `coder-only` is the default branch and the T3 Coder product line. Coder adaptations, fixes, and
  upstream synchronization work are merged through pull requests targeting `coder-only`.

The repository ruleset for `main` rejects every normal update and has no persistent bypass. Treat
updating `main` as a mirror operation rather than ordinary development: after explicit
authorization, grant a temporary bypass, fetch upstream, verify the intended upstream commit, move
`origin/main` directly to that exact commit, and remove the bypass immediately. To update the
product, start from `coder-only`, merge `upstream/main` into a temporary sync branch, adapt
conflicts at the Coder boundary, and open the pull request against `coder-only`. Confirm the pull
request base before creating or merging it. If adopting upstream would remove fork-specific
behavior, notify the maintainer before making that removal.

## Product guarantees

- The browser interface is local-only.
- Coder owns workspace connectivity and Coder authentication.
- Codex, Claude Code, and Pi run only in the workspace and use workspace-owned configuration.
- Durable development and conversation data remains in the workspace.
- Workspace actions, file access, image exceptions, and port forwards stay within the deliberate
  product boundaries described below.

## Runtime boundary

The local process is a Node gateway that binds to an IPv4 loopback port and serves the web client to
a browser opened by the user. It reuses the port saved in `gateway-port` beside `config.json` when
that port is free, so browser storage keeps one origin across restarts; otherwise it binds an
ephemeral port and saves that. It stores only non-secret Coder deployment URLs, workspace targets,
structured port-forward rules, an optional Coder executable path, and the last gateway port. An
attached image may be staged temporarily in an OS temporary directory while it is copied to the
workspace; the local copy is deleted immediately after the transfer attempt. Browser UI preferences
such as theme and panel size may use browser storage. Composer drafts and prompt stashes retain
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

Live shell and thread subscriptions retain at most 1,000 events and 8 MiB of serialized live data
per subscription, including batches awaiting an RPC acknowledgement. Overflow detaches that live
source even if the browser is stalled during snapshot loading or acknowledgement; reconnect uses
the existing snapshot/replay and synchronization marker. Unused browser thread subscriptions are
released immediately. Following upstream's resume-snapshot design (`ea6af5924`), recent thread
snapshots, including running messages and their applied event cursors, survive for five idle minutes
without retaining RPC or environment scopes. The additional idle snapshot pool is limited to 24
threads and 64 MiB of conservatively estimated data per browser atom registry; least recently used
snapshots are removed when either limit is reached. Sizing uses string lengths without serializing
or encoding message bodies, and stops after 8,192 values or 64 levels of nesting. Snapshots exceeding
those limits are dropped. This can evict large or complex threads earlier than exact byte accounting,
but avoids scanning large message bodies when navigating away. Settled snapshots also remain in
main's IndexedDB thread cache.

The browser keeps a bounded in-memory terminal cache. Terminal attach requests resume
from an event sequence when the helper's bounded replay window still covers the gap, otherwise they
receive a complete capped snapshot. Shell subscriptions use upstream's per-aggregate coalescing
window, projecting the latest project or thread state once per batch. Thread subscriptions use
upstream's live-event coalescer and per-thread replay limits, including the serialized replay
payload budget. The browser applies each bounded received RPC batch with one state write.
Migration 049 stores manual active-thread order in the workspace. Initial thread snapshots target
512 KiB and older pages target 1 MiB by reducing the requested turn window;
the newest requested turn is always retained, even when that one turn exceeds the target. Older
pages use a unary RPC on the existing workspace connection. Review file snapshots remain bounded
and immutable (held in helper memory: at most 64 MiB and 256 entries, each expiring two minutes
after its last read), use adaptive per-chunk gzip when it reduces bytes, and are fetched only when the diff
renderer asks to expand omitted context; completed contents stay in a bounded browser cache.
Opening a file above the expansion limit returns a typed `tooLarge` outcome, not an RPC failure, so
the browser can keep the diff usable and render the limit notice without error-level diagnostics.
GitLab merge-request diffs are paged by file and capped below the gateway's 8 MiB RPC-frame limit;
host-backed full-file expansion is capped at 1 MiB of CLI output. These reads remain in browser or
helper memory and are not persisted by the gateway.

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

Agents reach upstream's T3 toolkits over a workspace file bridge instead of MCP. Each provider
session credential from upstream's `McpSessionRegistry` is a private temporary directory holding a
standalone CLI (run with the helper's pinned Node runtime) and a read-only tool catalog; no socket,
listener, or MCP server is opened. The CLI writes one request per call into its own call directory,
and the helper runs the named tool through upstream's toolkit handlers with the credential's
thread identity, never one the agent supplies. Plan-mode threads may call only tools upstream marks
read-only. Requests and responses are limited to 256 KiB. A call still running after 8 seconds
answers with a `bridge-job:` task id that `task_status` resolves, so long tools never depend on a
provider's shell timeout; at most 16 such calls run per thread and unread results are discarded
after an hour. Upstream's lifecycle owns the bridges: credentials are reused across turns and
revoked, which deletes the directory, when the session is released, the thread is archived or
deleted, or the helper stops. If a bridge cannot be created, turns run without T3 tools. Workspace
processes run as the same OS user; these directories are not an isolation boundary between mutually
untrusted agents.

The bridge carries upstream's orchestrator, thread, project, environment, worktree, and
pull-request toolkits. The pull-request tools accept only merge requests on a GitLab host that a
workspace project uses; project clones go through the same GitLab-only repository service as the
browser. Preview, device, and attachment-upload toolkits are not carried, and neither is
upstream's MCP HTTP server.

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

The gateway keeps at most 24 in-memory connection phase events per workspace for preflight, helper
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
Pi uses its RPC mode (`pi --mode rpc`) over stdin/stdout.
No provider executable or Anthropic Agent SDK runtime is bundled. The Agent SDK is a type-only
development dependency; pnpm's `ignoredOptionalDependencies` keeps its bundled Claude Code
binaries from ever installing. T3 does not inject its removed
preview MCP server or a local-host transport into Codex. Codex authentication and other
configuration remain workspace-owned and subject to workspace policy, including the MCP servers
and app integrations each provider loads from workspace configuration, as upstream. Each provider
connection remains owned by its workspace executable.
Native context compaction and asynchronous Codex questions use the same provider stdio sessions
and orchestration event stream; they do not introduce another listener or transport. The upstream
usage/cost dashboard is not included: remote pricing aggregation and user-configured CLI-proxy
sources would add a separate external-data and secret-bearing surface. This fork supports
API-backed provider usage only, with API authentication configured in the workspace. Subscription
plans and quota dashboards are outside the supported product scope. Provider settings therefore
omit subscription-limit summaries; context/token usage and runtime rate-limit errors remain.
This scope does not enforce authentication mode at runtime. Existing shared provider health probes
and protocol handling may still report native subscription metadata, but it is not displayed as
API billing information. T3 does not provide API spend, credit, or billing-limit tracking.
The helper also starts repository-scoped Git commands and the workspace-installed `glab`
executable with argument-array spawning and `shell: false` for GitLab source-control operations.
GitLab authentication and network policy remain owned by the workspace CLI; T3 never asks for,
reads, copies, persists, or logs its token.

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

Browser diagnostics stay in DevTools. Filter the Console for `[t3-error]` to see failed RPC
requests and streams, handled command failures, gateway HTTP/network failures, React errors,
and unhandled browser errors/rejections. Reporting is independent of per-action toast handling
and console-suppression options. Entries contain a timestamp, operation, error type, bounded
message and available stack; known credential formats are redacted, and request bodies and
arbitrary error fields are omitted. Repeated observations of the same error object are deduplicated
and normal cancellations are ignored. No diagnostic upload, trace exporter, or saved log file is
created. Errors caught and discarded outside these boundaries cannot be observed automatically.

## Supported hosts

Development is supported on macOS. The production local host is Windows 11 with the OpenSSH Client
feature installed, so local paths and processes must use Node platform APIs and argument-array
spawning with `shell: false`. The initial
workspace target is Linux x86-64. The helper launch is one foreground `coder ssh` session that
first runs the workspace preflight: it checks the remote OS and architecture, realizes a Node.js
24 package from the workspace's configured `nixpkgs` only when that runtime is not already
available, and checks Git, at least one of Claude Code, Codex, or Pi, and the workspace state
directory. A failed check prints a `T3_CODER_PREFLIGHT_FAILED:` line, which the gateway reports.
The preflight has its own five-minute budget; helper negotiation starts its 60-second budget only
after the launch prints the ready sentinel. As upstream, server settings keep sensitive provider
environment values out of `settings.json` in a `0700` secrets directory in that state directory;
they never leave the workspace. The helper carries its locked Linux x86-64 `node-pty` runtime and
is launched with the Nix package's absolute Node path without changing `PATH`, so workspace shells
and helper children retain the workspace's default Node.js version. Platform and protocol versions
are then negotiated before a helper is used.

## Network and transfer constraints

The T3 gateway does not make external HTTP requests. The installed Coder CLI is the only process
allowed to make a non-loopback workspace connection. Structured port-forward rules use foreground
`coder port-forward` processes and bind only to IPv4 loopback; reverse forwarding, arbitrary bind
addresses, and raw tunnel arguments are not exposed. The gateway may invoke OpenSSH `scp` for helper
bootstrap and validated composer-attachment (image and file) uploads only, with `coder ssh --stdio`
as its ProxyCommand.
SCP must not connect directly to a workspace or use authentication outside Coder. The helper opens
no network listener; Codex, Claude, and user-initiated terminal commands remain subject to workspace policy.

Provider version checks are workspace-originated network requests: the helper queries
`registry.npmjs.org` for the latest version of each enabled provider whose installer it can
identify; manual installations are not checked. The workspace
setting `enableProviderUpdateChecks` is on by default; disabling **Settings → General → Provider
update checks** opts that workspace out. Explicit provider updates run the installation’s identified
installer inside the workspace. Versions marked broken or unsupported by the bundled compatibility
policy are not offered. The model manifest and compatibility policy remain bundled-only and are
never refreshed over HTTP.

General user-facing file transfer remains disabled. The exception is a composer attachment: an
image or file pasted, picked, or dropped into the message composer or a question answer. The
browser sends it only to the loopback gateway. The gateway's `clipboard-image` route accepts
signature-validated PNG, JPEG, or WebP content up to 10 MiB; its `attachment-file` route accepts
any non-empty file up to 50 MiB, using the file name only to derive the stored extension
(`[a-z0-9]{1,10}`, otherwise `bin`, by the helper's `attachmentFileExtension` rule, shared as
`@t3tools/shared/attachmentFileExtension`). The gateway stages the bytes in an OS temporary
directory and copies them through helper-scoped SCP beneath `$HOME/.t3-coder/attachments` as
upstream's pending upload, `pending-<uuid>-<ext>.<ext>`. It then deletes the local staging file and
returns the workspace path plus the pending attachment's id, byte size, and (for images) media type
to the draft's in-memory attachment state. The helper advertises upstream's `attachmentUploads`,
`questionAttachments`, and `fileAttachments` capabilities, which the composer gates on. The browser uses upstream's attachment upload queue with the Coder
gateway as its transport: at most three concurrent transfers per workspace, matching upstream's
per-environment limit. Source images up to 50 MiB are prepared with main's byte-limit compression
algorithm inside the queue slot: images at or below 10 MiB pass through unchanged, and larger images
are resized and re-encoded to fit. The draft keeps the source bytes in memory, so a retry prepares
them again. The browser upload API, gateway, and workspace provider-input reader all enforce the
same 10 MiB image constant; files upload unchanged under main's 50 MiB file constant. Images in
other formats are rejected before queueing, and pending uploads are never deleted from the
browser; the helper's pending sweep removes unsent ones. Completed images retain their workspace identity. Moving or restoring
images into another workspace queues them for that destination and cancels any old transfer. The
browser retains failed images for explicit retry, requeues them when their workspace reconnects,
and aborts a transfer when its draft attachment is removed. Persisted drafts and stashed prompts
never store image bytes or image upload ids; a stashed prompt records only the names of images it dropped. HTTP response closure interrupts that transfer's Effect scope, which stops its exact
child process and cleans up staging. Progress updates use upstream's five-percent steps.
Percentage progress covers only the loopback upload; the
workspace copy remains pending until SCP and finalization complete. A sent message or question
answer carries upstream's attachments—at most 100, never a caller-supplied path or inline data
URL. As upstream does, the helper claims each pending upload into a thread-scoped copy when it
accepts the message; Coder reads the staged file once through a no-follow handle, requires its
exact declared size (and, for images, a PNG, JPEG, or WebP signature matching the declared type),
and writes those bytes exclusively to the claimed path. Files reach the provider as workspace
paths, as on main. A failed dispatch removes
its claimed copies; unsent pending uploads expire after a day. Provider input resolves attachments
only beneath the attachment directory, rejects symlinks, size violations, and signature
mismatches, bounds one message's images to 80 MiB in total, and sends the validated bytes to Codex
as native image input and to Claude as image content blocks. The same validated images may be
passed by fixed path to the workspace Codex process that generates the initial branch name and
thread title. Images Coder stored before adopting upstream's attachment ids (`<uuid>.<ext>`)
decode as `legacy-<uuid>-<ext>` attachments that resolve to their original files; they are never
claimable. The timeline previews a message's image attachments by id through the bounded chunk
read; rewinding stages fresh copies of them in the draft.

The composer uses upstream's structured context records. Mentions, terminal contexts, review
comments, and images travel as `t3-context://v1/<kind>/<id>` links in the message text plus
`message.context` records, which the helper persists with the message and renders for the provider
through upstream's projection. Coder omits upstream's preview annotations, element captures,
and SnapShot frames. Rewinding and restoring queued
messages read images back through the bounded chunk read. The composer's provider refresh action
uses upstream's `server.refreshProviders` RPC over the existing stdio stream, without upstream's
remote model-manifest or usage-limit refreshes. The timeline renders sent context as upstream's inline chips; messages sent
before context records are upgraded in memory by upstream's legacy converter, and their links to
pasted image files are hidden because the images render from the message's attachments. Work-log
presentation uses upstream's client-runtime module without provider tool sources, favicons,
logos, or native app icons: tool rows use built-in icons, and viewed images load through the
bounded project image read.

The Files surface is a contained text-editing capability, not a transfer mechanism or general
filesystem API. The browser supplies the active project root plus a project-relative path to the
workspace helper over the existing RPC stream. The helper first verifies that the root is the
requesting thread's project checkout or managed worktree. A draft the server does not know yet
names its project instead of a thread, and its root must be that project's checkout or a worktree
one of the project's persisted threads owns; a request naming a thread is always checked as that
thread. Reads are capped at 1 MiB; binary files
are rejected, larger text files are truncated and read-only, and both lexical traversal and symlinks
resolving outside the project are rejected. Writes apply only to an existing, non-truncated text
file, use the revision returned by the read to reject stale edits, and replace the file atomically.
These ordinary user-initiated read and edit operations retain the 1 MiB limit and all existing root,
path, UTF-8, binary-file, symlink, revision, and atomic-write validation.

File search has two deliberately separate indexes. Filename and path search continues to use a
lightweight path-only FFF index. Project-content search may create a separate, on-demand,
content-enabled `@ff-labs/fff-node` index only after the helper verifies that the exact project root
belongs to the requesting thread. The helper must resolve that verified root and pass the resulting
real project root as FFF's `basePath`; a filesystem root or home directory must never be indexed or
searched. Content search may use FFF's native plain-text grep and native regex grep. It must enforce
a hard native search time budget, initially 250 ms per request, and support cursor-based pagination.
Each request may return at most 100 matches from any one file and 500 matches total. A content index
has a 15-minute idle TTL and must be destroyed deterministically on expiry and when its owning
project or helper lifecycle ends.

FFF output is untrusted input. Before a match is exposed, the helper must reject absolute paths,
traversal, NUL bytes, malformed relative paths, and any path whose realpath or symlink resolution
escapes the verified project root. Returned paths remain project-relative. Results may contain only
bounded UTF-8 line snippets and match ranges; binary-file matches must be rejected or suppressed.
The search RPC must not expose arbitrary file bytes or become a general content-reading API. Errors
and logs must omit query text, matching contents, absolute paths, and secrets. Cancellation and
timeout handling must terminate or yield search work so content search cannot monopolize the
helper's stdio RPC connection.

Once this compliant native, time-budgeted content-search path replaces the existing scanner, the
former 2,000-file and 32 MiB aggregate scan limits are removed; they are not replaced by permission
for unbounded request time or unbounded result delivery. Before implementation is approved, focused
tests on the supported Linux x86-64 helper target must characterize FFF's behavior for symlinks,
binary files, oversized files, regex failures, cancellation, and time budgets. This exception is
only for project-content search. It does not change ordinary file-read or edit limits, and it does
not authorize uploads, downloads, synchronization, arbitrary file reads, or non-Coder workspace
connections.

The Files surface exposes no upload, export, drag-and-drop, absolute path, or local file access for
text files. An explicit Copy path action may copy only the project-relative path to the browser
clipboard. Media previews carry main's media menu, described below. Open files and editor state
are not persisted locally; the explorer visibility and rendered Markdown/table preferences are UI
preferences in browser storage, as on main.

Media previews follow main's on-demand file flow. Markdown and expanded image-view tool activities
resolve image and video paths without capture events or source-path fingerprints. The helper verifies
that the requested root belongs to the thread, resolves relative paths from that root and accepts
absolute or home-relative image paths elsewhere on the Linux workspace machine. Symlinks resolve
to an exact file; the helper checks its opened path, device and inode, rejects non-files, and
validates each file's signature against its extension: PNG, JPEG, WebP, GIF, AVIF, SVG, BMP, and
ICO images; MP4, M4V, MOV, WebM, OGV, MKV, and AVI videos; and MP3, WAV, OGG, OGA, Opus, FLAC, AAC, M4A, and
AIFF audio. No remote URLs or general file reads are accepted. Each image is limited to 20 MiB, each
video or audio file to 256 MiB, and each stdio chunk to 4 MiB (about 5.3 MiB of base64, beneath
the 8 MiB frame limit). A revision based on file identity,
size, and modification/change timestamps must remain constant across chunks; a changed file fails
with a generic retryable error. No file content or path is included in image errors.

The helper does not create screenshot artifact copies or coordinate per-turn image capture. New
previews use current source files, so changing, moving, or deleting a file affects future reads.
There is no per-turn image count or storage quota. Existing artifact IDs and submitted attachment
IDs remain readable through the legacy bounded chunk RPC; their workspace copies are not purged.
The artifact directory is no longer created for new workspaces. Draft attachment bytes stay in
browser memory; submitted copies remain under the workspace attachment directory.

The UI retains main's thumbnail, Markdown, zoom/pan, and gallery presentation with Coder transport.
Media links follow main's file chips: a project file opens in the Files surface, and media outside
the project opens the gallery. Inline images load near the viewport. The shared
memory-only image resource store permits three concurrent reads and reserves at most 100 MiB.
Selected gallery images take priority over other previews; deferred previews can still be opened.
The gateway persists no image bytes and opens no additional route or workspace connection.
Main streams workspace video through signed range URLs; Coder instead reads the whole file into a
memory-only blob URL for main's `MediaVideoPlayer`. Because that read is not a cheap metadata
preload, inline videos show a play card and load only when pressed, with byte progress; a video
opened in main's gallery loads when the gallery opens. External web images and videos load directly
from their host as on main. Like main's desktop policy, the gateway CSP allows `https:`/`http:` in
`img-src`, `media-src`, and `connect-src`, plus `blob:`; `script-src` stays limited to the app.
Main's `MediaActions` menu copies paths and URLs and offers Save and Copy image. Coder has no signed
asset URL to re-request, so those byte actions read the media element's current source: the
memory-only blob for workspace media, or the web URL, which works when its host allows CORS.
Browsers may be unable to play some accepted containers, such as AVI; main's player then shows its
unavailable state with a download action.

The Files surface uses main's image, video, and audio previews through the same helper reads. Opening
the file is the explicit request, so it loads immediately. Images reread after a workspace mutation,
like main's revision suffix; video and audio keep the loaded copy until the file is reopened, because
a whole-file reread on every mutation would be expensive. PDF and HTML browser previews are not
ported. Outside-project access is limited to validated media previews; the text Files surface and
search retain project containment.

Remote uploads must first use a generated temporary filename and then be atomically renamed to
their final generated filename after successful transfer. Failed or incomplete transfers must be
removed. Image bytes, local paths, Coder credentials, and SCP configuration must not be logged.
Any temporary SSH configuration must contain no credentials and must be removed after the transfer.

Source-control UI restores upstream's Git action control and merge-request detail experience with a
GitLab-only provider registry. Repository status, fetch, pull, commit, push, repository publishing,
merge-request creation, and MR checkout all travel over the existing helper stdio RPC and execute
inside the Linux workspace. The helper uses repository-scoped Git commands and the
workspace-installed `glab` CLI to read MR summary, hover preview, activity, discussions, checks,
reviewers, and diffs and to perform actions permitted for the signed-in viewer. At helper startup, a replaceable,
state-free `glab` probe checks the workspace-wide GS write policy once for that helper lifetime. The
default sends an incomplete merge-request creation request to the impossible project ID `0` and
includes the response headers. A normal GitLab validation or not-found response with a
GitLab-specific response fingerprint proves
the request reached GitLab, while neither a project nor an MR can be changed. A generic proxy 404,
failed probe, or indeterminate response disables every GitLab mutation
while leaving reads, Git operations, and MR checkout available. The Source Control settings surface
shows the structured result and can explicitly rerun the probe. A later mutation that matches the
configured GS policy-block response immediately downgrades the cached workspace result. Generated
commit and MR content is
produced by the workspace Claude CLI using bounded Git summaries and patches; repository MR
templates are read from the committed base tree. The gateway never runs Git or `glab`, never
connects to GitLab, and receives no GitLab credentials. GitHub, Azure DevOps, Bitbucket, and other
hosted providers remain unavailable. In the Git action control, a failed write probe disables MR creation
with a reason, changed-file rows open the Files surface instead of a local editor, and
authentication hints point to `glab auth login` in the workspace.

The merge-request page, panel, stack menu, and right-panel tabs are upstream's, with these seams.
Diffs load through the `pullRequests.diff` stdio RPC rather than upstream's environment HTTP
loader, and upstream's GitHub account routing between environments is omitted. The label RPCs
exist but GitLab, like upstream's GitLab provider, does not advertise label editing, and native
stack actions are never advertised. List and detail snapshots that upstream keeps in browser
storage, the right-panel tabs, and the last merge method chosen stay in memory for the page
session; a project's default merge method is a workspace setting whose `null` means "last
selected". Links the panels open go to the system browser through the validated HTTP(S)
`shell.openExternal`, because Coder has no in-app preview. The panels use GitLab wording and `!`
references, play video uploads inline and link other uploads as on main, and resolve `/uploads/`
links against the repository host.

Settings use upstream's layout, sidebar navigation, search catalog, and scope picker with these
seams. The Integrations and SnapShot categories, desktop update and quit rows, the diagnostics row,
browser and hosted-pairing settings, and the `keybindings.json` editor do not exist; keybinding
changes are made in the table. Connections holds the Coder deployments, workspaces, workspace icon,
and TCP/UDP port forwards instead of upstream's pairing and network access. Providers uses upstream's provider panel and add-instance dialog,
limited to the Codex, Claude, and Pi drivers (any instance), without sign-in, provider setup or
managed install, per-instance environment variables, ACP registry, or usage-limit sources. Source Control appends GitLab
workspace status and the write-policy probe. Background activity uses upstream's profiles and Advanced
dialog, without the host power-monitor intervals or power and lock pauses, and profile
descriptions name their intervals. The last project grouping mode is remembered in memory for
the page session rather than in browser storage. Older fork settings links that name one checkout by its project settings
key resolve to that checkout's group.

Project icon choices use upstream's bounded Lucide names and color palette, or at most 32 characters
of emoji text. Choices persist on workspace-owned project records and travel through the existing
project metadata command/event stream over helper stdio. SQLite migration 047 adds the nullable
`project_icon_json` projection column; resetting a choice stores null. The browser renders bundled
vectors, emoji, or upstream's name-based monograms. No image-path lookup, transfer, or external fetch
is introduced.

## Fixed settings metadata

Settings parity uses two bounded metadata reads in the Linux helper. `projects.getConfig` accepts
only a project ID, resolves an active project through the projection query, and reads the fixed
`t3.json` file at its real root (at most 64 KiB). It returns only decoded script fields, checkout
mode, and worktree submodule mode, or a missing/invalid/unavailable status. The browser uses the
same read to show `t3.json` as a settings tier; new worktrees read the checkout's own `t3.json`
through the same bounded, symlink-checked reader. It accepts no caller path, returns no raw file, and
never logs parser input or file contents. Importing an action remains an explicit settings write.

Workspace themes come only from `<stateDir>/themes/*.json`. The helper examines at most 32 candidate
files, at most 32 KiB each and 192 KiB total accepted source bytes. Reads reject symlinks, non-regular
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
  whose loaders use helper stdio rather than HTTP. `ws.ts` follows upstream's handler and helper
  order, using `CoderWsRpcGroup.toLayer` over the gateway's stdio bridge. Bootstrap preparation,
  setup activities, cancellation, archive cleanup, clone identity refresh, MR sync-key resolution,
  and `server:` command IDs follow upstream, including its behavior of preserving a worktree
  after a non-cancel bootstrap failure. Reapply only these differences, each marked `Coder:` in
  code (see [Runtime boundary](#runtime-boundary)):
  - No HTTP/WebSocket listener, auth/session scopes, pairing, relay, client-origin attribution,
    analytics, RPC metrics, or trace export. The helper's RPC server uses upstream's
    `WS_RPC_SERVER_OPTIONS`, so a handler defect fails only its own request rather than every
    request on the stdio connection, and `observability/DefectReporter.ts` logs those defects to
    the helper's stderr. `CoderRuntimeStartup` completes before the RPC
    layer is built, replacing upstream's startup command queue. Lifecycle welcome/ready events
    are synthesized from workspace projections rather than a startup publisher.
  - Config comes from the Coder environment descriptor and omits auth, editors, device hosts,
    remote open targets, telemetry, model-manifest refreshes, and usage-limit sources. A failed
    keybinding-config load falls back to defaults instead of failing the config read. Config updates use upstream's full `providerStatuses` events and gated
    environment themes; subscriptions do not force a provider refresh.
  - Shell/thread streams, replay validation, live-event budgets and coalescing, and completion-marker
    negotiation follow upstream. `coderEnvironment.ts` advertises upstream's environment
    capabilities and orchestration protocol version except the cut surfaces listed with a reason
    in `CODER_OMITTED_CAPABILITIES` (usage dashboards, server self-update, desktop app update,
    relay activity publishing, server browser, and native stack actions). `coderEnvironment.test.ts`
    fails when a key of `ExecutionEnvironmentCapabilities` is in neither list, so a sync that adds
    a capability must decide it. The worktree-location setting describes a workspace path. Coder replaces HTTP thread snapshot
    loading with `orchestration.getThreadSnapshot` over stdio. Initial snapshots and older pages
    retain `targetBytes` budgeting and the newest requested turn. Shell and thread snapshots
    that exceed the stdio frame bound fail before transport encoding. Shell snapshot loading
    uses upstream's socket fallback because no HTTP shell loader exists.
  - GitLab uses the workspace's `glab` login without upstream's viewer routing credentials.
    Thread MR links must belong to a known GitLab host.
  - Files listings, reads, writes, content search, and media reads verify the requesting thread's
    project root; Files listings, reads, writes, and media reads from a draft verify its named
    project's root or a worktree one of that project's threads owns (`draftProjectId`). `workspace/WorkspaceFileSystem.ts`, `WorkspaceEntries.ts`, and
    `WorkspaceSearchIndex.ts` implement the Files surface and file-search boundaries above in place
    of upstream's absolute-path reads, create-anywhere writes, and `searchContents`;
    `ProjectImages.ts` and `ScreenshotArtifacts.ts` are Coder-only. Path-only FFF errors and stale-write errors retain the fork's bounded-service
    error mapping.
  - Coder-only methods remain beside their upstream neighbors: local ref status, managed
    branch/worktree rename with `moveWorktree`, write-access probing, chunked review files,
    bounded text/content/media and legacy-artifact reads, fixed project-config reads, workspace
    directory listing, and merge-request diffs. The method set stays `CoderWsRpcGroup`;
    unsupported upstream methods stay omitted.
- **Provider and orchestration.** Upstream's orchestrator (`orchestration-v2/`: the orchestrator,
  effect worker, projection store, provider session manager, `ClaudeAdapterV2.ts`,
  `CodexAdapterV2.ts`, thread intake and launch, and attachment claims) runs in the helper with
  its `statev2.sqlite` database, with these Coder deltas. Reapply them to whatever replaces those
  files:
  - Claude runs through `Drivers/ClaudeCli.ts`, which implements the Agent SDK's `query()` and
    `Query` surface over the workspace `claude` executable. Rollback and resume use upstream's
    native `resumeSessionAt` from the conversation head, which the CLI accepts directly.
  - `Drivers/ClaudeAgentSdk.ts` provides SDK-typed `query` and `getSubagentMessages` over the CLI,
    so upstream code that calls the SDK changes only its import source. Options the CLI transport
    cannot honour fail instead of being dropped, except `mcpServers`, which is always replaced by
    the empty strict configuration. It has no `forkSession`: `ClaudeAdapterV2.forkThread`
    allocates the fork's session id and stores the source session and message boundary as the
    provider thread's `claudeFork` native metadata. The fork's first query then runs
    `--resume <source> --fork-session --resume-session-at <message> --session-id <new>` rather
    than copying transcript files.
  - Workspace MCP servers, Codex app integrations, and Codex MCP elicitations follow upstream.
    T3's own MCP server is absent; upstream's T3 toolkits reach agents over the workspace file
    bridge instead (see [Runtime boundary](#runtime-boundary)):
    - `mcp/McpSessionRegistry.ts` keeps upstream's shape and lifecycle, but each credential is a
      bridge (`mcp/bridge/FileBridge.ts`) whose `toolCommand` (a Coder field on provider-core's
      `McpProviderSessionConfig`) runs the tools; `endpoint` is the bridge directory. Upstream's
      tools act only for a caller that owns a live run, as over MCP.
    - `mcp/bridge/T3ToolBridge.ts` runs upstream's toolkit handlers by name with the credential's
      `McpInvocationContext`, enforces read-only tools in plan mode, and turns calls that outlive
      8 seconds into `bridge-job:` tasks. `server.ts` binds it once the orchestrator runs.
    - `toolkits/pullRequests/handlers.ts` rejects merge requests outside the workspace's GitLab
      hosts. `toolkits/environment/` reads the `CoderEnvironment` descriptor in place of
      upstream's `ServerEnvironment`.
    - `mcp/bridge/T3ToolInstructions.ts` reuses upstream's orchestration guidance without its MCP
      and ACP transport paragraphs; its test fails if upstream rewords them.
    - `CodexAdapterV2.ts` configures no `mcp_servers`, attaches T3 context only when the bridge
      exists, and never advertises preview or device tools; `CodexDeveloperInstructions.ts` and
      `ClaudeAdapterV2.ts` describe the bridge command (`mcp/bridge/T3ToolInstructions.ts`) in
      place of upstream's MCP orchestration text. Claude pre-approves the command as a Bash
      prefix, limited to read-only tools in a read-only sandbox, as upstream pre-approves its MCP
      tools. provider-core's `runtimeInstructions.ts` keeps upstream's `link_pull_request` block,
      worded for T3 tools.
    - Preview, device, and attachment-upload toolkits are not carried.
  - Provider input reads images only through `PastedImageAttachments.ts`: native `localImage`
    paths for Codex and base64 blocks for Claude. Read-tool image views are limited to PNG, JPEG,
    and WebP. Tool-result image bytes follow upstream: `stripUnservedToolOutputImageBytes` keeps
    only the images a tool output serves (at most 8, each within the provider image limit) and
    drops the rest.
  - `AttachmentClaims.ts` claims staged uploads as described in
    [Network and transfer constraints](#network-and-transfer-constraints): it reads each staged
    file once through a no-follow handle at exactly its declared size and type limit, rejects
    images whose signature does not match their media type, and writes the validated bytes
    exclusively with mode `0600`. Deleting or reverting a thread never deletes its attachments,
    so upstream's attachment-cleanup side effects are absent.
  - `provider/builtInDrivers.ts` registers only Codex, Claude, and Pi (upstream's
    `@t3tools/provider-pi` package), and `ProviderOrchestrationAdapterInfrastructure.ts` provides
    only the Claude query runner and the Codex app-server factory. Only shipped providers have
    replay harnesses. Pi keeps upstream's T3 extension for its permission hook (Supervised and
    Auto-accept edits), skill chips, and T3 tools. The extension speaks MCP over HTTP upstream;
    here `buildPiRpcLaunch` hands it the file bridge instead (`T3_TOOL_COMMAND` and
    `T3_TOOL_CATALOG`), and it registers the bridge catalog's tools under upstream's names,
    running each call through the bridge command with its arguments on stdin. The generated
    extension source (`mcpExtensionSource.ts`) keeps upstream's HTTP MCP client beside the bridge
    path, to stay close to upstream. It is dormant: every Coder MCP session carries a bridge
    `toolCommand`, so `buildPiRpcLaunch` never sets `T3_MCP_URL` and the extension opens no HTTP
    connection. Upstream's other provider packages
    (Cursor, OpenCode, Muse, ACP, ACP Registry, Grok, Antigravity) are not carried. Their replay
    fixtures (`orchestration-v2/testkit/fixtures/{grok_*,muse_*,opencode*,acp_elicitation}`) and
    `testkit/DormantProviderCapabilities.ts` are kept on purpose: orchestrator tests replay them
    to exercise those capability combinations, and no driver for them is registered.
  - Thread-title and branch-name generation use only Codex, Claude, or Pi models (Pi through
    upstream's ephemeral `pi --mode rpc --no-session` process). Text generation is
    upstream's except that Codex reads branch-name and title images through
    `PastedImageAttachments.ts`, skipping an unreadable image as upstream does.
  - The helper serves upstream's agent-session scan and import RPCs, scanning only the workspace's
    own Codex and Claude session stores. `server.ts` provides the scanner beside the helper RPC
    layer, as upstream does beside its WebSocket layer. The browser does not offer the import yet.
  - `ProviderAuthService` reports every sign-in, logout, and credential-transfer operation
    unavailable; providers authenticate through the workspace's API configuration.
    `CodexManagedRuntime` keeps only upstream's resolution contract.
  - Provider drivers, snapshots, and the registry are upstream's. Coder deltas: `CodexDriver`
    offers no T3-managed Codex install (`setupMode: "managed"`), and neither driver redeems
    rate-limit reset credits. `ModelManifest.layerBundled` serves the bundled manifest without
    upstream's hourly fetch or disk cache. Both providers attach
    per-model `supportedRuntimeModes` from workspace policy: Claude's effective
    `disableAutoMode`/`disableBypassPermissionsMode` settings (read through `ClaudeCli`, failing
    closed) and Codex's `configRequirements/read`. The Claude signed-out message names API
    credentials rather than subscription login. Claude's usage read asks the CLI to skip its local
    transcript scan (`ClaudeCli.getUsage({ skipBehaviors })`), as upstream's SDK call does.
    provider-core's `maintenanceResolver.ts` and `providerStatusCache.ts` log the first cause tag
    in place of the omitted observability helper. `ProviderHostLive` gives drivers no credential
    store: reads find nothing and writes fail.
  - Absent: client-origin attribution, orchestration and provider metrics, turn analytics, NDJSON
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
  permission. The host neither declares nor serves `ui/download-file`, and the frame has no save
  action. Upstream frames the captured document through a signed asset URL. Here
  `workspace.readTurnItemAsset` reads it in bounded chunks, but only the document that the named
  stored tool item references, opened without following symlinks. The frame then loads the
  gateway's `/mcp-app-frame.html` shell, and the page posts the document to it. The shell checks
  that the message came from its parent and writes the document over itself.
  A blob, `srcdoc`, or `data:` frame would inherit the page's Content-Security-Policy and block the
  app's scripts. The shell's own policy is `sandbox allow-scripts allow-forms; frame-ancestors
'self'`, so the shell and the app keep an opaque origin even when the shell is opened directly.
  The app's CSP comes with its stored document, as upstream injects it. The page policy allows
  `frame-src 'self'`, and every other gateway response keeps `frame-ancestors 'none'`. The shell's
  load and the written document's load both count as the app's own; a third load means the app
  navigated away.
- **Tool output images.** `turnItemOutputImages` lists a fetched item's images as upstream does.
  The inspector reads each image by index from the stored item through `workspace.readTurnItemAsset`
  into the shared bounded image store, in place of upstream's signed `tool-output-image` asset
  URL.
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
    upload, and HTTP content search) and adds the helper-only methods and `CoderWsRpcGroup`, the
    only group the helper serves. That group carries upstream's thread find
    (`searchThread`, `searchThreadStream`), turn-item reads, passive terminal observation, agent
    secret answers, storage cleanup runs and reports, and the MCP Apps methods. Upstream's `EnvironmentAuthorizationError` stays in
    error unions but is never emitted.
  - `ServerConfig` omits auth, editors, remote open targets, and observability.
  - `ModelCapabilities` carries the provider-reported `supportedRuntimeModes`; custom models use
    `CustomModelCapabilities`, which cannot declare them.
  - Tool items keep legacy screenshot `artifacts`; rate-limit events carry the raw payload.
  - Terminal attach input adds `afterSequence`, and the attach stream adds a `resumed` event.
  - Claude launch args reach the workspace CLI except the stream-json transport flags. `ClaudeAgentSdk.ts` passes
    `mcpServers` and `strictMcpConfig` as the SDK does and rejects in-process (`sdk`) MCP servers,
    which the CLI transport cannot host.
  - The web provider list and client-runtime `state/server.ts` stay limited to the methods the
    helper serves and to Codex, Claude, and Pi driver instances (`isCoderProviderDriver`).
  - Client settings add `providerPreferencesByEnvironment`, which keeps favorites and model
    order per workspace (see [Persistence](#upstream-seams)).
- **Terminals.** `terminal/Manager.ts` is upstream's. Coder deltas: it records each terminal's
  attach events in a bounded replay window (512 KiB per terminal, 64 MiB in total) and answers an
  attach with `afterSequence` by replaying the missed events and a `resumed` event instead of a
  snapshot when the window still covers the gap. Terminals poll the process table themselves
  (no resource telemetry), register no ports for preview discovery, record no metrics, and get
  no managed ACP install directories on `PATH`. In the browser, the terminal session state, output model,
  drawer, and UI state store are upstream's; client-runtime adds `TerminalBufferCache`, a bounded
  in-memory cache that seeds a reattach and supplies its `afterSequence`, and tracks the last
  applied sequence. `ThreadTerminalDrawer` never opens terminal links (there is no editor or
  preview surface).
- **Command palette.** `CommandPalette.tsx` is upstream's, including its add-project browse,
  clone, and new-project flows over `filesystem.browse` and the clone RPCs. Coder deltas (marked
  `Coder:`): the active workspace stands in for upstream's primary environment and supplies
  keybindings; every workspace is remote; Add project always shows the workspace picker, which
  also lists each domain's unconnected workspaces and connects the chosen one; there is no desktop or WSL folder picker, browser
  preview, or usage page; GitLab is the only hosted clone source; non-GitLab hosts use a generic
  icon; review actions say merge request; and new projects publish only to GitLab, when discovery
  reports authenticated, writable access. Clone URLs are validated by the helper.
- **Composer, timeline, and work log.** Upstream's context records, upload queue, chips, and
  work-log module (`client-runtime/work-log/toolPresentation.ts`), minus preview annotations,
  element captures, SnapShot, upstream's large-paste-to-file folding, remote icons, and in-browser
  previews of draft file and video attachments. A context fragment pasted from another workspace
  brings only its PNG, JPEG, and WebP images, read through the helper's bounded attachment chunks. Images
  and files move through the gateway and SCP (see
  [Network and transfer constraints](#network-and-transfer-constraints)); `ChatView` gates them on
  the helper's advertised attachment capabilities, as upstream does. Upstream's `useAssetUrls` is replaced by `assets/assetUrls.ts`, which reads
  submitted images by id through the helper (`AttachmentImageResource` carries the media type
  and size the read verifies). Reads start only once the workspace is connected, because cached
  threads render before the helper is reachable. Rewind re-stages a message's images through the
  same reads.
  Sent file attachments render as static rows without preview, download, or open actions, and
  native app icons fall back to the tool glyph.
  Upstream's v1 importer carries only messages, so screenshots that pre-v2 conversations saved
  as `artifacts` on v1 tool activities have no v2 item. The v2 database starts as a copy of the
  v1 one, so `orchestration-v2/legacy/LegacyScreenshotArtifacts.ts` reads them from the kept v1
  `projection_thread_activities` rows, only for imported threads, and returns those recorded
  between an imported message and the next (`workspace.listLegacyScreenshotArtifacts`, at most
  100). The timeline's `LegacyScreenshotArtifactsTimelineRow` renders them after messages without
  a run, through the bounded legacy chunk read. Nothing is written, so already-migrated
  workspaces need no backfill.
- **Project actions.** The thread details panel, action editor, and Settings → Actions are
  upstream's. Coder deltas: repository actions come from the helper's validated `t3.json` read by
  project (`projects.getConfig`), which drops `iconPath` and script preview fields; the editor has
  no preview URL; and, as upstream's browser build, action keybindings are saved only on desktop.
- **Right panel and composer chrome.** `RightPanelTabs.tsx` is upstream's tab strip and
  `PreviewPanelShell` layout without browser, device, and preview surfaces: no launcher rows,
  favicons, browser profiles, audio controls, or device rename. Never-opened preview and device
  surfaces in the store get a plain title and icon. Merge-request rows, tabs, and disabled reasons
  use GitLab wording and `!` references. The branch toolbar is upstream's; workspace options are never primary and use
  the server's machine kind, and the branch notice also covers a managed worktree whose branch
  moved (`resolveCheckoutBranchMismatch`). The branch picker adds "Rename current branch…" for a
  thread's own branch (`vcs.renameThreadBranch`), which can also rename the T3 worktree folder
  through the driver's `moveWorktree`. Proposed-plan cards offer Copy but no Download or Save
  to workspace (no exports, and Files edits only existing files). The provider-update launch notification uses the active workspace as upstream's primary
  environment and has no per-backend (WSL) split. There is no default-theme adoption, which follows
  upstream's `t3 theme set` CLI.
- **App sidebar.** The layout, header, footer, and provider-update pill are upstream's. Coder
  deltas: there is no legacy sidebar (or its Settings switch), usage page, desktop app-update
  pills, desktop window bridge (fullscreen insets and menu actions), or preview keybinding
  context; the active workspace supplies keybindings and the pill's providers.
- **Chat view.** `ChatView.tsx` is upstream's, minus the browser and device preview panels and
  mini-player, automatic machine placement, server self-update and version-skew banners,
  usage-limit panel, Codex feedback upload, local editors (`OpenInPicker`), sidebar file drops, and the favicon store.
  The active workspace stands in for upstream's primary environment, and drafts read their
  route workspace's config. The Files surface opens for drafts as on main; a draft's Files
  requests name its project so the helper can verify the root. The checkout branch notice also covers a
  worktree whose branch moved, but only a local checkout can be restored or follow the current
  branch on send. `chatCanvasLayout.ts` has no preview obstacles, and the right panel keeps
  Coder's per-thread width storage instead of upstream's preview inline size.
- **Markdown.** `ChatMarkdown.tsx` is upstream's, with these differences (each marked `Coder:` in
  the file):
  - Workspace media has no signed asset URL. `ChatMarkdownAssetImage` keeps upstream's props
    (minus `fallbackSrc`) but reads images through the shared helper-backed image store and shows
    videos as a play card that reads the file when pressed. It needs the thread root (`cwd`), which
    the helper verifies. Images in formats the helper does not read show "Unsupported image
    format" without a read, and authored `id`s stay on workspace images.
  - The gallery item (`ExpandedImagePreview.tsx`) is upstream's shape plus `projectImage`,
    `projectVideo`, legacy `artifact`, `loading`, and `retry`. `resolveMarkdownMediaPreview`
    returns helper sources rather than asset URLs. The dialog reads the selected image with
    priority, the gallery also collects `[data-project-image]` wrappers so unloaded images stay
    navigable, and byte actions use the blob the dialog shows. Timeline galleries are hosted by
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
  (a workspace mutation rereads an open image, but video and audio reread only on retry or
  reopen because each read moves the whole file); a draft names its project rather than a thread;
  there is no PDF or HTML browser preview, open-in-editor or reveal action, attachment preview,
  drag-to-composer mention, or Copy mention (the tree's only clipboard action is Copy path).
  `env.ts` reports `isElectron = false` for upstream's desktop branches.
- **Merge requests.** Upstream's page, panel, stack menu, and right-panel tabs, GitLab-only. Diffs
  come over the `pullRequests.diff` RPC, snapshots and merge-method choices stay in memory, and
  `!` references and GitLab wording are used. Actor avatars load as on main. MR links everywhere
  (Markdown, the sidebar, composer and timeline chips, and the thread MR panel) open through
  upstream's `lib/openPullRequestLink.ts`. Its `parseChangeRequestUrl` narrows the shared parser to
  `/-/merge_requests/` URLs, and project matching skips checkouts whose provider is neither GitLab
  nor unknown. `gitLabMergeRequestBrowserUrl` replaces upstream's GitHub fallback URL and keeps a
  self-hosted install's origin and path prefix. A plain click opens the panel or page, and a
  modifier click or an MR no workspace project can read goes to the system browser. In Markdown
  they are upstream's new-tab anchors with hover previews. The merge requests page resolves a link
  against every workspace that reads merge requests, the primary first. Right-clicking a web link shows upstream's menu (system browser, Copy Link, and
  Link/Unlink to thread through `usePullRequestLinking`). GitLab autolinks keep their
  `merge-request`, `issue`, and `commit` kinds, so upstream's GitHub reference confirmation is
  unused.
  - User-facing text says "merge request", "MR", and `!123` wherever upstream says "pull
    request", "PR", or `#123`: the panels, composer, settings, toasts, keybinding labels, and
    the strings the web shows from `client-runtime` (work-log tool labels and MR actions) and
    `shared` (T3 tool presentation, watch descriptions, and copy-link toasts). Identifiers, wire
    names, and search haystacks keep upstream's spelling, and the composer trigger stays `#`.
    Web `sourceControlPresentation.ts` treats a missing provider as GitLab rather than
    upstream's GitHub default. Text for paths GitLab never reaches (native stacks, stack merges,
    `PullRequestsUnavailableState`'s GitHub link, GitHub-only setting rows) is upstream's. These
    pure wording substitutions are not marked line by line; every other difference is.
- **Source control and merge-request services.** `sourceControl/`, `pullRequest/`, and upstream's
  `@t3tools/source-control-core`, `-gitlab`, and `-testing` packages are upstream's, GitLab-only.
  Upstream's GitHub, Azure DevOps, Bitbucket, and Forgejo packages are not carried. Coder deltas,
  each marked `Coder:`:
  - `sourceControl/builtInDrivers.ts` lists and provides only the GitLab driver, so both
    registries iterate GitLab alone. `SourceControlHost` passes the fork's `classifyNonZeroExit`
    through to `VcsProcess`, which GitLab uses to report a policy-blocked write.
  - `GitLabWriteProbe` (in the GitLab package) gates every host write (`GitLabCli.executeWrite`,
    repository and merge-request creation, merge-request mutations); discovery reports its
    `writeAccess`, and while writes are blocked the merge-request detail and viewer permissions
    become read-only.
  - GitLab implements upstream's optional hover-preview, summary (batched through aliased GraphQL
    reads), and diff-file-contents reads, which upstream implements only for GitHub. Diff output
    is capped at 6 MiB to fit the gateway's 8 MiB message ceiling.
  - GitLab fixes for bugs still in upstream's `GitLabCli` (checked against upstream `main`
    b6aa268b12):
    merge requests between projects post to the source project with a numeric
    `target_project_id` instead of sending the repository text as `source_project_id`; merge
    request URLs reach `glab` as `<iid> --repo <url>` because older versions read URLs as branch
    names; `mr checkout` honours `branch` and `force`.
  - GitLab implements upstream's `readChangeRequestTemplate` hook with
    `gitLabChangeRequestTemplate.ts`, upstream's GitHub template reader plus
    `.gitlab/merge_request_templates`, preferring `Default.md`.
    `glab auth status` lines carrying a token label or a `glpat-` token are never surfaced. Clones
    accept only GitLab URLs without credentials, query, or fragment, and pass `--` before the URL.
  - `PullRequestService` omits upstream's cross-environment routing (routing identities,
    verified credentials, `expectedAccountId` and `allowStale` refs) and Forgejo SSH-alias
    refinement.
- **Provider drivers.** provider-core's `ProviderDriver.usage` is `never` and its `usage.ts`
  is not carried: there is no usage page, so Claude and Codex register no usage readers and
  `provider/builtInDrivers.ts` has no usage driver list.
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
  - `VcsProcess` has no GitHub CLI semaphore, classifies only `glab` failures, and keeps the
    `classifyNonZeroExit` hook used by the GitLab write probe.
  - `GitManager` probes the resolved provider's write access before any stacked action that
    creates a merge request, so a blocked workspace, or a remote that resolves to no registered
    provider, commits and pushes nothing. It also reads merge-request
    templates for GitLab and fetches merge-request heads from `refs/merge-requests/<n>/head`.
    Upstream's GitHub and Forgejo branches stay verbatim but are unreachable with the GitLab-only
    registry.
  - `GitWorkflowService` adds `moveWorktree` and `localRefStatus` pass-throughs.
  - `VcsStatusBroadcaster` adds `streamRefStatus` for `subscribeVcsRefStatus` and resolves
    auto-pull with `resolveProjectAutoPull`. Its `BackgroundPolicy` dependency is a
    Coder-owned stub that always allows work, because polling already stops when the last
    status subscription ends. `ws.ts` resolves the remote refresh interval from the background-activity profile as upstream does.
  - Startup auto-pull (`vcs/projectAutoPull.ts`) is upstream's `autoPullProjects` from
    `serverRuntimeStartup.ts`, with the same per-project enablement.
- **Settings.** Upstream's layout, navigation, and search, with Coder's Connections, Providers,
  GitLab, and background-activity panels. No Integrations, SnapShot, desktop, diagnostics,
  pairing, external agent-session imports, or `keybindings.json` editor.
- **Scheduled tasks.** Settings → Scheduled tasks and its draft logic are upstream's, including
  interval and fixed-time schedules, run-now, and webhook draft round-tripping. T3 Coder serves no
  inbound webhook route, so the editor has no "On webhook" option, URL field, token rotation, or
  signature and age-limit fields, and rows have no Deliveries dialog or "Listening" status.
  Webhook tasks created another way (for example, through the agent `schedule_task` tool) keep
  their stored schedule when edited, but they never run and do not offer Run now.
- **Migrations.** `persistence/Migrations.ts` is upstream's registry with the same IDs. Upstream's
  auth migrations (20–22, 31, 32, and 41) keep their IDs but create nothing. Databases created
  before the fork adopted upstream's IDs recorded a renumbered registry (IDs 41–58, with the
  Coder-only `CoderLegacy/` migrations 050 and 055). `CoderMigrationHistory.ts` finishes that
  registry, whose final schema matches upstream ID 54, and rewrites the history to upstream's IDs
  before upstream's migrator runs. A V2 preview ledger is reconciled before that rewrite, because
  the Coder legacy registry never recorded `OrchestrationV2`. New migrations take upstream's next ID; never add a Coder-only
  migration ID.
- **Persistence.** Merge-request snapshots, right-panel tabs, diff-panel selections, closed-view
  history, the last merge method, and the last project grouping mode stay in memory where
  upstream uses browser storage. Model favorites and model order are kept per workspace
  (`providerPreferencesByEnvironment`), falling back to the global lists until a workspace has its
  own; the pickers and the Providers settings page read and write the workspace's lists. `storage.ts` keeps
  upstream's IndexedDB environment cache without the connection catalog, credentials, GitHub
  routing permissions, or project favicons. The upstream idle thread-snapshot retention lifecycle
  keeps Coder's 24-thread / 64 MiB cap. Composer drafts and the prompt stash keep text in browser
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
  header's copy button and the context menu copy only the project-relative path.
- **Diff renderer patch.** `patches/@pierre%2Fdiffs@1.5.2.patch` is upstream's patch plus a guard
  that ignores loaded file contents unless the current diff is still the partial diff that asked
  for them.
- **Browser shell and connections.** Each marked `Coder:`:
  - `connection/platform.ts` registers only the configured Coder workspaces, reached through the
    loopback gateway; removing a workspace from the Coder config clears its drafts and caches.
    client-runtime's `connection/driver.ts`, `connection/index.ts`, `connection/wakeups.ts`, and
    `platform/persistence.ts` drop upstream's multi-route checks, credential and profile stores,
    saved targets, onboarding, GitHub routing, host updates, and the mobile `network-changed`
    wakeup. `state/shell.ts` treats every workspace as remote (no primary local target).
  - `lib/runtime.ts` has no primary-environment HTTP client, relay, DPoP, or tracer, and
    `branding.ts` fixes the "T3 Coder" name without a desktop bridge or hosted channel.
  - Upstream's desktop IPC contract (`contracts/ipc.ts`) is not carried; `localApiTypes.ts` keeps
    its context-menu and confirm-dialog types, and `localApi.ts` opens only HTTP(S) links.
  - client-runtime `errors/diagnostics.ts` is the `[t3-error]` DevTools reporting described in
    [Authentication](#authentication).
  - The server's `config.ts` is paths under the workspace state directory only.
  - A thread whose workspace is not connected shows `WorkspaceConnectionStatus`; the
    `/projects/$projectKey` redirect has no auth gate.
  - Merge-request list preferences remember presentation controls only, never repository
    identities or search text. Dropped folders are not uploaded (only files become composer
    attachments). Custom themes have no Export (download) action. Project icons come from saved
    metadata or monograms, without favicon reads. The worktree setup card says "Use project
    checkout", because the checkout is in the workspace.
- **Codex app-server package.** `packages/effect-codex-app-server` is upstream's, including
  `scripts/generate.ts`, which regenerates `_generated/*` byte-for-byte. Coder deltas (marked
  `Coder:`): a spawned Codex child may print up to 16 KiB of non-JSON lines before its first
  protocol message, because managed workspace wrappers can emit a banner first; and the `probe`
  script and its example are not carried, because they launch a local Codex.
- **Build tooling.** `scripts/lib/third-party-licenses.ts` never fetches during a build: SPDX
  texts are committed under `licenses/spdx`, and only `pnpm licenses:sync` downloads missing
  ones. `knip.jsonc` lists the upstream files whose exports are used only by surfaces the fork
  does not carry, so `pnpm knip:check` still catches fork-introduced dead exports elsewhere.
  `scripts/coder-live-test.mjs` and `scripts/coder-live-template/` run the real-Coder live
  harness on macOS with Colima.
- **Omitted surfaces.** Desktop, mobile, hosted web, browser preview, telemetry, OTLP and trace
  export, the diagnostics page, usage dashboards, and hosted providers other than GitLab. Without
  browser preview, `composerDraftStore.ts` does not keep an empty draft alive for an open page,
  and the desktop default-browser handoff (`DesktopWebLinkCoordinator`) is not carried.

## Distribution

`npm start` builds the web client and a Linux x86-64 helper bundle from the checked-out source and
lockfile, including the locked native runtime packages needed by terminals and workspace search,
then starts the local gateway without opening a browser. Connecting never installs from npm or
downloads an application update. The first connection may download the pinned Node.js package
through Nix if it is not already in the workspace's Nix store. The gateway hashes the locally
built helper bundle (SHA-256 over its relative paths and contents) once per session and passes the
hash to the helper launch, which compares it with the `.t3-bundle-sha256` file in the installed
helper directory. When they differ, the launch prints `T3_CODER_HELPER_INSTALL_REQUIRED` and exits
before starting the helper; the gateway then replaces the remote helper directory with the local
bundle through helper-scoped SCP, records the hash, and launches again. A workspace whose helper
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
- `server.ts` builds `StorageCleanup.layer` after `CoderRuntimeStartup` completes, where upstream
  parks its sweeps until server activation.
- The report calls artifact rows "saved image artifacts".
