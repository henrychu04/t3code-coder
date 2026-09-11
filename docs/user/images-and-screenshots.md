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
with their originating draft when you switch threads. Moving a draft to a project in another
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

Images appear beside the tool activity that viewed or produced them. Assistant replies can also
embed a captured image inline or link to it. Click a thumbnail or image link to enlarge it. The
shared gallery supports previous/next arrows, left/right keys, zooming, and panning. When zoomed,
arrow keys pan the image; use the gallery buttons to switch images.

Inline images preserve their reported dimensions and share a gallery in message order. If an image
fails to load, use **Retry**. Repeated previews share one read; the browser loads at most three images
at once and bounds retained image bytes to 100 MiB. Image bytes are released when no displayed preview uses them.

Submitted messages retain their image previews after reload or reconnect, while the workspace
copies exist. Unsent draft images still disappear on reload.

T3 preserves supported image bytes returned by tools and images viewed inside the active project,
including existing files. These preserved copies remain available if the original project file is
later changed or deleted. For tools reporting only a path, capture happens immediately after the
event, so a concurrent file change can still affect which version is saved. Merely writing an image
file does not add it to the conversation.

At most ten unique PNG, JPEG, or WebP images of up to 20 MiB are preserved per turn. Repeated views
reuse the same copy. The activity shows a notice when an image could not be preserved or the limit
was reached. This is not a guarantee that every image visible to a provider is captured.

Images stay in the Coder workspace. There are no save, export, or download actions, and external
images are not loaded. Unrecognized image references show an unavailable explanation. Older
conversations with a Visual artifacts activity can still display their saved images.

The thumbnail and gallery interactions follow [upstream's image previews](https://github.com/pingdotgg/t3code/blob/8d8189e67/docs/user/composer.md#images-and-videos-in-messages), adapted to preserve workspace copies and use Coder-only transport.
