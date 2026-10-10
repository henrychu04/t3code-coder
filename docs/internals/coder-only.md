# How T3 Coder keeps work in Coder

> This is a maintainer and reviewer reference. For the user-facing explanation, start with
> [Coder workspaces](../user/workspaces.md) and [Product decisions and upstream
> differences](../product-differences.md).
> To merge upstream, follow the [upstream sync checklist](sync.md).

T3 Coder runs its browser interface on the developer's computer while repository, Codex, Claude,
Pi, terminal, checkpoint, and durable orchestration work stays inside Linux Coder workspaces. The
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

Agents reach upstream's T3 toolkits over a workspace file bridge instead of MCP. Each provider
session credential from upstream's `McpSessionRegistry` is a private temporary directory holding a
standalone CLI (run with the helper's pinned Node runtime) and a read-only tool catalog; no socket,
listener, or MCP server is opened. The CLI writes one request per call into its own call directory,
and the helper runs the named tool through upstream's toolkit handlers with the credential's
thread identity, never one the agent supplies. Plan-mode threads may call only tools upstream marks
read-only. Requests and responses are bounded (`FileBridge.ts`). A call that outlives the inline
budget answers with a `bridge-job:` task id that `task_status` resolves, so long tools never depend
on a provider's shell timeout; the number of such calls per thread and the retention of unread
results are bounded (`T3ToolBridge.ts`). Upstream's lifecycle owns the bridges: credentials are reused across turns and
revoked, which deletes the directory, when the session is released, the thread is archived or
deleted, or the helper stops. If a bridge cannot be created, turns run without T3 tools. Workspace
processes run as the same OS user; these directories are not an isolation boundary between mutually
untrusted agents.

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
Pi uses its RPC mode (`pi --mode rpc`) over stdin/stdout.
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

Development is supported on macOS. The production local host is Windows 11, so local paths and
processes must use Node platform APIs and argument-array spawning with `shell: false`; no OpenSSH
client is needed. The initial
workspace target is Linux x86-64. The helper launch is one foreground `coder ssh` session that
first runs the workspace preflight: it checks the remote OS and architecture, realizes a Node.js
24 package from the workspace's configured `nixpkgs` only when that runtime is not already
available, and checks Git, the transfer tools (`tar`, `sha256sum`, `head`), at least one of
Claude Code, Codex, or Pi, and the workspace state directory. A failed check prints a `T3_CODER_PREFLIGHT_FAILED:` line, which the gateway reports.
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
Claude, Pi, and user-initiated terminal commands remain subject to workspace policy.

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
(`@t3tools/shared/attachmentFileExtension`). The gateway streams the bytes from memory to
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
`message.context`) without preview annotations, element captures, or SnapShot frames. The work log
uses upstream's client-runtime presentation without provider tool sources, favicons, logos, or
native app icons.

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
artifact copies, capture budgets, or quotas exist; existing artifact ids stay readable through the
legacy chunk read.

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
in the workspace over helper RPC, using repository-scoped Git and the workspace `glab`. At helper
startup a replaceable, state-free `glab` probe checks the workspace-wide write policy once: it sends
an incomplete merge-request creation to the impossible project ID `0`, and only a GitLab-
fingerprinted validation or not-found response enables writes. A generic proxy 404, failed probe,
or indeterminate response disables every GitLab mutation while reads, Git, and checkout stay
available; Settings → Source Control shows the result and can rerun it, and a later mutation that
matches the configured policy-block response downgrades the cached result. Generated commit and MR
text comes from the workspace Claude CLI. The gateway never runs Git or `glab`, never connects to
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
  `CoderWsRpcGroup`. `server.ts` keeps upstream's declarations for the layers the helper uses and
  exports them at one hook to `coderServer.ts`, whose `makeCoderRuntimeLayer` composes the helper
  runtime: the Coder provider and orchestration layers, `CoderRuntimeStartup`, `StorageCleanup`,
  the T3 tool bridge binding, and the RPC layer. In `server.ts`, settings also provide the secret
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
    mutations run directly. Lifecycle welcome/ready events
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
  - GitLab uses the workspace's `glab` login without upstream's viewer routing credentials
    (`withPullRequestViewer` is an identity in `ws.ts`). Thread MR links must belong to a known
    GitLab host (`makeEnsureCoderPullRequestLink` in `coderWs.ts`).
  - Files listings, reads, writes, file creation, content search, and media reads verify the requesting thread's
    project root; Files listings, reads, writes, and media reads from a draft verify its named
    project's root or a worktree one of that project's threads owns (`draftProjectId`). `workspace/WorkspaceFileSystem.ts`, `WorkspaceEntries.ts`, and
    `WorkspaceSearchIndex.ts` implement the Files surface and file-search boundaries above in place
    of upstream's absolute-path reads, create-anywhere writes, and `searchContents`.
    `projects.createFile` serves upstream's proposed-plan "Save to workspace": it creates a new
    text file inside the verified root and never replaces an existing path, where upstream's
    `writeFile` overwrites. `ProjectImages.ts` and `ScreenshotArtifacts.ts` are Coder-only. Path-only FFF errors and stale-write errors retain the fork's bounded-service
    error mapping. `coderWs.ts` wraps `ws.ts`'s upstream Files list, read, and write handlers in
    the root verification, so those handlers stay upstream's code.
  - Coder-only methods live in `coderWs.ts` (`CODER_WS_METHODS`): local ref status, managed
    branch/worktree rename with `moveWorktree`, write-access probing, chunked review files,
    bounded text/content/media, sent-file (`workspace.readAttachmentFile`), and legacy-artifact
    reads, new-file creation (`projects.createFile`), fixed project-config reads, workspace
    directory listing, merge-request diffs, and upstream's HTTP bounded thread snapshot and
    history page over stdio. The method set stays `CoderWsRpcGroup`; unsupported upstream methods
    stay omitted.
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
    `setMaxThinkingTokens`, `getContextUsage`, `getSettings` (read directly by `ClaudeProvider.ts`),
    `getUsage`, `initializationResult`, and `close` as CLI control requests. `ClaudeAgentSdk.ts`
    maps them onto the SDK `Query` (`getUsage` serves its experimental usage method) and answers
    `supportedCommands`, `supportedModels`, `supportedAgents`, and `accountInfo` from the initialize
    response. Every other SDK `Query` method rejects with "not available through T3 Coder's CLI
    transport", and the shim is typed as the full SDK `Query`, so a method a new SDK adds fails
    typecheck until it is mapped or rejected.
  - `Drivers/ClaudeAgentSdk.ts` provides SDK-typed `query` and `getSubagentMessages` over the CLI,
    so upstream code that calls the SDK changes only its import source. Options the CLI transport
    cannot honour fail instead of being dropped, except `mcpServers`, which is always replaced by
    the empty strict configuration. `executableArgs` go before the CLI's own arguments, as the
    SDK passes them, so upstream's agent scope wrapper launches the CLI. It has no `forkSession`: `ClaudeAdapterV2.forkThread`
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
      its inline budget into `bridge-job:` tasks. `coderServer.ts` binds it once the orchestrator runs.
    - `toolkits/pullRequests/handlers.ts` rejects merge requests outside the workspace's GitLab
      hosts. `toolkits/environment/` reads the `CoderEnvironment` descriptor in place of
      upstream's `ServerEnvironment`.
    - `mcp/bridge/T3ToolInstructions.ts` reuses upstream's orchestration guidance without its MCP
      and ACP transport paragraphs or its `html_preview` step; its test fails if upstream rewords
      them.
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
    only the bounded set of images a tool output serves and drops the rest.
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
  - Agent-session import follows upstream, scanning only the workspace's own Codex and Claude
    session stores through the helper. `coderServer.ts` provides the scanner beside the helper RPC
    layer, as upstream does beside its WebSocket layer. Upstream offers the import in its welcome
    wizard, which is not carried; `ImportAgentSessionsDialog.tsx` reuses that import step from
    **Settings → Providers → History** for the selected workspace.
  - `ProviderAuthService` reports every sign-in, logout, and credential-transfer operation
    unavailable; providers authenticate through the workspace's API configuration.
    `CodexManagedRuntime` keeps only upstream's resolution contract.
  - Provider drivers, snapshots, and the registry are upstream's. Coder deltas: `CodexDriver`
    offers no T3-managed Codex install (`setupMode: "managed"`), neither driver redeems
    rate-limit reset credits, and `ClaudeDriver` does not read the Claude organization id that
    keys upstream's usage accounts. `ModelManifest.layerBundled` serves the bundled manifest without
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
  permission. `ui/download-file` is upstream's: the user confirms, and the host page saves the
  embedded or linked bytes. Upstream frames the captured document through a signed asset URL. Here
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
- **HTML renders.** Upstream's `html_render` tool, `HtmlRender` service, and inline frame, with
  these Coder deltas (each marked `Coder:`):
  - The bridge carries `html_render` only. `htmlRender/HtmlRender.ts` keeps upstream's image
    inlining and storage but not `preview` or height measurement, because T3 Coder installs no
    headless browser; pages publish at the agent's height, the frame shrinks to a shorter page's
    reported height, and a page with its images inlined is capped at `MAX_TURN_ITEM_ASSET_BYTES`, the
    bounded turn-item read.
  - Over the bridge the call is a shell command, so `htmlRenderFromBridgeCommand` (shared
    `toolOutput.ts`) recognizes a completed `…/t3-tools-<id>/t3.mjs html_render` command whose
    output is the tool's JSON result. `WireProjection` keeps only that compact reference on the
    wire (other command output stays withheld), and the timeline shows the page there, as
    upstream shows a `dynamic_tool` render. Any command could print such output, so
    `workspace.readTurnItemAsset` (`html-render` asset) serves only a page stored in the item's own
    thread, opened without following symlinks.
  - `chat/HtmlRenderFrame.tsx` reads the page through that read and `files/BrowserDocumentFrame.tsx`
    writes it into the MCP App shell with the theme in the shell URL's fragment, as upstream's
    signed URL carries it. **Open full size** shows the in-memory page and its source in
    `AttachmentFilePreview`, whose Save writes those bytes.
  - Pages are kept like other attachments; deleting a thread does not delete them.
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
    secret answers, storage cleanup runs and reports, and the MCP Apps methods. Upstream's
    `WsRpcGroup` stays dormant, unreferenced, with the RPCs only it uses, and `knip.jsonc`
    ignores `rpc.ts`'s unused exports for it. Upstream's `EnvironmentAuthorizationError` stays in
    error unions but is never emitted.
  - `ServerConfig` omits auth, editors, remote open targets, and observability.
  - `VcsProcessExitFailureKind` adds `policy-blocked` for the GitLab write probe, and
    `VcsProcessExitError`'s not-found detail drops upstream's `gh`/`az` "Pull request" text.
    The rest of `vcs.ts` and `git.ts` keep upstream's shapes, plus the helper-only ref-status
    and thread-branch rename schemas.
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
  attach events in a bounded replay window (`DEFAULT_ATTACH_REPLAY_*` in `Manager.ts`) and answers an
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
  element captures, SnapShot, upstream's large-paste-to-file folding, and remote icons. Draft file
  and video attachments preview from their in-memory bytes as on main: files open in
  `files/AttachmentFilePreview.tsx` (upstream's viewer, with Save writing the in-memory bytes
  instead of a signed-URL download) and videos in the gallery. A draft restored after a reload has no bytes, so it has no
  preview. A context fragment pasted from another workspace
  brings only its PNG, JPEG, and WebP images, read through the helper's bounded attachment chunks. Images
  and files move through the gateway's Coder CLI transfer (see
  [Network and transfer constraints](#network-and-transfer-constraints)); `ChatView` gates them on
  the helper's advertised attachment capabilities, as upstream does. Upstream's `useAssetUrls` is replaced by `assets/assetUrls.ts`, which reads
  submitted images by id through the helper (`AttachmentImageResource` carries the media type
  and size the read verifies). Reads start only once the workspace is connected, because cached
  threads render before the helper is reachable. Rewind re-stages a message's images through the
  same reads.
  Sent file attachments keep upstream's preview and download actions; the helper reads them by
  id (`workspace.readAttachmentFile`, bounded by the composer file limit) into memory, and the
  right panel shows them in `files/SentAttachmentFilePreview.tsx` where upstream's
  `FilePreviewPanel` loads a signed URL. Native app icons fall back to the tool glyph.
  Upstream's v1 importer carries only messages, so screenshots that pre-v2 conversations saved
  as `artifacts` on v1 tool activities have no v2 item. The v2 database starts as a copy of the
  v1 one, so `orchestration-v2/legacy/LegacyScreenshotArtifacts.ts` reads them from the kept v1
  `projection_thread_activities` rows, only for imported threads, and returns those recorded
  between an imported message and the next (`workspace.listLegacyScreenshotArtifacts`, bounded by
  `MAX_LEGACY_SCREENSHOT_ARTIFACTS_PER_MESSAGE`). The timeline's `LegacyScreenshotArtifactsTimelineRow` renders them after messages without
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
  the server's machine kind, there is no "Auto balance" run target (upstream's load balancing is
  not carried), and the branch notice also covers a managed worktree whose branch
  moved (`resolveCheckoutBranchMismatch`). The branch picker adds "Rename current branch…" for a
  thread's own branch (`vcs.renameThreadBranch`), which can also rename the T3 worktree folder
  through the driver's `moveWorktree`. Proposed-plan cards are upstream's; Save to workspace uses
  `projects.createFile`, so it fails on an existing path. The provider-update launch notification uses the active workspace as upstream's primary
  environment and has no per-backend (WSL) split. There is no default-theme adoption, which follows
  upstream's `t3 theme set` CLI.
- **App sidebar.** The layout, header, footer, and provider-update pill are upstream's. Coder
  deltas: there is no legacy sidebar (or its Settings switch), usage page, desktop app-update
  pills, desktop window bridge (fullscreen insets and menu actions), or preview keybinding
  context; the active workspace supplies keybindings and the pill's providers.
- **Chat view.** `ChatView.tsx` is upstream's, minus the browser and device preview panels and
  mini-player, automatic machine placement, server self-update and version-skew banners,
  usage-limit panel, Codex feedback upload, local editors (`OpenInPicker`), and the favicon store.
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
  PDF and HTML previews read through the same helper media chunks, project files only (see
  [Network and transfer constraints](#network-and-transfer-constraints)); there is no
  open-in-editor or reveal action, and the tree adds Copy path.
  `env.ts` reports `isElectron = false` for upstream's desktop branches.
- **Merge requests.** Upstream's page, panel, stack menu, and right-panel tabs, GitLab-only. Diffs
  come over the `pullRequests.diff` RPC without upstream's cross-environment GitHub routing,
  snapshots and the last merge method stay in memory (a project's default merge method is a
  workspace setting whose `null` means "last selected"), and `!` references and GitLab wording are
  used. Label RPCs exist but GitLab does not advertise label editing, and native stack actions are
  never advertised. Video uploads play inline, other uploads link as on main, and `/uploads/`
  links resolve against the repository host. Actor avatars load as on main. MR links everywhere
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
    `shared` (T3 tool presentation, watch descriptions, and copy-link toasts). The agent-facing
    text the server writes says "merge request", `!123`, and "T3 Coder" too: the merge-request
    watch wakes and their notification summaries (`pullRequestWatch.ts`,
    `PullRequestWatchReactor.ts`), the merge-request T3 tool descriptions and errors
    (`mcp/toolkits/pullRequests/tools.ts`, with GitLab example URLs), and `GitManager`'s
    merge-request ref fetch error. `runtimeInstructions.ts` stays upstream's. Identifiers, wire
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
    is capped (`DIFF_MAX_OUTPUT_BYTES`) to fit the gateway's `MAX_RPC_MESSAGE_BYTES` ceiling.
  - GitLab fixes for bugs still in upstream's `GitLabCli` (checked against upstream `main`
    dacd2cb649):
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
    verified credentials, `expectedAccountId` refs) and Forgejo SSH-alias refinement. It keeps
    `allowStale: false`, which the merge-request watcher uses to read past the held detail.
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
  pairing, or `keybindings.json` editor. Appearance's **Add theme** is upstream's
  `ThemeImportDialog` without its remote theme catalog search or desktop file picker: the browser
  reads picked, dropped, or pasted theme files itself. Connections holds the Coder deployments,
  workspaces, workspace icon, and TCP/UDP port forwards in place of pairing and network access.
  Providers is upstream's panel and add-instance dialog limited to Codex, Claude, and Pi drivers,
  without sign-in, setup or managed install, per-instance environment variables, ACP registry, or
  usage-limit sources. Source Control appends GitLab workspace status and the write-policy probe.
  Background activity uses upstream's profiles without host power-monitor intervals or power and
  lock pauses. Older fork links that name one checkout by its settings key resolve to its group.
- **Project icons.** Upstream's bounded Lucide names, palette, or emoji (`ProjectEmoji`), persisted
  on workspace project records through the project metadata command stream; migration 047 adds the
  nullable `project_icon_json` column. No image-path lookup or external fetch.
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
    attachments). Project icons come from saved
    metadata or monograms, without favicon reads. The worktree setup card says "Use project
    checkout", because the checkout is in the workspace.
- **Codex app-server package.** `packages/effect-codex-app-server` is upstream's, including
  `scripts/generate.ts`, which regenerates `_generated/*` byte-for-byte. Coder deltas (marked
  `Coder:`): a spawned Codex child may print a bounded preamble
  (`CHILD_PROCESS_STARTUP_PREAMBLE_MAX_BYTES`) of non-JSON lines before its first
  protocol message, because managed workspace wrappers can emit a banner first; and the `probe`
  script and its example are not carried, because they launch a local Codex.
- **Build tooling.** `scripts/lib/third-party-licenses.ts` never fetches during a build: SPDX
  texts are committed under `licenses/spdx`, and only `pnpm licenses:sync` downloads missing
  ones. `knip.jsonc` lists the upstream files whose exports are used only by surfaces the fork
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
  path, so its path checks pass on macOS, where the temp directory is behind the `/var` symlink.
  `orchestration-v2/ProjectionRecovery.test.ts` skips "selects unfinished recovery work without
  reading settled thread histories", which also fails on upstream; [sync.md](sync.md#7-verify)
  says when to retry it.
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
