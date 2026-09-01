# Install and first connection

T3 Coder runs a local browser interface for agents and projects that live in Linux Coder
workspaces.

## Requirements

The local computer needs:

- Windows 11 with the OpenSSH Client feature for production use, or macOS for development and
  testing
- Node.js 24.10 or newer
- pnpm 11.10
- Coder CLI 2.25.3

The Coder workspace needs:

- Linux x86-64
- Git, Nix, and the standard Linux `script` utility
- Codex or Claude Code on `PATH`

The workspace template is expected to provide the agent CLI. T3 Coder does not install or
authenticate Codex or Claude Code.

## Start the local app

```bash
pnpm install --frozen-lockfile --ignore-scripts
npm start
```

T3 Coder prints an ephemeral `127.0.0.1` URL. Open that URL in an approved browser. The app does
not open a browser automatically.

## Connect to Coder

1. Open **Settings → Coder connections**.
2. Add the Coder domain. Use an explicit Coder executable path only when `coder` is not on the
   local `PATH`.
3. Select **Sign in**.
4. Complete Coder's login flow in the terminal running T3 Coder.

Coder owns this authentication. T3 Coder never asks for the token in its browser interface.

## Add a project

1. Select **Add project** in the sidebar.
2. Choose the Coder domain and workspace.
3. Browse to the Linux folder containing the project.
4. Confirm the project.

The first connection checks that the workspace meets the product requirements and prepares the
matching workspace helper. It may take longer while the pinned Node.js runtime is prepared through
the workspace's Nix configuration. This does not replace the workspace's normal Node.js version.

T3 Coder does not implicitly start a stopped workspace. Start it from the workspace controls, then
connect again.

## Confirm an agent is ready

The model picker shows models only from ready providers. If the provider you want is installed but
not authenticated, open a workspace terminal and run:

```bash
codex login
```

or:

```bash
claude auth login
```

Reconnect to the workspace after authentication so T3 Coder can read the updated provider status.
A workspace can use only Codex, only Claude Code, or both.

## Next steps

- [Codex and Claude Code](./providers.md)
- [Access modes](./permission-modes.md)
- [Coder workspaces](./workspaces.md)
