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

Turn on **Automatically pull** in [Project settings](./project-settings.md) to keep a project's
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

## Linked merge requests

A thread can hold several GitLab merge requests. Use **Link merge request to thread** in the command
palette or **Linked MRs** in the right-panel menu. Enter a merge-request URL or a number for the
thread's own repository. A URL may name another repository on a GitLab host already identified by
workspace project metadata. Creating a merge request from the thread's Git actions links it automatically.

The **Linked MRs** panel lists the linked reviews and groups related branches. Its row menu can
unlink a review. The review header's **Link to thread** action links it to another active thread;
the linked-thread count opens a search that includes archived threads. Sidebar and command-palette
search also match linked review numbers, repositories, and titles.

When an MR is open beside a thread, a layer indicator appears if its linked MRs form a branch
chain. Open it to see the stack's MR titles, statuses, and source/target branches, then select a
layer to open that review. The base branch appears below the list. These relationships are inferred
from MRs already linked to this thread, within the same GitLab host and repository; the menu does
not discover unlinked MRs or offer stack merge/rebase actions. Ambiguous reused head branches are
not treated as a known parent.

The workspace refreshes link status even while the browser is disconnected. Open or unsynced links
keep a thread active; automatic settlement can proceed once every linked review is terminal, subject
to the workspace's settlement settings. GitHub-native stack merge and rebase actions are not supported.

Press Command-Enter (Control-Enter on Windows) to save an edited review description or comment.
Recent review summaries are cached in the workspace across helper restarts. Review contents and
linked-review panel state remain in browser memory while displayed.

### Agent-managed links

Codex and Claude receive workspace CLI commands for listing, linking, and unlinking the current
thread's merge requests on ordinary message turns. Native slash commands are sent unchanged.
After creating an MR with `glab`, the agent can register its GitLab URL
so T3 tracks it alongside the thread. These commands change T3's associations; they do not create,
close, merge, or rebase GitLab MRs. Plan mode allows listing only.

No MCP setup is needed. The command is supplied for the active turn and expires when that turn
finishes or the provider session stops. If a command times out, list the links before retrying:
the association may already have changed. URLs must identify a GitLab host known to workspace
project metadata, including when linking an MR from another repository.

## Worktree setup progress

Starting a thread in a new worktree shows fetch, checkout, submodule, setup-script, and agent
stages. Checkout percentages come from Git when it reports them. Setup scripts show recent output
and a link to their terminal; the first turn waits for script completion. Script failures remain
visible while the thread continues so you can diagnose the checkout.

**Cancel** stops setup, closes its script terminal, and removes the worktree and thread created by
that attempt. The prompt returns to the draft. **Use project checkout** cancels setup and resends
from the project's checkout inside the same Coder workspace. Cancellation is unavailable once the
agent turn is dispatched.

A folder without a Git repository or resolvable base commit uses the project checkout. When
starting from origin, the helper fetches origin and uses its branch when available, otherwise it
uses the local base branch. Submodules are initialized from cached or local sources; unavailable
submodules produce a warning.

## Diff display and comments

**Settings → Preferences → Default diff file state** chooses whether files start expanded or
collapsed in review diffs and a merge request's Code tab. Files start expanded by default; you can
still toggle individual files or all files in the toolbar.

The merge-request comment button floats at the bottom right across its tabs. Where GitLab grants
the required permissions, it also offers **Close with comment** or **Reopen with comment**. If the
comment posts but GitLab refuses the state change, the comment remains posted and T3 reports the
failed action.

## Reviewer updates

After GitLab accepts a reviewer change, the reviewer picker, summary, and activity view update
together. Completed reviews remain visible when their authors are no longer requested reviewers.
If the selected reviewer is missing from the loaded candidates, those views refresh from GitLab.
Labels can be displayed and used to filter requests; GitLab label editing is not available here.

## Clone progress and viewed files

Cloning a GitLab repository opens the project while the workspace clone continues in the
background. Its new-thread banner shows progress. You can cancel or retry a failed clone there;
messages wait until cloning succeeds. Removing a failed project is also available from the banner.

Mark files **Viewed** in a merge request's Code tab to track your review. Marks are saved in the
Coder workspace and shared by connected clients. A later push marks changed files as stale so
you can review them again. GitLab authentication continues to use the workspace's `glab` CLI.
