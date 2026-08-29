# Permission modes

A permission mode controls how much the selected agent does on its own and when it stops to ask
you.

The mode is set per thread from the mode control in the message composer. Changing it in one thread
does not change any other thread. A thread created from inside another thread keeps that thread's
mode; otherwise new threads start in **Full access** unless you pick something else before sending.

## The modes

**Supervised** asks before commands and file changes. Use it when you want to inspect actions before
they happen. Work outside the workspace remains restricted.

**Auto-accept edits** applies file changes without prompting while still asking before other
actions.

**Auto** lets supported providers approve routine actions while still asking about risky ones.
Provider policy decides the exact approval boundary.

**Full access** allows commands and edits without approval prompts. The agent can still stop to ask
a question.

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

The menu shows only modes supported by the selected provider and model. Codex also reports
workspace configuration requirements, and T3 Coder removes any mode that those requirements do not
permit. While provider capabilities are unknown, T3 Coder limits the menu to **Supervised** and
**Auto-accept edits**.

If a previously selected mode becomes unavailable, T3 Coder uses the first supported mode instead
of sending an unsupported configuration to the provider.

Permission mode does not enable features outside the T3 Coder product boundary. T3 Coder runs
managed Codex and Claude sessions without MCP servers or provider app integrations, and does not
expose free-form provider launch flags.
