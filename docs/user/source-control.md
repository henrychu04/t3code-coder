# Source control

Source control in T3 Coder is repository-local. Everything happens inside the workspace copy of
the repository, which makes it fast and safe to use in environments where a hosted Git integration
is not welcome.

## What you can do

- **Status and diffs** — see what changed in the working tree and review per-turn diffs of Claude's
  work as it happens.
- **Branches** — create, switch, and manage branches from the branch toolbar.
- **Worktrees** — run threads in their own worktree so parallel lines of work stay isolated.
- **Commits** — stage and commit from the panel.
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

You can comment on diff lines. Comments annotate the review and can be sent back to Claude as
part of your next message, which makes "fix this spot" conversations precise.

## Checkpoints

Each turn records a checkpoint of the repository state. Open a checkpoint to see what that turn
changed — including diffs against earlier checkpoints — and restore to roll the repository back to
that point. Checkpoints are the local, workspace-side safety net; nothing is pushed anywhere.

## What it deliberately does not do

T3 Coder does not fetch, pull, push, or create pull requests, and it has no GitHub, GitLab, or
other hosted integrations. Do that from a terminal in the workspace or your normal Git tooling.
This keeps credentials for your Git host out of T3 Coder entirely.
