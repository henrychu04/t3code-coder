# Contributing

This fork deliberately supports one deployment model: a loopback browser gateway controlling
Claude Code in Linux Coder workspaces through foreground Coder SSH stdio.

Before changing behavior, read [the Coder-only architecture](./docs/internals/coder-only.md) and
the repository rules in [AGENTS.md](./AGENTS.md). Keep changes inside that boundary and accompany
backend behavior changes with focused tests.

Run the focused checks listed in the root README before submitting a change. Do not include
credentials, Coder tokens, local configuration, generated build output, or work-system data.
