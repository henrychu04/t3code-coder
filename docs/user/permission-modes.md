# Permission modes

A permission mode controls how much the selected agent does on its own and when it stops to ask
you.

The mode is set per thread in the message composer. A new thread names its mode under the composer.
In a thread on your default mode, open the model picker and choose **Permissions** at its bottom, or
press `mod+shift+a`. A thread on another mode shows the mode next to the model.
Changing it in one thread does not change any other thread. A thread created from inside another
thread keeps that thread's mode. Other new threads use the default from **Settings → Threads → New
threads → Permissions** (**Full access** at first), which a project can override, unless you pick
something else before sending.

## The modes

**Supervised** asks before commands and file changes. Use it when you want to inspect actions before
they happen. Work outside the workspace remains restricted.

**Auto-accept edits** applies file changes without prompting while still asking before other
actions.

**Auto** lets supported providers approve routine actions while still asking about risky ones.
Provider policy decides the exact approval boundary.

**Full access** allows commands and edits without approval prompts. The agent can still stop to ask
a question.

Claude can still ask in **Full access** when its settings disable bypass permissions or require
approval for an action.
While a Claude approval is pending, type a text reply to decline that request and give feedback
directly to the agent that asked, including a subagent. Other pending requests stay unanswered.

Approvals appear inline in the conversation. Approve or reject one and the agent continues from
there.

## Choosing a mode

Use **Full access** for work in a [worktree](./source-control.md#worktrees) or another sandbox you
can throw away.

Use **Supervised** on a repository where an unwanted command is expensive, or the first time you
run an unfamiliar task.

**Auto-accept edits** suits refactors where the edits are the point and you only care about the
shell commands.

Use **Auto** when you want routine work to proceed while retaining provider-supported risk review.

## Availability depends on the provider

T3 Coder maps these product modes to each provider's own approval and sandbox controls. The labels
describe the user experience; the provider-specific implementation can differ.

The menu shows only the modes the selected provider supports. For Claude and Codex, that follows
the workspace's policy: Claude's settings can disable **Auto** and **Full access**, and Codex's
configuration requirements can rule out any mode. If T3 Coder cannot read the policy, it offers only
**Supervised** and **Auto-accept edits**.

If a selected mode is not supported, the thread runs in the closest supported mode below it (for
example, **Full access** becomes **Auto** when policy disables bypass permissions), and the
composer shows that mode.

Permission mode does not enable features outside the T3 Coder product boundary. T3 Coder does not
expose free-form provider launch flags.
