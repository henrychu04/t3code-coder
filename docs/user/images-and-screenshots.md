# Images and screenshots

Images move in two directions: you attach them to the conversation, and Codex or Claude can produce
screenshots during a turn that you can view. Both are bounded and validated; neither creates a
general file-transfer path.

## Attaching images to a message

Paste into the composer, drag images onto the conversation, or select **Attach images** to choose
files. PNG, JPEG, and WebP source files up to 50 MiB are accepted. Like main, images up to 10 MiB
are sent unchanged; larger images are automatically resized to fit 10 MiB before upload. Resizing
uses WebP where supported, with JPEG as a fallback, and updates the thumbnail to the prepared image.
The tile shows **Resizing…** while preparation runs. Unreadable images or images that cannot fit
stay in the draft with a retry/remove action. The gateway independently validates size and signature.

Attached images appear as thumbnails above the chat input. You can continue editing and adding more
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
move with the prompt when stashed. Draft images and stashed prompts survive a page reload in
browser storage, as on main.

The image is copied into the workspace under a generated filename (you cannot choose the path)
and the message references it there, where the model can open it. The local app streams the
upload to the workspace through the Coder CLI without writing a copy to disk.

Paste, drop, and the image picker use the same upload queue. Unsupported files are rejected with
an explanation.

## Images in agent messages

Select an image or image link to open its preview. The gallery supports previous/next arrows,
keyboard navigation, zooming, and panning. When zoomed, arrow keys pan the image; use the gallery
buttons to switch images. Expand an image-view tool activity to preview the file it names.

Like main, previews read the original file on the environment's machine. An assistant can generate,
copy, or rename an image and embed its final file path without viewing it first or publishing it
through another tool. Relative paths resolve from the active project; absolute paths, `~/` paths,
and symlinks can point to images elsewhere on the workspace machine. They never refer to files on
your local computer. Previews load through short-lived signed links that the local app serves from
the workspace, so videos stream and seek as on main. Images and videos hosted on the web load
directly from their site.

Right-click an image or video to save it, copy its path or URL, open it in the Files panel, or copy
an image. Saving works for files on the workspace machine once they have loaded, and for media
hosted on the web when its site allows browser access. Playback depends on your browser; save a
video it cannot play to open it in another app.

A fresh read shows the current file. Moving or deleting it can break its preview, and editing it can
change what you see in an older conversation. Keep the source file if you need the preview later.
T3 no longer creates screenshot artifact copies or matches Markdown against turn captures. Images
returned only as tool bytes, without a file path, do not get a separate preview.

Your browser may keep loaded images in its cache for up to an hour, as on main, so scrolling back
does not load them again. Video and audio are never cached.

There is no per-turn preview count limit, total storage quota, or automatic purge. Source files stay
where you placed them and workspace cleanup is user-controlled. Submitted image attachments use their
workspace copies and survive reload while those copies exist; unsent drafts disappear on reload.

Conversations from before the current orchestration no longer show the screenshots they saved.
Those legacy copies stay in `$HOME/.t3-coder/artifacts`, outside worktrees, until you remove
them; opt-in saved-artifact retention under **Settings → Maintenance** can delete expired copies.
Retention is off by default and excludes submitted attachments and current workspace source images.

The flow follows [main's image previews](https://github.com/henrychu04/t3code-coder/blob/f328db30da063a7bce9a9d038fc583d3ff83673a/docs/user/composer.md#images-and-videos-in-messages).
Attachment sizing follows main. The Coder-specific difference is the transport: the local app
answers each signed link by streaming the file from the workspace over the Coder CLI.
