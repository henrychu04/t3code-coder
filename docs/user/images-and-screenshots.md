# Images and screenshots

Images move in two directions: you paste them into the conversation, and Codex or Claude can produce
screenshots during a turn that you can view. Both are bounded and validated; neither creates a
general file-transfer path.

## Pasting images into a message

Paste an image directly into the composer. PNG, JPEG, and WebP up to 20 MiB are accepted, and the
content is validated before upload — an image that merely claims to be a PNG is not enough.

Pasted images appear as thumbnails above the chat input. You can continue editing and pasting more
images while transfers run. At most eight images can be attached to a message, including queued and
failed uploads. Thumbnails show **Queued**, a percentage while sending bytes to the local gateway,
remaining at **100%** until the workspace transfer is confirmed. Send waits until every
image is ready. Failed images stay in the draft with a **Retry** action; retry or remove them before
sending.

Click a thumbnail to open the gallery and use its arrows or the left/right arrow keys to move between
images. The compact composer shows up to three thumbnails with a count for the rest. Removing a
queued image prevents its transfer; removing an active image cancels that transfer. Uploads stay
with their originating draft when you switch threads. Image references in your prompt stay attached
to the same image when you move a draft or restore a stash in another workspace. Moving a draft to a project in another
workspace re-uploads the original images there; Send waits for those uploads.

Images stay separate from the text while composing. They can be sent without accompanying text and
move with the prompt when stashed. Draft images and their previews stay in browser memory only and
are lost on page reload.

The image is copied into the workspace under a generated filename (you cannot choose the path)
and the message references it there, where the model can open it. The local temporary copy is deleted
as soon as the transfer finishes, either way it goes.

There is deliberately no drag-and-drop, no file picker for uploads, and no download path — paste
into the composer is the only way an image gets in.

## Images in agent messages

Select an image or image link to open its preview. The gallery supports previous/next arrows,
keyboard navigation, zooming, and panning. When zoomed, arrow keys pan the image; use the gallery
buttons to switch images. Expand an image-view tool activity to preview the file it names.

Like main, previews read the original file on the environment's machine. An assistant can generate,
copy, or rename an image and embed its final project path without viewing it first or publishing it
through another tool. Relative paths and absolute paths inside the active project work. Supported
formats are PNG, JPEG, and WebP, up to 20 MiB per image.

A fresh read shows the current file. Moving or deleting it can break its preview, and editing it can
change what you see in an older conversation. Keep the source file if you need the preview later.
T3 no longer creates screenshot artifact copies or matches Markdown against turn captures. Images
returned only as tool bytes, without a project file path, do not get a separate preview.

If an image fails to load, use **Retry image**. File changes during a chunked read reject that read;
retry starts again with the current file. Inline previews load near the viewport and release their
bytes when scrolled away. Repeated previews share a read. The browser permits three concurrent image
reads and bounds retained image bytes to 100 MiB. Opening the gallery gives its selected image
priority, including when other previews have been deferred. Closing it returns keyboard focus to
the opener.

There is no per-turn preview count limit, total storage quota, or automatic purge. Images stay in
the project and workspace cleanup is user-controlled. Submitted image attachments still use their
workspace copies and survive reload while those copies exist; unsent drafts disappear on reload.

Older conversations can still display their previously saved artifacts. Those legacy copies live
in `$HOME/.t3-coder/artifacts`, outside worktrees; deleting a worktree does not delete them.

The flow follows [main's image previews](https://github.com/henrychu04/t3code-coder/blob/f328db30da063a7bce9a9d038fc583d3ff83673a/docs/user/composer.md#images-and-videos-in-messages).
Coder-specific differences are project-contained image access, bounded helper stdio transport,
paste-only uploads, and no external images, videos, save, export, or download actions.
