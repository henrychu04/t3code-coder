# T3 Coder

T3 Coder is a browser interface for Codex and Claude Code running inside your Coder workspaces.
Start threads, review changes, run terminals, and manage repositories from a local web app while
your code, provider sessions, and history stay in the workspace.

Your computer runs only a small local gateway and the browser UI. Nothing about your projects,
conversations, or terminals is stored on the local machine — refresh the page and you are back
where you started.

## What you get

- **Projects and threads** — organize agent work by project, with pinning, snoozing, settling, and
  archiving for threads.
- **Conversation controls** — four permission modes, inline approvals, model and mode selection
  per thread, and a context meter with compaction.
- **Review** — per-turn diffs, diff comments, checkpoints, and worktree-aware branch controls.
- **Files** — browse, read, and edit text files in the active project, with file and content
  search.
- **Terminals** — workspace terminals attached to the thread you are working in.
- **Workspace management** — connect to Coder domains, start and stop workspaces, watch health
  and latency, and forward workspace ports to your machine.

Codex and Claude Code are the only agents T3 Coder drives, and they always run inside the
workspace — never on your computer. A workspace may provide either one or both.

## Requirements

On the local machine (macOS for development, Windows 11 for daily use):

- Node.js 24.10 or newer
- pnpm 11.10
- Coder CLI 2.25.3 (on Windows, with the OpenSSH Client feature installed)

Inside each Linux Coder workspace:

- Codex or Claude Code, already authenticated for the provider you intend to use
- Git
- Nix with a configured `nixpkgs` (used once to provision a pinned Node.js runtime)
- the standard Linux `script` utility

T3 Coder does not install or authenticate a provider. A missing or unauthenticated provider is
shown as unavailable while another ready provider remains usable.

## Quick start

```bash
pnpm install --frozen-lockfile --ignore-scripts
npm start
```

`npm start` prints a local URL such as `http://127.0.0.1:PORT`. Open it in your browser — T3 Coder
never opens the browser for you. Then:

1. Open **Settings → Coder connections** and add your Coder domain.
2. Choose **Sign in**. Coder prints its login URL and a hidden token prompt in the terminal running
   `npm start`; the token is handled there, never in the browser.
3. Choose **Add project** in the sidebar, pick your domain and workspace, and select a folder in
   the remote folder picker.
4. Choose an available Codex or Claude model and start a thread.

The first connection to a workspace runs a short preflight. It verifies the workspace platform,
Git, Nix, `script(1)`, and that at least one supported provider is present, then installs a
version-matched helper. This may take a minute; later connections are quick.

Full walkthrough: [Install and first run](./docs/user/getting-started.md).

## Documentation

| Guide                                                           | Covers                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------ |
| [Install and first run](./docs/user/getting-started.md)         | Requirements, setup, and the first connection                |
| [Codex and Claude Code](./docs/user/providers.md)               | Availability, sign-in, models, skills, and provider settings |
| [Coder workspaces](./docs/user/workspaces.md)                   | Domains, lifecycle, health, port forwards, troubleshooting   |
| [Projects and threads](./docs/user/projects-and-threads.md)     | Organizing projects, threads, pins, snooze, archive          |
| [Permission modes](./docs/user/permission-modes.md)             | How much the selected agent does on its own                  |
| [Message composer](./docs/user/composer.md)                     | Images, skills, commands, stash, context                     |
| [Files and search](./docs/user/files-and-search.md)             | Browsing, editing, and searching project files               |
| [Images and screenshots](./docs/user/images-and-screenshots.md) | Pasting images and viewing agent screenshots                 |
| [Source control](./docs/user/source-control.md)                 | Diffs, branches, worktrees, commits, checkpoints             |
| [Keyboard shortcuts](./docs/user/keybindings.md)                | Every shortcut and how to remap it                           |
| [Product decisions](./docs/product-differences.md)              | What matches upstream and what changes for Coder             |

## How this differs from upstream T3 Code

T3 Coder is a Coder-only fork of the open-source [T3 Code](https://github.com/pingdotgg/t3code).
It keeps the T3 Code interface and developer workflow but specializes it for Coder-managed Linux
workspaces: no desktop or mobile apps, no hosted web or relay service, no telemetry or auto-update,
only Codex and Claude Code as providers, and repository-local source control without hosted
pull-request integrations. MCP servers and provider app integrations are disabled. Where upstream
and T3 Coder share behavior, upstream's documentation is the source of truth; T3 Coder's guides
adapt it and note the differences.

The complete runtime and policy boundary is documented for software-intake review in
[the architecture note](./docs/internals/coder-only.md) and
[the compliance review](./docs/compliance-review.md). See also the
[security policy](./SECURITY.md) and [third-party notices](./THIRD_PARTY_NOTICES.md).

## Building from source

This is a private-purpose fork. Review and obtain approval under your employer's software,
security, and data-handling policies before using it with work systems or data. Focused checks:

```bash
pnpm test:coder
pnpm typecheck:gateway
pnpm typecheck:helper
pnpm typecheck:server
pnpm typecheck:web
pnpm build
```

Contributor and agent rules live in [AGENTS.md](./AGENTS.md).
