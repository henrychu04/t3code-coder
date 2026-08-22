# Software intake and compliance review

This document describes what the `coder-only` source distribution does. It is review evidence, not
an assertion that any employer has approved the software.

## Runtime process and network inventory

| Source                | Destination                 | Mechanism                             | Purpose                                                |
| --------------------- | --------------------------- | ------------------------------------- | ------------------------------------------------------ |
| Approved browser      | `127.0.0.1` gateway         | HTTP and WebSocket                    | Load the UI and exchange live RPC                      |
| Gateway               | installed Coder CLI         | child stdio, `shell: false`           | Invoke authenticated Coder commands                    |
| Coder CLI             | configured Coder deployment | Coder-managed connection              | Authenticate, discover workspaces, and run `coder ssh` |
| Gateway               | workspace helper            | foreground `coder ssh` stdio          | Newline-delimited RPC and versioned helper bootstrap   |
| Workspace helper      | workspace Claude Code       | child stdio, `shell: false`           | Streaming JSON conversation and permission control     |
| Workspace Claude Code | approved Claude backend     | workspace-managed provider connection | Claude inference and authentication                    |

The gateway contains no general HTTP client and makes no direct external request. It binds only to
IPv4 loopback and validates the exact Host and Origin. The helper opens no listener, tunnel, or
forwarded port. Every Coder command uses `--disable-network-telemetry` and
`--disable-direct-connections`. T3-managed Claude sessions use an empty strict MCP configuration and
disable connected claude.ai MCP servers.

User commands entered in a workspace terminal, repository-local Git hooks, and the externally
installed Claude or Coder executables remain subject to the workspace and corporate network policy;
T3 cannot make those external programs networkless while still connecting to Coder and Claude.

## Data ownership

The T3-owned local profile is limited to non-secret Coder deployment URLs, optional Coder executable
paths, and workspace targets. UI preferences may use browser storage. Repositories, prompts,
responses, Claude sessions, terminals, checkpoints, project records, project roots, and SQLite state
remain in the selected workspace. Live display data necessarily traverses the foreground stdio
connection and loopback WebSocket but is not durably cached by the gateway.

Coder owns deployment credentials. With the supported Coder CLI 2.25.3, T3 selects a separate opaque
`--global-config` directory per domain so two file-backed Coder sessions can coexist. Coder 2.25.3
writes a plaintext session token in each directory. The gateway never asks for, reads, logs, copies,
or writes those tokens. Claude authentication exists only in the workspace and is owned by the
installed Claude Code CLI.

## Removed and prohibited capabilities

- Electron, native desktop packaging, mobile, hosted web, relay, Tailscale, Cloudflare, OAuth,
  Clerk, telemetry, auto-update, and browser preview;
- providers other than workspace Claude Code;
- generic SSH, port forwarding, tunnels, and background workspace daemons;
- uploads, downloads, exports, attachments, drag-and-drop transfer, clipboard-image transfer, and
  background file synchronization;
- Git fetch, pull, push, pull requests, and hosted source-control integrations;
- MCP servers, Claude browser integration, free-form Claude launch flags, and the packaged Anthropic
  Agent SDK;
- automatic browser launch and hosted CI workflows.

The versioned helper bootstrap over Coder stdin is the sole control-plane transfer exception.

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

`npm start` prints an ephemeral loopback URL. Open it manually in an approved browser. Dependency
installation is the only step that normally contacts a package registry; runtime startup does not
install packages or check for updates. Registry URLs present in the SBOM are inventory metadata, not
runtime endpoints.
