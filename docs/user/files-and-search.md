# Files and search

The Files panel in the right panel is a contained way to read and edit text files in the active
project — not a general window onto the workspace filesystem.

## Browsing and reading

Open the Files panel and browse the project tree. Selecting a text file shows it in the preview.
Files up to 1 MiB can be opened fully; larger text files open truncated and read-only, and binary
files are rejected rather than rendered as garbage.

Path safety is enforced for you: files are always addressed relative to the project root, and
links that would escape the project — including through symlinks — do not resolve.

## Editing

Switch an opened file to edit mode to change it. Saves are protected against clobbering work:

- If the file changed on disk after you opened it, the save is rejected instead of silently
  overwriting — reopen, reapply your change, and save.
- Saves replace the file atomically, so a half-written file never appears mid-save.
- Edits apply only to files that were fully readable to begin with; truncated read-only files
  cannot be edited.

Open tabs and editor state are kept in browser memory only. They are not persisted — after a
reload you start from a clean slate.

Use **Copy path** on a file to put its project-relative path on your clipboard, for example to
reference it in a prompt.

## Comments

You can annotate lines in the file preview with comments, the same way you can comment on
[review diffs](./source-control.md#reviewing-changes) — handy for leaving Claude a precise note
about a spot in a file.

## Finding files

`mod+p` opens file search for the active project: type part of a filename to jump to it. When a
project is open, pressing `shift` twice does the same. Repeating the shortcut closes the search.

## Finding text

`mod+shift+f` searches inside the project's files. Enter your query and, optionally, a **file
mask** to narrow the search — `*.ts`, `src/**/*.css`, and similar patterns. The search is bounded:
it returns matched lines with the match highlighted, capped per file and per search, and you can
page through results. Binary files are skipped.

`mod+f` finds within the currently open file, and `mod+g` jumps to a line and column.
