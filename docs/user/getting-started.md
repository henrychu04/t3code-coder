# Install T3 Coder

T3 Coder is a browser interface for Claude Code running inside Linux Coder workspaces. Your
computer runs a small local gateway and the web UI; your code, Claude sessions, terminals, and
history stay in the workspace.

## Requirements

On the machine that runs T3 Coder:

- Node.js 24.10 or newer and pnpm 11.10
- Coder CLI 2.25.3
- On Windows, the OpenSSH Client feature (`ssh.exe` and `scp.exe`)

Development and testing happen on macOS; Windows 11 is the supported daily-use host.

Inside each Linux Coder workspace you plan to use:

- Claude Code, installed and authenticated (`claude auth login` in the workspace)
- Git
- Nix with a configured `nixpkgs` and access to its substituters
- the standard Linux `script` utility

T3 Coder drives the workspace Claude Code CLI; it does not ship it or re-authenticate it. Sign in
to Claude Code in the workspace the way you normally would.

The workspace's default Node.js version can stay whatever it is. On first connection, T3 Coder
provisions a pinned Node.js 24 runtime through Nix into a dedicated profile and uses it only for
its own helper — your shells and tools keep their normal Node.js.

## Run

```bash
pnpm install --frozen-lockfile --ignore-scripts
npm start
```

The gateway builds the UI, binds to an ephemeral `127.0.0.1` port, and prints the local URL. Open
that URL in your browser. T3 Coder never launches a browser on its own; `npm run start:open` is an
explicit opt-in for machines where that is acceptable.

## First run

The full interface opens even before any workspace is configured.

1. Open **Settings → Coder connections**.
2. **Add domain** and enter your Coder deployment URL.
3. Choose **Sign in** for that domain. Coder prints its login URL and a hidden token prompt in the
   terminal where `npm start` is running — complete the sign-in there. T3 Coder never asks for the
   token in its UI and never reads or stores it; Coder owns the credential.
4. Back in the sidebar, choose **Add project**, select the domain and workspace, and navigate to a
   Linux folder in the remote folder picker.

## First connection to a workspace

The first connection to each workspace runs a preflight that verifies the workspace before
anything starts:

- Linux x86-64 architecture
- Git and at least one of Codex or Claude Code present
- the pinned Node.js 24 runtime available through Nix (downloaded once if missing)

After preflight, T3 Coder installs a version-matched helper, including its native terminal runtime,
into the workspace and runs it for the duration of the connection. This one-time setup can take a
minute; later connections reuse it and are quick. Progress for every phase is visible in
**Settings → Coder connections**.

## Day to day

- **Refresh reconnects.** Reloading the browser or temporarily losing the connection does not stop
  your work; the session reattaches. Nothing is stored on your computer, so any browser can pick
  the session back up.
- **Workspace stopped?** T3 Coder never starts a stopped workspace behind your back. Start it from
  **Settings → Coder connections** or from the workspace controls. See
  [Coder workspaces](./workspaces.md).
- **Signing in to more than one domain** works; each domain keeps its own isolated Coder sign-in.
  See [Coder workspaces](./workspaces.md).

## Where things live

- **In the workspace:** repositories, projects, threads, Claude sessions, terminals, checkpoints,
  and all history.
- **On your computer:** a small settings file with Coder URLs and workspace choices — no secrets,
  no repositories, no conversations. Browser preferences such as theme stay in the browser.

If something does not connect, see [the troubleshooting section](./workspaces.md#troubleshooting)
in Coder workspaces.
