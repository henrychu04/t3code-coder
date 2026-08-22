# Third-party notices

T3 Coder is derived from T3 Code and is distributed under the repository's MIT license.

The production npm dependency closure is recorded in [`docs/sbom.cdx.json`](./docs/sbom.cdx.json).
At the time that SBOM was generated, `pnpm licenses list --prod` reported only MIT, Apache-2.0,
ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, and Unlicense packages. The lockfile contains the exact
versions and integrity hashes. Run `pnpm generate:sbom` after any dependency change.

The browser terminal includes two read-only WebAssembly assets built from Ghostty revision
`9f62873bf195e4d8a762d768a1405a5f2f7b1697`, licensed under MIT. Its notice is retained beside the
artifacts at [`apps/web/src/terminal/ghostty/vendor/LICENSE`](./apps/web/src/terminal/ghostty/vendor/LICENSE).
The symbols-only Nerd Font is also MIT licensed; its notice is retained at
[`apps/web/src/terminal/ghostty/fonts/LICENSE`](./apps/web/src/terminal/ghostty/fonts/LICENSE).

The Coder CLI and Claude Code are external prerequisites installed and authenticated by the target
environment. They are not copied into or distributed by this repository. In particular, this fork
does not package `@anthropic-ai/claude-agent-sdk` or any Anthropic platform binary.
