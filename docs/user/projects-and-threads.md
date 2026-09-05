# Projects and threads

A project is a repository checkout in a workspace. Threads are the conversations you have with
Claude about that project's work.

## Projects

Choose **Add project** in the sidebar, pick a domain and workspace, and select a folder in the
remote folder picker. The project appears in the sidebar with a built-in icon chosen automatically
from its name, or its folder name when the project name is blank. Project images are not fetched.

When more than one workspace is connected, the sidebar groups projects and threads by workspace so
you always know where work is running.

## Thread states

A thread with unsent composer content shows an amber tint and pen icon after you navigate away
from it. On an active-list row, hover and choose **X** to discard the draft without opening the
thread. Draft contents stay in browser memory and are not saved locally.

Threads move through four states in the sidebar:

- **Pinned** — kept above your active work, independent of project grouping. Pin or unpin from the
  thread's context menu, or press `mod+shift+p`. Drag to reorder. Enable **Settings → Preferences
  → Confirm before unpinning** if you want every unpin action to ask first.
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
