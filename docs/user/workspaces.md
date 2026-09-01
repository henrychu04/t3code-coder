# Coder workspaces

T3 Coder runs everything inside Linux Coder workspaces. The **Settings → Coder connections** page
is where you manage domains, sign-ins, workspaces, port forwards, and connection diagnostics.

## Domains and sign-in

Add each Coder deployment you use under **Settings → Coder connections**. Each domain gets its own
isolated Coder sign-in, so a work deployment and a personal one can stay signed in side by side.

Choose **Sign in** and complete the flow in the terminal where `npm start` runs: Coder prints its
login URL and a hidden token prompt there. T3 Coder never asks for, reads, or stores the token —
Coder owns the credential. If a sign-in expires, repeat the same flow.

Provider authentication is separate and remains inside the workspace. See
[Codex and Claude Code](./providers.md) for provider status and sign-in guidance.

## Workspaces

After a domain is signed in, its workspaces appear on the connection page, and you pick one when
you [add a project](./getting-started.md#first-run). You can use several workspaces at once — for
example, one per team or per environment — and the sidebar groups threads by the workspace they
run in.

Each workspace row shows Coder's own status and gives you explicit controls:

- **Start** / **Stop** / **Restart** — lifecycle actions. Starting, restarting, or updating first
  closes the workspace's active sessions and port forwards, then restores the forwards when the
  workspace is back.
- **Update** — appears when a template update is available (**Update available** badge). Updating
  restarts the workspace on the new template.
- **Stop schedules** — while a workspace is starting, T3 Coder shows Coder's idle-stop countdown.
  If your template sets a required stop time, that absolute deadline is shown too; otherwise the
  stop is idle-based and shifts as you use the workspace.

A stopped workspace is never started implicitly. Connecting to it will not wake it up — start it
deliberately.

## Health and latency

The workspace header shows a health card with CPU, memory, and home-disk usage, refreshed about
every ten seconds while the card is open. A latency indicator reflects the current round-trip to
the workspace; if several samples in a row are high, T3 Coder shows a slow-connection warning.

Connection diagnostics — each attempt and phase of preflight, helper install, and connection, with
durations — are listed on the connection page for the current gateway session. This timeline is
kept in memory only and contains no command output.

## Port forwards

A port forward lets a local tool reach a service inside a workspace — a dev server, a database
panel — without any other network path.

Create a rule under **Settings → Coder connections → Port forwards**:

1. Pick the workspace.
2. Choose **TCP** or **UDP**.
3. Enter the local port and the workspace port.

The local side always binds to `127.0.0.1` on your machine — forwards are never reachable from the
network. Each rule runs its own forward process, reports its state (**Starting**, running,
**Stopped**), and can be restarted or removed individually. Saved rules start again when the
gateway starts; a rule that failed stays stopped until you restart it or change its configuration.

## Data ownership

Repositories, prompts, responses, provider sessions, terminals, checkpoints, project records, and
the application database remain in the workspace. The local profile contains only the non-secret
information needed to reconnect and recreate explicit port-forward rules. Coder owns Coder
credentials, and provider credentials remain in the workspace.

## Troubleshooting

**The page says the workspace failed preflight.** Preflight verifies Linux x86-64, Git, Nix,
`script(1)`, the managed Node.js runtime, and at least one supported provider. Fix the missing piece
in the workspace and reconnect — the diagnostics timeline shows which check failed and when.

**Codex or Claude Code is missing or not authenticated.** Install or sign in to that provider in
the workspace itself. T3 Coder uses what the workspace provides. The other provider remains usable
when it is ready.

**The connection dropped.** Refresh the browser. Reloading reattaches to the running session; the
helper keeps working while the browser is away. If the underlying Coder SSH process exited, the
next connection reruns preflight and starts a fresh helper automatically.

**Everything shows unavailable.** If workspace status requests fail, T3 Coder marks status as
unavailable rather than showing a stale "running" label. Check that the workspace exists and your
sign-in is current, then reconnect.

**Connections feel slow.** Watch the latency indicator and expand the health card. High round-trip
times to the Coder deployment show up as a slow-connection warning; resource pressure appears in
the CPU and memory graphs.

**A port forward will not start.** Check that the workspace port is actually listening inside the
workspace and the local port is free. A failed forward stays stopped until you restart it
explicitly, so configuration problems never loop in the background.
