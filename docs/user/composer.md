# Messages and context

Messages can contain up to 120,000 characters. If a draft is longer, T3 Coder keeps it in the
composer and shows how many characters need to be removed. Shorten the draft or split it into
multiple messages, then send again in the same thread.

In an existing thread, scrolling a conversation that overflows the viewport can rest the composer
into one line. Losing focus does not collapse it, and multiline drafts remain expanded. Control
scroll collapse under **Settings → Preferences**. When the thread-context strip has room, the
model and mode controls remain available beside it; otherwise they return when the composer is
focused. Focus the composer or start typing to expand it again. New-thread layouts keep the full
composer.

Pasting plain text while the conversation itself is focused moves that text into the composer.
Paste remains with a terminal, menu, dialog, editor, or other interactive control when one of those
surfaces owns focus.

At phone-sized browser widths, existing threads animate between compact and expanded layouts.
Terminal context and other draft details return when the compact composer is expanded. Pasted
image thumbnails appear above the input; their workspace references are added when the message sends.

Attach up to 100 images per message. Each image can be up to 10 MiB, with at most 80 MiB of
images in one message. Provider and model limits still apply, including images already in the
conversation.

## Rich text and multiple models

The composer formats supported Markdown as you type. Turn off **Rich text composer** in
**Settings → Preferences** to show formatting markers literally. File mentions, skills, images,
terminal context, and review comments remain editable context chips in either mode.

In a new draft, select multiple models to send the same prompt to separate background threads.
Each selected model gets its own new worktree in the current Coder workspace. Select a base branch
before sending. The composer becomes available while those threads finish checkout and setup.
If a send fails, its model selection and prompt can be restored without replacing a newer draft.
When delivery is uncertain, open the reported thread before explicitly allowing a retry.

## Send while the agent is working

Choose **Settings → General → Follow-up behavior** to queue new messages for a later turn or
steer the running turn immediately. The setting applies to this browser; already queued messages
keep their place. Queued messages are saved in the workspace and can be edited, reordered, or
removed above the composer. `Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and Linux uses the
opposite action: it steers when your default is Queue and queues when your default is Steer.

Use `Cmd+Shift+Enter` on macOS or `Ctrl+Shift+Enter` on Windows and Linux to send the oldest queued
message as a steer. This leaves the current draft intact and requires an active turn that supports
steering. Change `thread.steerQueuedMessage` in **Settings → Keybindings** to use another shortcut.

Press `Option+Up` on macOS or `Alt+Up` on Windows and Linux with the cursor at the start of the
composer to edit the most recently queued message. Change `thread.editQueuedMessage` to use another
shortcut.

## Queued messages

The composer shows **Interrupt** while the agent is working and the draft is empty. Adding text or
images replaces it with a steer arrow. Click it to send a message into the active turn, or press
`Enter`. Hold `Cmd` on macOS or `Ctrl` on Windows and Linux to switch the button to a queue icon.
Click while holding that key, or press `Cmd+Enter` or `Ctrl+Enter`, to queue the message for after
the active turn.

Queued messages appear above the composer. Rows show a thumbnail of any attached image alongside
the text. Drag a row by its handle to reorder it, use the handle's arrow keys, promote the message
to a steer, or remove it.

If the workspace helper restarts, saved queued messages keep their order and are held. Press
**Resume** in an empty composer to continue. You can edit, reorder, or remove held messages without
starting them.

The pencil on a queued row opens that message in the composer for editing. The original message
stays in the queue until you save, and its row is highlighted while you edit. The message's images
appear above the text with a remove control, and new images can be added the usual way. The
checkmark saves the queued message in place; **Cancel** on its row leaves it unchanged. Whatever you
had typed in the composer before starting the edit is restored afterwards. If the queued message
starts or is removed while you are editing, the edit ends: changed content moves into the composer
when it is empty, and is discarded otherwise.

## Inline context

Review comments and pasted images appear as chips within the prompt alongside file mentions,
skills, and assistant citations. Select a review-comment chip to edit its text or inspect the
selected diff; the annotation in the diff viewer updates with it. Select an image chip to preview
its in-memory draft image. Deleting an image chip removes its inline placement; use **Remove** on
the thumbnail to omit the image from the message. If the prompt still references that image,
confirming removal removes both the thumbnail and its references.

In an existing thread, select a file mention to open the current file in **Files**. Skill chips
show their descriptions; **View instructions** opens the skill file when it is inside the
thread’s project or worktree.

Pasted plain-text fragments of at least 32,768 characters fold into a **Long text** chip. Select it to
read or edit the text. Folding keeps the full text in the prompt: it counts toward the message
limit and is sent to the provider as text. Unsent draft and stashed prompt text, including terminal
excerpts, is kept in browser storage. Image bytes stay in browser memory, including when moved
between threads or restored from a prompt stash. Image bytes, upload IDs, and credentials are never
saved in browser storage.

## Images

Paste an image straight into the composer to share it with Codex or Claude. PNG, JPEG, and WebP images up
to 50 MiB are accepted as sources and compressed to at most 10 MiB before upload. Unsupported
formats and images that cannot meet the upload limit are rejected before sending. The
image is validated, not just renamed, and is stored at a generated path inside the workspace so
the provider can read it. There are no general file attachments: images pasted into the composer are the
only upload.

Thumbnails appear above the input with queue and upload percentage indicators. You can keep editing
and pasting images during uploads; Send waits until all images are ready. Retry or remove failed
uploads. Click a thumbnail to open the gallery, or remove an image to cancel or omit it. Transfers
stay with the originating draft when you switch threads.

See [Images and screenshots](./images-and-screenshots.md) for the other direction — viewing
screenshots Codex or Claude produces during a turn.

## Terminal context

To give Claude the output of something you just ran, attach it from the terminal as context. The
composer shows attached terminal output as an inline chip, so you can review, move, or remove
it before sending.

## Commands and skills

Type `/` to open the command menu. Commands and skills discovered in the workspace appear here —
built-in Claude commands such as `/compact` as well as commands your project defines. Type `$` to
find and add a skill.

After you add or change skills, plugins, or configuration in the workspace, use **Restart agent
session** in the command palette. The conversation continues, and your next message starts the
agent again with the new setup. T3 Coder disables MCP servers for managed sessions.

## Recall a sent prompt

Press `ArrowUp` in an empty composer to recall the last prompt sent in this thread. Press it
again to go further back, and `ArrowDown` to move forward. Moving past the newest prompt clears
the composer. Recall uses only the prompts currently loaded in the thread and restores text,
not pasted images, terminal context, or appended review comments. Pending questions, approvals,
and attached terminal context keep their normal keyboard behavior.

In an unedited recalled prompt, recall works from the first visual line with `ArrowUp` or the
last visual line with `ArrowDown`, including wrapped lines. Elsewhere the keys move the caret.
Editing a recalled prompt turns it into a normal draft. Recall is derived from loaded conversation
messages; it does not keep a separate prompt-history store in the browser.

## Edit an earlier prompt

Choose **Edit from here** beneath a sent message to rewind to before that message. Choose
**Revert and keep changes** to leave workspace files as they are, or **Revert files too** to
restore the checkpoint as well. File restore is only offered for threads running in a worktree, and
it is refused when another thread or agent session also uses that directory, a folder inside it,
or a folder that contains it, since restoring would erase their changes. Project-directory threads
rewind conversation history only. The selected prompt and its pasted images return to the composer
for editing and resending, below any unsent draft.

Rewind removes the selected message and later conversation from the active thread and provider
history. It does not undo external actions or separate provider memory. The action is available
only when the provider supports rewind.

## Prompt stash

Press `mod+s` to stash the current draft and start a clean composer. When the composer is empty and
the stash contains exactly one entry, the same shortcut restores it directly; otherwise restore an
entry from the stash menu. This is useful when a long prompt is blocked on something else — stash
it, ask your question, then bring it back.

The stash is per-browser and holds up to 20 entries. Its text, including terminal excerpts, survives
a reload in browser storage. Wait for uploads to finish before stashing. Pasted images and their
previews move with the prompt in browser memory. Restoring an entry into another workspace uploads
its pasted images to that workspace before sending. Legacy file links
remain workspace-specific and show a warning when restored elsewhere.

## Model and mode

The model picker in the composer sets the model for the thread; open it with `mod+shift+m`. When
the picker is open, `mod+1` through `mod+9` jump straight to a model. The permission mode control
sits next to it — see [Permission modes](./permission-modes.md).

## Model defaults

T3 Coder remembers your provider, model, and model options for new threads. A project’s configured
model takes precedence; resetting that project setting returns to the remembered selection.
Creating a project does not set a project model default.

Only explicitly chosen model options are sent. Leaving reasoning level or service tier unset uses
the provider’s own configuration in the workspace.

## Context meter

The context meter stays visible in the composer footer and shows how much of the selected
provider's context window the conversation uses. As Codex or Claude threads grow old and large,
T3 Coder offers to compact the conversation into a summary before you continue; you can also start
compaction yourself from the meter. Compaction runs through the workspace provider session,
summarizes history without changing the model's context window, and remains visible in the
conversation even when it is the only activity in that turn.

Compacting from the context meter preserves the current draft and its images. You can also send
`/compact` in an existing conversation when the provider supports it.

## Response streaming

Under **Settings → Preferences**, choose **Completed turn**, **Completed paragraphs**, or
**Live tokens**. Completed paragraphs is the default and also waits for complete code blocks.
Projects can override this preference on their settings page. The former legacy-token-streaming
switch is replaced by this setting; upgrading starts in paragraph mode unless the new setting
has already been chosen.

Questions and text answers appear together in the work log, at the question's original position.
Expand the row to read the full question and answer; unanswered questions are marked accordingly.

## Inline context and merge requests

Terminal excerpts, review comments, images, and long pasted text appear as chips inside your
message. Type around them, move them within the composer, or delete them like a character. Undo
restores removed context. Select a terminal chip to read its captured output. Image chips show
size and upload progress; review-comment chips show formatted comments and highlighted source. Existing drafts keep their saved context when opened in the rich-text
editor. Large pasted text stays inline prompt content; it does not create a file attachment.

Type `#` to browse recent GitLab merge requests in the current project's repository. Add digits
to match any part of a merge-request number. A complete number is also looked up directly, so
older merge requests can be found outside the recent list. Add a single word, such as `#login`,
to search by text.

A merge-request chip shows its number and the state captured when you attached it: open, draft,
merged, or closed. Hover to inspect the captured title and branches. Select it to open the
merge request in T3 Coder. The captured details remain part of the message after sending.

Another thread can be context too. Type `@` followed by part of its title to pick one from the same
workspace, or drag a thread out of the sidebar and drop it on the composer; a multi-selection drops
together. The chip shows the thread's current title and opens it when selected. Your prompt only
carries a reference: the agent reads the thread's history on demand, so attaching a long thread
costs nothing until the agent looks. Attaching a thread does not change it, and the agent cannot
send messages to it unless you ask.

## Run shell code blocks

Completed shell code blocks in agent messages offer **Run**. It opens a terminal in the thread's
workspace folder and runs the command there. Code never runs until you choose this action.
