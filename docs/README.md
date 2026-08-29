# T3 Coder docs

These guides are adapted from upstream [T3 Code](https://github.com/pingdotgg/t3code)'s
`docs/user/`, which is the source of truth for behavior the two products share. T3 Coder's guides
diverge only where the Coder-only model requires it — when upstream updates a shared guide, port
the update here.

## Using T3 Coder

- [Install and first run](./user/getting-started.md)
- [Coder workspaces](./user/workspaces.md)
- [Projects and threads](./user/projects-and-threads.md)
- [Permission modes](./user/permission-modes.md)
- [Message composer](./user/composer.md)
- [Files and search](./user/files-and-search.md)
- [Images and screenshots](./user/images-and-screenshots.md)
- [Source control](./user/source-control.md)
- [Keyboard shortcuts](./user/keybindings.md)

## Working on T3 Coder

Everything below is for maintainers and reviewers. Using T3 Coder? Start with
[the guides above](#using-t3-coder).

- [Coder-only architecture](./internals/coder-only.md) — the complete runtime boundary and data
  ownership model. Read before changing the runtime boundary.
- [Software intake and compliance review](./compliance-review.md) — process/network inventory and
  removed-capability list for review evidence.
- [Security policy](../SECURITY.md)
- [Third-party notices](../THIRD_PARTY_NOTICES.md)
- [Contributing](../CONTRIBUTING.md) and [agent rules](../AGENTS.md)
