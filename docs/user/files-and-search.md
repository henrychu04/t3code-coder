# Files and search

The Files panel in the right panel is a contained way to read and edit text files in the active
project — not a general window onto the workspace filesystem.

## Browsing and reading

Open the Files panel and browse the project tree. Each folder loads when opened, including
Git-ignored folders; ignored entries are dimmed. The tree skips symlinks and Git metadata. Large
folders show a limit notice after 1,000 inspected entries. Filename search continues to use the
separate path index, so ignored files can be browsed without adding them to search results.

Selecting a text file shows it in the preview.
Files up to 1 MiB can be opened fully; larger text files open truncated and read-only, and other
binary files are rejected rather than rendered as garbage.

Images, videos, and audio open in a media viewer instead: images up to 20 MiB, and videos and audio
up to 256 MiB. The file loads in full through the workspace connection when you open it. Right-click
media to save it or copy its path. PDF and HTML files are not previewed.

Path safety is enforced for you: files are always addressed relative to the project root, and
links that would escape the project — including through symlinks — do not resolve.

## Editing

Type in an opened text file to change it; edits save automatically shortly after you stop typing.
Saves are protected against clobbering work:

- If the file changed in the workspace after you opened it, the save is rejected instead of
  silently overwriting. A notice offers **Reload and discard edits** so you can start again from
  the current file.
- Saves replace the file atomically, so a half-written file never appears mid-save.
- Edits apply only to files that were fully readable to begin with; truncated read-only files
  cannot be edited.

Open files and editor state are kept in browser memory only. Whether the file explorer is shown
and whether Markdown and tables open rendered are remembered as display preferences in the
browser.

Right-click a file in the tree and choose **Copy path** to put its project-relative path on your
clipboard, or **Add to chat** to mention it in the composer.

## Comments

You can annotate lines in the file preview with comments, the same way you can comment on
[review diffs](./source-control.md#reviewing-changes) — handy for leaving Claude a precise note
about a spot in a file.

## Finding files

`mod+p` opens file search for the active project: type part of a filename to jump to it.
Repeating the shortcut closes the search.

## Finding text

`mod+shift+f` searches inside the project's files, with options to match case, match whole words,
or use a regular expression. The search is bounded: it returns matched lines with the match
highlighted, capped per file and at 500 matches per search, and notes when results stop short.
Binary files are skipped.

## CSV and TSV previews

Open a CSV or TSV file in Files and select **Show table** to see a table. Switch back with **Show source** to
read or edit the text. The table shows at most 100 rows and 30 columns, with cells limited to 2,000
characters. It uses the same bounded project-file read as the source editor, including the 1 MiB
file limit and project path checks.
