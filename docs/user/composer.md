# Message composer

Messages can contain up to 120,000 characters. If a draft is longer, T3 Coder keeps it in the
composer and shows how many characters need to be removed. Shorten the draft or split it into
multiple messages, then send again in the same thread.

## Images

Paste an image straight into the composer to share it with Claude. PNG, JPEG, and WebP images up
to 20 MiB are accepted; anything else — or anything larger — is rejected before it is sent. The
image is validated, not just renamed, and is stored at a generated path inside the workspace so
Claude can read it. There are no general file attachments: images pasted into the composer are the
only upload.

See [Images and screenshots](./images-and-screenshots.md) for the other direction — viewing
screenshots Claude produces during a turn.

## Terminal context

To give Claude the output of something you just ran, attach it from the terminal as context. The
composer shows attached terminal output as a chip above your message, so you can review or remove
it before sending.
