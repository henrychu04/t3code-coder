# Files and search

The Files panel in the right panel reads and edits text files in the active project, and opens
other workspace files that a message links to.

## Browsing and reading

Open the Files panel and browse the project tree. Each folder loads when opened, including
Git-ignored folders; ignored entries are dimmed. The tree skips symlinks and Git metadata. A
folder lists at most its first 5,000 entries. Filename search continues to use the separate path
index, so ignored files can be browsed without adding them to search results.

Selecting a text file shows it in the preview.
Files up to 1 MiB can be opened fully; larger text files open truncated and read-only, and other
binary files are rejected rather than rendered as garbage.

Images, videos, and audio open in a media viewer instead: images up to 20 MiB, and videos and audio
up to 256 MiB. The file loads in full through the workspace connection when you open it. Right-click
media to save it or copy its path.

PDF and HTML files in the project open as documents: PDFs (up to 50 MiB) in the browser's PDF
viewer, and HTML files (up to 10 MiB) as a page you can switch to its source. A page runs in a
sandbox away from T3 Coder and your session, and its links open in new tabs; images or styles it
references by relative path do not load.

Project files are addressed relative to the project root. A file link with an absolute or `~/`
path elsewhere in the workspace, such as a report an agent wrote to a temporary folder, opens that
file read-only in the panel; a linked folder opens as a read-only tree.

## Editing

Type in an opened project file to change it; edits save automatically shortly after you stop
typing. A save writes your version of the file, so if an agent or a terminal changed the file
while you were editing, the save replaces that change. Truncated files and files outside the
project are read-only.

Open files and editor state are kept in browser memory only. Whether the file explorer is shown
and whether Markdown and tables open rendered are remembered as display preferences in the
browser.

Right-click a file in the tree and choose **Copy path** to put its full workspace path on your
clipboard, **Copy mention** to copy it as a composer mention, or **Add to chat** to mention it in
the composer. You can also drag files from the tree into the composer.

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
file limit.
