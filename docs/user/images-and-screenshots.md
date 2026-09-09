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

## Viewing model screenshots

When a Codex or Claude turn produces screenshots — for example while the model verifies a frontend
it is building — T3 Coder collects them as **visual artifacts** for that turn. This needs no MCP server
and no changes to your project's setup.

At the end of the turn, a **Visual artifacts** row appears in the conversation showing how many
images were captured. Expand it to see thumbnails and click an image to open the larger viewer.
Use its arrows to move between images. Details:

- Screenshots saved inside the active project during the turn are collected automatically. Images
  returned directly by supported provider tool results use the same capture pipeline. Existing
  images merely opened by the model, and files saved outside the project, are not collected.
- At most 10 images are captured per turn; duplicates by content are collapsed.
- Images larger than 20 MiB are skipped.
- Viewing streams the image from the workspace on demand and holds it only in browser memory. It
  is never saved to your computer, and there is no download or export action.

Like everything else, the artifacts live in the workspace and disappear with it — your machine
stays out of the picture.
