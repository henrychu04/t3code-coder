# Software intake and compliance review

This document describes what the `coder-only` source distribution does. It is review evidence, not
an assertion that any employer has approved the software.

## Runtime process and network inventory

| Source                | Destination                         | Mechanism                             | Purpose                                                 |
| --------------------- | ----------------------------------- | ------------------------------------- | ------------------------------------------------------- |
| Approved browser      | `127.0.0.1` gateway                 | HTTP and WebSocket                    | Load the UI and exchange live RPC                       |
| Gateway               | installed Coder CLI                 | child stdio, `shell: false`           | Invoke authenticated Coder commands                     |
| Local client          | configured `127.0.0.1` port         | TCP or UDP                            | Access one configured workspace service                 |
| Coder CLI             | configured Coder workspace          | foreground `coder port-forward`       | Carry a loopback-bound port forward                     |
| Gateway               | installed OpenSSH `scp`             | child process, `shell: false`         | Copy the helper and validated pasted images             |
| Coder CLI             | configured Coder deployment         | Coder-managed connection              | Authenticate, discover workspaces, and run `coder ssh`  |
| OpenSSH `scp`         | Coder CLI ProxyCommand              | `coder ssh --stdio`                   | Coder-authenticated transfer with no direct SSH path    |
| Gateway               | workspace helper                    | foreground `coder ssh` stdio          | Newline-delimited RPC                                   |
| Workspace helper      | workspace Claude Code               | child stdio, `shell: false`           | Streaming JSON conversation and permission control      |
| Workspace Claude Code | approved Claude backend             | workspace-managed provider connection | Claude inference and authentication                     |

The gateway contains no general HTTP client and makes no direct external request. It binds only to
IPv4 loopback and validates the exact Host and Origin. The helper opens no listener, tunnel, or
forwarded port. Separately, validated settings may start foreground `coder port-forward` processes
whose local endpoint is fixed to `127.0.0.1`; raw arguments, reverse forwards, and non-loopback bind
addresses are not accepted. SCP is restricted to generated helper and clipboard-image paths and
reaches the workspace only through a temporary Coder ProxyCommand. Network telemetry and direct
workspace connections follow the configured Coder deployment and CLI defaults. T3-managed Claude
sessions use an empty strict MCP configuration and disable connected claude.ai MCP servers.

User commands entered in a workspace terminal, repository-local Git hooks, and the externally
installed Claude or Coder executables remain subject to the workspace and corporate network policy;
T3 cannot make those external programs networkless while still connecting to Coder and Claude.

## Data ownership

The T3-owned local profile is limited to non-secret Coder deployment URLs, optional Coder executable
paths, workspace targets, and structured port-forward rules. UI preferences may use browser storage. Repositories, prompts,
responses, Claude sessions, terminals, checkpoints, project records, project roots, and SQLite state
remain in the selected workspace. Live display data necessarily traverses the foreground stdio
connection and loopback WebSocket but is not durably cached by the gateway. A validated pasted image
may be staged in an OS temporary directory for one SCP attempt; the gateway removes it afterward.
Turn-scoped screenshot artifacts remain beneath `$HOME/.t3-coder/artifacts` in the workspace. Their
bytes traverse the existing stdio and loopback path only after the user expands the collapsed
artifact row, and exist in the browser only as revocable, memory-only object URLs.

Coder owns deployment credentials. With the supported Coder CLI 2.25.3, T3 selects a separate opaque
`--global-config` directory per domain so two file-backed Coder sessions can coexist. Coder 2.25.3
writes a plaintext session token in each directory. The gateway never asks for, reads, logs, copies,
or writes those tokens. Claude authentication exists only in the workspace and is owned by the
installed Claude Code CLI.

## Removed and prohibited capabilities

- Electron, native desktop packaging, mobile, hosted web, relay, Tailscale, Cloudflare, OAuth,
  Clerk, telemetry, auto-update, and browser preview;
- providers other than workspace Claude Code;
- generic user-facing SSH, reverse forwarding, arbitrary tunnels, non-loopback port-forward binds,
  and background workspace daemons; the structured foreground `coder port-forward` feature is the
  sole forwarding exception;
- arbitrary uploads, downloads, exports, drag-and-drop transfer, clipboard text transfer, and
  background file synchronization; pasted images and turn-scoped visual artifact display are the
  only user-facing transfer exceptions. Both accept signature-validated PNG, JPEG, and WebP images
  up to 20 MiB. Artifact capture is limited to 10 images per turn, and artifact reads accept only
  generated opaque IDs in bounded chunks after explicit UI expansion;
- Git fetch, pull, push, pull requests, and hosted source-control integrations;
- MCP servers, Claude browser integration, free-form Claude launch flags, and the packaged Anthropic
  Agent SDK;
- automatic browser launch and hosted CI workflows. The explicit `--open-browser` opt-in opens only
  the gateway's loopback URL.

The versioned helper bootstrap through helper-scoped SCP is the sole control-plane transfer
exception. Both helper and clipboard-image SCP use `coder ssh --stdio` as their ProxyCommand.
Screenshot artifact display uses the already-running helper RPC and does not spawn SCP or another
connection.

## Source ZIP and installation review

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

`npm start` prints an ephemeral loopback URL. Open it manually in an approved browser, or use the
explicit `npm run start:open` opt-in to open that loopback URL. Dependency installation is the only
step that normally contacts a package registry; runtime startup does not install packages or check
for updates. Registry URLs present in the SBOM are inventory metadata, not runtime endpoints.
