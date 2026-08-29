# Images and screenshots

Images move in two directions: you paste them into the conversation, and Claude can produce
screenshots during a turn that you can view. Both are bounded and validated; neither creates a
general file-transfer path.

## Pasting images into a message

Paste an image directly into the composer. PNG, JPEG, and WebP up to 20 MiB are accepted, and the
content is validated before upload — an image that merely claims to be a PNG is not enough.

The image is copied into the workspace under a generated filename (you cannot choose the path)
and the message references it there, where Claude can open it. The local temporary copy is deleted
as soon as the transfer finishes, either way it goes.

There is deliberately no drag-and-drop, no file picker for uploads, and no download path — paste
into the composer is the only way an image gets in.

## Viewing Claude's screenshots

When a Claude turn produces screenshots — for example while Claude verifies a frontend it is
building — T3 Coder collects them as **visual artifacts** for that turn. This needs no MCP server
and no changes to your project's setup.

After (or during) the turn, an artifacts row appears on the message showing how many images were
captured. Expand it to see thumbnails and open any image full size. Details:

- At most 10 images are captured per turn; duplicates by content are collapsed.
- Images larger than 20 MiB are skipped.
- Viewing streams the image from the workspace on demand and holds it only in browser memory. It
  is never saved to your computer, and there is no download or export action.

Like everything else, the artifacts live in the workspace and disappear with it — your machine
stays out of the picture.
