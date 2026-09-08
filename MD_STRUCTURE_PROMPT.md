# Prompt: align a repo's markdown files to this structure

Scratch file for copy-paste only — delete it after copying. Copy everything below the line into
another session.

---

Restructure this repo's markdown files to follow this layout and these principles. Do not invent
new policy — extract rules that already exist (in conversation history, code comments, scattered
docs) and consolidate them.

## Target layout
- `AGENTS.md` (root): the single canonical agent-rules file. If `CLAUDE.md` exists, make it the
  single line `@AGENTS.md`. Before removing any nested `AGENTS.md`/`CLAUDE.md` files, inventory
  them, record which rules are scoped to their directory, and merge still-valid scoped rules into
  the root file — never silently delete existing guidance. Keep a nested file only when its rules
  are genuinely directory-scoped and conflict with nothing at the root.
- `docs/README.md`: the canonical index hub, with two sections — user-facing guides, then
  maintainer/contributor docs. Every md file must be reachable from this index. Where two indexes
  could exist, this one wins; other files link to it rather than re-listing the guides.
- `docs/user/*.md`: task-oriented user guides, one topic per file.
- `docs/internals/*.md`: deep architecture/boundary docs.
- `README.md` (root): what the product is, requirements, quick start, a link to the canonical docs
  index (`docs/README.md`) instead of its own guide list, how this project differs from its
  upstream/origin (if a fork), and the verification commands.
- `CONTRIBUTING.md`: short — pointers to AGENTS.md and the internals doc, verification expectations,
  commit/hygiene rules.
- `SECURITY.md` (if applicable): supported boundary, reporting process, dependency review.

## AGENTS.md required sections, in order
1. One-paragraph identity: what this project is and isn't.
2. A "read `<internals doc>` before changing `<critical boundary>`" pointer.
3. Non-negotiable boundary: hard rules written as explicit prohibitions. Allowed exceptions are
   enumerated individually, each scoped to its own mechanism with exact limits (sizes, counts,
   paths), and state what the exception does NOT authorize.
4. Supported platforms/environments.
5. Code layout: one line per package/directory describing its responsibility.
6. Verification: exact commands to run, plus which checks NOT to run (e.g. "use the smallest
   relevant checks, not repository-wide legacy suites").
7. Working practices: preferred tooling, source-of-truth conventions, git hygiene (preserve
   unrelated changes, no destructive commands, never commit secrets/scratch notes/generated output),
   and anything that must never be done proactively (commits, PRs).

## Writing principles
- Single source of truth per topic; cross-link instead of duplicating content between files.
- Declare the source of truth explicitly wherever two docs could drift (e.g. "upstream X is the
  source of truth for shared behavior; adapt, don't re-derive").
- Prefer concrete, testable rules over vague guidance — exact versions, limits, and paths.
- Keep each file short; move depth into docs/ and leave pointers in root files.
- After restructuring, verify every link resolves and report a summary of what moved where.
