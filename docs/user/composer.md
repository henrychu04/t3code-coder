# Message composer

Messages can contain up to 120,000 characters. If a draft is longer, T3 Coder keeps it in the
composer and shows how many characters need to be removed. Shorten the draft or split it into
multiple messages, then send again in the same thread.

In an existing thread, the composer settles into a single-line resting state when it loses focus.
At wider sizes, scrolling the conversation also rests a focused composer, except when scrolling
toward the end while already there. When the thread-context strip has room, the model and mode
controls remain available beside the thread context; otherwise they return when the composer is
focused. Focus the composer or start typing to expand it again. New-thread layouts keep the full
composer.

At phone-sized browser widths, existing threads animate between compact and expanded layouts.
Terminal context and other draft details return when the compact composer is expanded. Pasted
images remain workspace-scoped links in the prompt, consistent with T3 Coder's Coder-only image
boundary.

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

## Commands and skills

Type `/` to open the command menu. Commands and skills discovered in the workspace appear here —
built-in Claude commands such as `/compact` as well as commands your project defines. Type `$` to
find and add a skill.

## Prompt stash

Press `mod+s` to stash the current draft and start a clean composer. Restore the entry later from
the stash menu. This is useful when a long prompt is blocked on something else — stash it, ask
your question, then bring it back.

The stash is per-browser and holds up to 20 entries. Pasted images are workspace file links, so
they ride along in the prompt text; restoring an entry into another workspace warns that its
image links may not resolve there.

## Model and mode

The model picker in the composer sets the model for the thread; open it with `mod+shift+m`. When
the picker is open, `mod+1` through `mod+9` jump straight to a model. The permission mode control
sits next to it — see [Permission modes](./permission-modes.md).

## Context meter

The context meter shows how much of Claude's context window the conversation uses. As threads grow
old and large, T3 Coder offers to compact the conversation into a summary before you continue; you
can also start compaction yourself from the meter. Compaction summarizes history without changing
the model's context window.
