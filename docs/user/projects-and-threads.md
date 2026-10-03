# Projects and threads

A project is a repository checkout in a workspace. Threads are the conversations you have with
Codex or Claude about that project's work.

## Projects

Choose **Add project** in the sidebar, pick a domain and workspace, and select a folder in the
remote folder picker. The project appears in the sidebar with a built-in icon chosen automatically
from its name, or its folder name when the project name is blank. Project images are not fetched.

When more than one workspace is connected, the sidebar groups projects and threads by workspace so
you always know where work is running.

## Create a project

Choose **New project** in the command palette, select a Coder workspace, and enter a name.
T3 Coder creates a folder under that workspace's `~/.t3-coder/projects`, with a README, an icon,
and a first Git commit. If Git cannot make the commit, the project still opens and reports why.
You may also publish it as a private GitLab repository using the workspace's existing GitLab login.

## Start without a project

Choose **New thread without a project** in the command palette, choose **No project** in a draft's
project menu, or press `mod+alt+n`. Each thread gets its own folder under the workspace's
`~/.t3-coder/scratch`, named from its date, first message, and ID. Deleting the thread keeps that
folder. These folders are not Git repositories, so branch, worktree, and diff controls stay hidden.
This option is unavailable if T3 Coder's workspace data directory is inside a Git checkout.

## Thread states

A thread with unsent composer content shows an amber tint and pen icon after you navigate away
from it. On an active-list row, hover and choose **X** to discard the draft without opening the
thread. Draft contents stay in browser memory and are not saved locally.

Threads move through four states in the sidebar:

- **Pinned** — kept above your active work, independent of project grouping. Pin or unpin from the
  thread's context menu, or press `mod+shift+p`. Drag to reorder. Enable **Settings → Preferences
  → Confirm before unpinning** to confirm menu and keyboard unpin actions. Dragging out of the
  pinned section does not ask for confirmation.
- **Active** — everything you are working on now.
- **Snoozed** — out of the way until a wake time you pick from the thread's menu (later today,
  tomorrow morning, next week, and so on). Snoozed threads return to active on their own and a
  toast tells you when they wake.
- **Settled** — finished work. Settle with the thread menu or `mod+shift+s`. Un-settling returns a
  thread to the top of the active list so you can find it immediately; timestamps do not change.

Each workspace owns its automatic settlement settings. The workspace helper checks them even when
no browser is connected. By default, it settles threads after three days without activity and when
their GitLab merge request merges. An eligible idle thread also settles when its merge request
closes, while an open merge request blocks inactivity settlement. Active work, pending input, and
live background work keep the thread active. A closed or merged merge request triggers immediate
settlement only when its update timestamp is not older than the user's latest activity; otherwise
the inactivity rule can still apply. Manually un-settling a thread keeps it active until new work
clears that choice. Change these rules in **Settings → Preferences**. A settings change affects
future settlement and does not reopen an already settled thread.

## Drag and reorder

Drag within the pinned or active section to arrange threads. Drag between sections to pin,
unpin, settle, or un-settle a thread. Dragging a snoozed thread out wakes it; snoozing still
requires choosing a wake time from its menu. During a drag, the destination shows the action
that will happen. Transitions respect reduced-motion preferences.

The workspace saves the order. New threads appear above arranged active threads. Settling clears
active placement, so un-settling returns a thread to the top; pinning and snoozing retain its
active placement. Subsequent thread activity does not reorder arranged threads.

Manually settling an idle thread dismisses unanswered asynchronous questions without sending
an answer to the provider. Approvals, blocking questions, and live work still prevent settlement.

## Archiving

Archive a thread from its menu to retire it without deleting it. Archived threads live in
**Settings → Archived threads**, where you can review or unarchive them.

## Thread titles

New threads are named for you. To rename from the conversation instead, open the thread's context
menu and choose **Regenerate title**; while it is generating, the action is disabled.

## New threads

`mod+n` starts a thread; with more than one project it asks which one. `mod+shift+n` starts a
thread in the current project without asking. A new thread inherits sensible defaults from your
project and picks up the branch and [worktree](./source-control.md#worktrees) choices from the
branch toolbar, not from whichever thread you were last reading.

## Automatic review panels

Enable **Proactive panels** in **Settings → Preferences → Editor and history** to automatically
open a linked GitLab merge request or a completed turn's changed-file diff when entering a thread
or when new results arrive. This preference is off by default and does not open the narrow-screen
panel sheet automatically. Merge requests take priority over diffs. Closing or selecting a panel
while data loads prevents delayed automatic requests from replacing that choice; a new running
turn can trigger automatic panels again.

Recognized GitLab merge-request links in MR descriptions and comments open in the current panel.
On the merge-request page, navigation also updates the selected MR in the page URL. Video uploads
play inline, and other attachments open on their GitLab host.

## Thread notifications

Under **Settings → Preferences → Notifications**, enable thread alerts, sounds, or both. Alerts
cover completed turns, requests for input or approval, and failures. While you are using another
thread, an in-app alert can take you to the thread that needs attention. In the background, the
browser tab shows a badge that clears when you return. Sounds become available after your first
click or keypress in the app.

Both options start disabled. Notifications run only while the browser app is open, and historical
completions are not replayed when connecting or reconnecting.

## Custom snooze

Choose **Snooze → Custom…** from a thread menu to select a date and time in your local time zone,
or a duration in minutes, hours, or days. Durations start when confirmed; a day means 24 hours.
You can snooze selected threads together. Choose **Wake thread** to bring a thread back early.

## Fold working threads (beta)

Enable **Working section (beta)** in Preferences to move working or monitoring threads into a
collapsed **Working** shelf. They return to the top of the active list when they finish, fail,
or need an approval or answer. Pinned threads stay pinned. While enabled, the active list uses
return time rather than manual order; disabling it restores the saved order.

## Settlement controls and terminals

Choose **Auto-settle behavior → Disabled** in a thread's menu to keep it active regardless of
inactivity. Choose **Enabled** to restore the usual rules. Manual settlement, snooze, and archive
still work. Settling closes terminals waiting at an idle prompt while preserving their output;
terminals running commands remain open.
