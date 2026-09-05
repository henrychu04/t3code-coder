# Contributing

T3 Coder has one product goal: provide the T3 Code experience for Codex and Claude Code while
keeping development work inside Linux Coder workspaces.

Upstream T3 Code is the source of truth for shared product behavior. Before changing behavior, read
[the product decisions](./docs/product-differences.md), [the Coder-only
architecture](./docs/internals/coder-only.md), and the repository rules in
[AGENTS.md](./AGENTS.md). Preserve upstream behavior by default and make any Coder-specific
adjustment deliberate and documented.

Run the focused checks listed in the root README before submitting a change. Backend behavior
changes need focused tests. Do not include credentials, Coder tokens, local configuration,
generated build output, or work-system data.

Run `pnpm knip:check` to audit unused files and dependencies in the Coder gateway, helper,
browser, and shared packages. `pnpm knip` also reports unused exports and types. The fork-specific
configuration excludes removed platform entry points and preserves generated protocol definitions.
The audit currently reports existing cleanup work; review findings rather than deleting files or
adding ignores solely to obtain a passing result.
