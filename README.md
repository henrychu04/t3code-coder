# T3 Coder

T3 Coder is a browser interface for Claude Code running inside Linux Coder workspaces. The local
computer runs only a loopback Node gateway and the web UI. Repositories, Claude sessions, terminals,
Git operations, checkpoints, and SQLite state stay in the selected Coder workspace.

```text
browser -> 127.0.0.1 gateway -> coder ssh stdio -> workspace helper -> Claude Code
```

This fork intentionally removes the upstream Electron, mobile, hosted-web, relay, OAuth, telemetry,
third-party source-control, and non-Claude provider implementations. It has no file upload or
download features and does not expose a remote HTTP or WebSocket listener.

## Requirements

On the local macOS test machine or Windows 11 work computer:

- Node.js 24.10 or newer
- pnpm 11.10
- the Coder CLI, authenticated to each deployment with `coder login <deployment-url>`

Inside each Linux Coder workspace:

- Claude Code, already authenticated
- Git
- Node.js 24.10 or newer
- the standard Linux `script` utility for terminal PTYs

## Run

```bash
pnpm install
npm start
```

The gateway builds the pinned workspace helper and web client, binds to an ephemeral
`127.0.0.1` port, and opens the default browser. Use `npm run start:no-browser` when browser launch
is restricted.

Add a Coder deployment URL, discover its workspaces through the installed Coder CLI, and register
projects by their absolute Linux paths. Connecting installs the version-matched helper through a
separate Coder SSH stdin operation and then runs it in the foreground over newline-delimited stdio.
Coder owns deployment authentication; T3 Coder never reads or stores Coder tokens.
Every Coder invocation disables the CLI's optional network telemetry.

The local profile is a small JSON file containing only deployment URLs, Coder workspace targets,
project display names, and remote Linux roots. UI-only preferences such as theme and panel size may
remain in browser storage. Claude sessions, messages, repository data, terminals, and SQLite state
are never persisted locally.

## Security boundary

The local gateway accepts only its exact loopback Host and Origin and sends no CORS headers. It has
no application authentication token by design. Its only non-loopback child transport is the
installed Coder CLI. The workspace helper opens no listening socket.

Allowed transport paths are:

- browser to the loopback gateway;
- gateway to the configured Coder deployment through `coder ssh`;
- Claude Code to endpoints permitted by the workspace policy.

See [the architecture note](./docs/internals/coder-only.md) for the complete boundary and data
ownership model.

## Focused verification

```bash
pnpm test:coder
pnpm typecheck:gateway
pnpm typecheck:helper
pnpm typecheck:server
pnpm typecheck:web
pnpm build
```

This is a private-purpose fork of the open-source T3 Code project. Review and obtain approval under
your employer's software, security, data-handling, and open-source policies before using it with
work systems or data.
