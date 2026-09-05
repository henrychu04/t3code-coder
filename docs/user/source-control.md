# Source control

Source control in T3 Coder runs inside the Coder workspace. Repository operations use workspace
Git, and hosted source-control operations use the workspace-installed GitLab CLI (`glab`). The
browser and local gateway never receive GitLab credentials.

## What you can do

- **Status and diffs** — see what changed in the working tree and review per-turn diffs of Claude's
  work as it happens.
- **Branches** — create, switch, and manage branches from the branch toolbar.
- **Worktrees** — run threads in their own worktree so parallel lines of work stay isolated.
- **Commits** — stage and commit from the panel.
- **Sync and publishing** — fetch, pull, push, clone, add remotes, and publish repositories without
  moving Git execution out of the workspace.
- **GitLab merge requests** — create, check out, review, comment on, update, merge, close, reopen,
  and manage reviewers from the merge-request views.
- **Checkpoints** — every turn gets a checkpoint you can compare against and restore to.

## Worktrees

The branch toolbar chooses where a thread's work lands, including a dedicated worktree. Use a
worktree whenever you are running Claude unattended — under
[Full access](./permission-modes.md#choosing-a-mode), it is the sandbox that makes unattended work
safe. Threads started from inside another thread can reuse its worktree or get their own.

## Reviewing changes

The review panel in the right panel shows the diff for the current turn and for the thread as a
whole. Reviews are built for large changes: big files stay usable, and a file that is too large to
render shows a clear notice instead of an error. File contents load as you expand context and stay
cached while you keep reading.

Use the file-tree toggle in a thread's **Diff** panel or a merge request's **Code** tab to browse
changed files as folders and jump directly to a file. T3 Coder remembers the toggle setting.

You can comment on diff lines. Comments annotate the review and can be sent back to Claude as
part of your next message, which makes "fix this spot" conversations precise.

## Automatic project pull

Turn on **Automatically pull** under **Settings → Source control** to keep a project's
default-branch checkout current inside its Coder workspace. T3 Coder checks when the workspace
helper starts and during background source-control refreshes. It uses the branch's configured
upstream and performs only a fast-forward pull when the checkout has no working-tree changes,
untracked files, or local commits.

The pull is skipped if the checkout is on another branch, has no upstream, or contains local work.
Pull failures do not prevent the helper from starting.

## Checkpoints

Each turn records a checkpoint of the repository state. Open a checkpoint to see what that turn
changed — including diffs against earlier checkpoints — and restore to roll the repository back to
that point. Checkpoints are the local, workspace-side safety net; nothing is pushed anywhere.

## GitLab access

GitLab authentication remains entirely owned by `glab` in the workspace. T3 Coder never asks for,
reads, stores, or logs a GitLab token. A workspace-level write probe runs once before the first
GitLab mutation. If workspace policy blocks writes, authentication is unavailable, or the result is
indeterminate, GitLab write actions stay disabled while read-only merge-request features continue
to work. Settings shows a bounded diagnostic category for failed or indeterminate probes, such as
a missing CLI, timeout, network/TLS failure, HTTP rejection, or unrecognized exit status. Raw
`glab` output is never sent to the browser. T3 Coder does not register GitHub, Bitbucket, Azure
DevOps, or another hosted provider.

## Merge-request list

The **Pull requests** page can keep several merge requests open as right-panel tabs. Authored work
appears before review requests. The default ordering ranks merge-ready work first within each
group, with explicit alternatives for update time, creation time, and change size. Filter loaded
results by author or labels. Sort order and fixed display filters are remembered in the browser;
search text, authors, labels, and repository/workspace scope are not saved in browser storage.
See label, check, and change-size context on each row. Opening a row seeds the detail panel from
list data immediately while the full GitLab detail loads.
Command-click (Control-click on Windows and Linux) a merge request number to open it on GitLab
instead of inside T3 Coder.
