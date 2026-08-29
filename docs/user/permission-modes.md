# Permission modes

A permission mode controls how much Claude does on its own and when it stops to ask you.

The mode is set per thread, from the mode control in the message composer. Changing it in one
thread does not change any other thread. A thread created from inside another thread keeps that
thread's mode; otherwise new threads start in **Full access** unless you pick something else
before sending.

## The modes

**Supervised**: ask before commands and file changes. Claude pauses and shows you what it wants to
run or edit, and waits for approval. Work outside the workspace is restricted.

**Auto-accept edits**: auto-approve edits, ask before other actions. File changes go through
without prompting; commands and anything else still stop for approval.

**Auto**: routine actions proceed without you; risky ones still ask. Claude uses its own auto
permission mode for this.

**Full access**: allow commands and edits without prompts. The default. Claude runs unattended
until it finishes or asks a question of its own.

Approvals appear inline in the conversation. Approve or reject one and Claude continues from
there.

## Choosing a mode

Use **Full access** for work in a [worktree](./source-control.md#worktrees) or another sandbox you
can throw away.

Use **Supervised** on a repository where an unwanted command is expensive, or the first time you
run an unfamiliar task.

**Auto-accept edits** suits refactors where the edits are the point and you only care about the
shell commands.

## How modes map to Claude

Each mode translates onto Claude Code's own approval settings, managed by T3 Coder — you do not
configure Claude's permission flags yourself. The labels above describe what you get; the exact
translation is internal and may change.

T3 Coder runs every managed session with a strict, empty MCP configuration: no filesystem or
claude.ai MCP servers are attached, and free-form Claude launch flags are not exposed.
