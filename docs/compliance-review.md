# Security and data handling

T3 Coder is designed around a simple product promise: development work stays in the selected Coder
workspace, the browser interface stays local, and connections outside the computer remain owned by
Coder or the workspace provider.

Reviewers can expect:

- repositories, prompts, responses, sessions, terminals, checkpoints, and the application database
  to remain in the workspace;
- the local app to remember only non-secret Coder targets and explicit port-forward rules, while
  the browser keeps UI preferences and the text of unsent drafts and stashed prompts;
- Coder to own deployment authentication and provider CLIs to own provider authentication;
- no general upload, synchronization, or non-GitLab hosted source-control surface; MCP
  servers and app integrations are only those the workspace's provider configuration defines;
- workspace lifecycle and port-forward actions to remain explicit and visible to the user.

This document provides software-intake evidence for those product promises. It is not an assertion
that any employer has approved the software.

## How connections are used

| Source                | Destination                    | Mechanism                             | Purpose                                                |
| --------------------- | ------------------------------ | ------------------------------------- | ------------------------------------------------------ |
| Approved browser      | `127.0.0.1` gateway            | HTTP and WebSocket                    | Load the UI and exchange live RPC                      |
| Gateway               | installed Coder CLI            | child stdio, `shell: false`           | Invoke authenticated Coder commands                    |
| Local client          | configured `127.0.0.1` port    | TCP or UDP                            | Access one configured workspace service                |
| Coder CLI             | configured Coder workspace     | foreground `coder port-forward`       | Carry a loopback-bound port forward                    |
| Coder CLI             | configured Coder deployment    | Coder-managed connection              | Authenticate, discover workspaces, and run `coder ssh` |
| Gateway               | workspace helper               | foreground `coder ssh` stdio          | Newline-delimited RPC                                  |
| Gateway               | workspace shell                | foreground `coder ssh` stdin          | Copy the helper bundle and validated attachments       |
| Workspace helper      | workspace Codex or Claude Code | child stdio, `shell: false`           | Provider conversation and permission control           |
| Workspace provider    | approved provider backend      | workspace-managed provider connection | Inference and authentication                           |
| Workspace helper      | workspace Git and `glab`       | child stdio, `shell: false`           | Repository and GitLab actions                          |
| Workspace GitLab CLI  | configured GitLab host         | workspace-managed provider connection | Repository/MR API access and authentication            |

The gateway contains no general HTTP client and makes no direct external request. It binds only to
IPv4 loopback and validates the exact Host and Origin. The helper opens no listener, tunnel, or
forwarded port. Separately, validated settings may start foreground `coder port-forward` processes
whose local endpoint is fixed to `127.0.0.1`; raw arguments, reverse forwards, and non-loopback bind
addresses are not accepted. The helper bundle and composer attachments are streamed over a
foreground `coder ssh` process's stdin to generated paths; no other program connects to the
workspace. Network telemetry and direct
workspace connections follow the configured Coder deployment and CLI defaults. T3-managed Codex
and Claude sessions load the MCP servers and app integrations configured in the workspace, as
upstream does; those servers run as workspace processes started by the provider executables.

User commands entered in a workspace terminal, repository-local Git hooks, and the externally
installed Codex, Claude, GitLab, Git, or Coder executables remain subject to the workspace and
corporate network policy; T3 cannot make those external programs networkless while still connecting
to Coder, the provider backends, and the configured GitLab host.

## Where data lives

The T3-owned local profile is limited to non-secret Coder deployment URLs, optional Coder executable
paths, workspace targets, structured port-forward rules, and the last gateway port. UI preferences,
unsent composer text, and caches of workspace projections (environment shells, thread snapshots,
server config, and branch lists) may use browser storage; the caches are cleared when a workspace is
removed from the Coder config and never hold image bytes or credentials. Repositories, prompts,
responses, provider sessions, terminals, checkpoints, project records, project roots, and SQLite state
remain in the selected workspace. Live display data necessarily traverses the foreground stdio
connection and loopback WebSocket but is not durably cached by the gateway. A validated composer
attachment stays in gateway memory for one transfer and is never written to local disk.
Native Codex image input accepts only bounded opaque ids for generated workspace attachment files;
the helper rejects symlinks and revalidates file size and image signatures before reading bytes.
Project image previews read current files through bounded helper stdio chunks after thread/root
ownership, project containment, file revision, signature, and size checks. No new screenshot
artifacts are created. Previously saved artifact IDs remain readable for older conversations.
Image bytes exist in the browser only as revocable, memory-only object URLs.

Coder owns deployment credentials. With the supported Coder CLI 2.25.3, T3 selects a separate opaque
`--global-config` directory per domain so two file-backed Coder sessions can coexist. Coder 2.25.3
writes a plaintext session token in each directory. The gateway never asks for, reads, logs, copies,
or writes those tokens. Provider authentication exists only in the workspace and is owned by the
installed Codex or Claude Code CLI. GitLab authentication is owned by the workspace-installed
`glab` CLI; T3 does not ask for, read, persist, copy, or log its tokens.

## Capabilities outside the product

- Electron, native desktop packaging, mobile, hosted web, relay, Tailscale, Cloudflare, OAuth,
  Clerk, telemetry, auto-update, and browser preview;
- providers other than workspace Codex, Claude Code, and Pi;
- generic user-facing SSH, reverse forwarding, arbitrary tunnels, non-loopback port-forward binds,
  and background workspace daemons; the structured foreground `coder port-forward` feature is the
  sole forwarding exception;
- arbitrary uploads and background file synchronization; composer attachments are the only
  upload. Upstream's Save, Download, Copy, and Export actions save bytes the browser already holds,
  read through the existing helper connection in bounded chunks; no gateway download route exists;
- Hosted source-control providers other than GitLab. Repository-scoped fetch, pull, commit, push,
  clone, repository publishing, and merge-request operations are available only in the workspace
  helper through Git and the workspace-installed `glab` CLI; the local gateway performs none of
  those operations and does not register GitHub, Azure DevOps, or Bitbucket;
- the removed T3 preview MCP, Claude browser integration, free-form Claude launch flags, and the
  packaged Anthropic Agent SDK;
- automatic browser launch and hosted CI workflows. The explicit `--open-browser` opt-in opens only
  the gateway's loopback URL.

The helper bootstrap and composer attachments travel over a foreground `coder ssh` process's stdin;
the Coder CLI is the only local program that connects to a workspace. Image preview display uses
the already-running helper RPC and does not spawn another connection.

## Distribution review

The GitHub source ZIP for the default `coder-only` branch contains only the selected commit's files;
it does not contain Git history or `node_modules`. Large vendored reference repositories, editor
configuration payloads, upstream release tooling, and native application projects have been removed.

The source retains three browser assets required by the terminal: two Ghostty WebAssembly files and
one symbols font. Their hashes are:

| Asset                               | SHA-256                                                            |
| ----------------------------------- | ------------------------------------------------------------------ |
| `ghostty-vt.wasm`                   | `51b016a6aa3c29ead71c7c8acf8c01d43b064bae19957a9c9f9e2bf469267629` |
| `ghostty-write-pty.wasm`            | `75cb147e98ede3f85f3cd6236a30f6d12565b0b237e1d8db941f5f3e8ad3d903` |
| `SymbolsNerdFontMono-Regular.woff2` | `a8e2fc5ae3c2525812151b95da80c5beab0befa84aca84fc33aaed94317502df` |

Recommended intake sequence:

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm audit --prod
pnpm licenses list --prod
pnpm test:coder
pnpm typecheck:gateway
pnpm typecheck:helper
pnpm typecheck:server
pnpm typecheck:web
pnpm build
npm start
```

`npm start` prints a loopback URL that keeps its port across restarts when the port is free. Open it
manually in an approved browser, or use the explicit `npm run start:open` opt-in to open that
loopback URL. Dependency installation is the only
step that normally contacts a package registry; runtime startup does not install packages or check
for updates. Registry URLs present in the SBOM are inventory metadata, not runtime endpoints.
