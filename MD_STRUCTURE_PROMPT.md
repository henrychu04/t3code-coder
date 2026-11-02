# Prompt: align a repo's markdown files to this structure

Scratch file for copy-paste only — never merge this PR. Copy everything below the line into
another session.

---

Restructure this repo's Markdown docs to follow the layout and rules below. Adapt them to this
repo: skip any section that doesn't apply, and don't create files the repo has no content for.

Do not invent policy. Only consolidate rules that already exist in this repo's docs. If you
would infer a rule from code, config, or CI, list it as a proposal for me to confirm instead
of writing it in.

## Process
1. List every human-facing Markdown file. Ignore vendored, generated, changelog, and
   `.github/` template files.
2. Propose a move/merge plan (old path → new path, what gets merged or dropped and why).
   Wait for my approval before changing anything.
3. Use `git mv` for moves. Don't commit, push, or open a PR. Leave unrelated changes alone.
4. After restructuring, search the whole repo (code, CI, package manifests, templates),
   not just Markdown, for old paths and fix them. Then check that every relative link
   resolves. Report what moved where, what was merged, and anything left unresolved.

## Layout
- `AGENTS.md` (root): canonical agent rules. Make `CLAUDE.md` the single line `@AGENTS.md`
  only after merging any Claude-specific content from it into `AGENTS.md`.
- Nested `AGENTS.md`/`CLAUDE.md`: keep them when their rules apply only to that directory.
  Move only duplicated or repo-wide rules up to the root. Never silently delete guidance.
- `docs/README.md`: canonical index. "Using <product>" (user guides), then
  "Working on <product>" (internals, then runbooks). Other files link here instead of
  keeping their own full guide list. Package READMEs may stay unindexed.
- `docs/user/`: task-oriented guides, one feature per file.
- `docs/internals/`: architectural decisions, constraints that span components, and traps.
- `docs/operations/`: maintainer runbooks (development setup, release, debugging).
- `README.md`: what the product is, requirements, install/quick start, a short list of key
  guides plus a link to `docs/README.md`, and (if a fork) how it differs from upstream.
  Dev setup and verification live in AGENTS.md and the development runbook, not here.
- `CONTRIBUTING.md`: contribution policy, with a link to the development runbook for setup.
- `SECURITY.md` (root or `.github/`, if applicable): how to report vulnerabilities and the
  supported scope.

## AGENTS.md should cover, where applicable
- Identity: what the project is and isn't.
- Hard boundaries: explicit prohibitions. Enumerate each exception with exact limits and
  state what it does NOT authorize. Point to the internals doc to read before changing one.
- Common ways to cause damage (killing processes by pattern, writing to live data, etc.).
- Dev servers and test data, if relevant.
- Verification: exact commands (confirm each one exists in scripts/Makefile) and which
  repo-wide checks not to run.
- PR and commit conventions, including "never commit or open PRs unless asked."
- Documentation rules (below).
- Where code lives: one line per package/directory.
- Taste/conventions that reviewers actually enforce.

## Documentation rules (put these in AGENTS.md under `## Documentation`)
- Most code changes need no doc change; agents can read the code.
- Internals hold decisions and hard-to-discover constraints. Before adding text, ask what a
  maintainer would get wrong without it. Don't list fields, narrate control flow, keep file
  catalogs, or append PR summaries. Put local explanations in code comments, and link to
  source rather than copying it.
- When a documented decision changes, rewrite or remove the old text. Don't append a second
  account. A new page needs a lasting reason to exist.
- User guides help users finish tasks, in the product's voice: what the feature does, how to
  start, and anything unintuitive. Don't describe obvious controls or every UI state.
- One source of truth per topic; link across files instead of duplicating. Where a fork or
  mirror could drift, name the source of truth explicitly.
- Never commit plans, research notes, or scratch files.
