# Threads from older T3 Coder versions

Each workspace keeps its threads in `~/.t3-coder/userdata`. The first time a newer workspace helper
starts, it copies the older database, `state.sqlite`, into `statev2.sqlite` in the same directory
and migrates the copy. Your threads appear automatically, with full transcripts imported as needed.
You do not need to run an import command.

The older database stays in place untouched; the newer helper uses only the copy. The copy happens
once per workspace: later conversations do not sync back to `state.sqlite`. Settings, attachments,
and workspace files remain shared.

The migrated thread keeps its title, project, provider and model selection, permission and
interaction modes, branch or worktree, archive state, settlement state, snooze and pin state, and
linked pull request. T3 Coder also brings over user and assistant messages, their timestamps, and
supported attachments. Large histories may appear in stages while the workspace helper imports transcripts.

The migration does not recreate the old provider's live session. It also does not convert old run
records, checkpoints and diffs, tool activity, approval history, or proposed plan history into the
new format. These items may be absent from a migrated timeline even though the conversation text is
present.

## Continuing a migrated thread

The first new message starts a fresh provider session. T3 Coder selects intact user and assistant
messages using the same [handoff budget](./portable-handoffs.md) as a provider switch. Omitted text
remains in the thread and can be retrieved by the agent. The migration retains its separate
32,000-character recovery excerpt; neither that excerpt nor the handoff replaces the full imported
transcript.

Before continuing a long or important thread, read the recent transcript and include any older
requirements the agent still needs in your next message. Starting a new thread and pasting a short
handoff is also a good choice when the old conversation contains conflicting instructions.

## Keeping a recovery copy

T3 Coder does not have a whole-thread export command. Before a major update, close T3 Coder and,
from a workspace terminal, copy `~/.t3-coder/userdata` to a safe location in the workspace. A helper
started with `T3_CODER_HOME=<path>` uses `<path>/userdata` instead.

If a migrated transcript is missing from the app, keep that copy unchanged. You can inspect the
old transcript without starting T3 Coder against it:

```sh
sqlite3 -readonly /path/to/recovery-copy/state.sqlite
```

At the SQLite prompt, list recent legacy threads:

```sql
.headers on
.mode tabs
SELECT thread_id, title, updated_at
FROM projection_threads
ORDER BY updated_at DESC;
```

Then print one transcript, replacing `<thread-id>` with the value from the first query:

```sql
SELECT role, text, created_at
FROM projection_thread_messages
WHERE thread_id = '<thread-id>'
  AND role IN ('user', 'assistant')
ORDER BY created_at, message_id;
```

Open only the copied database. Do not edit it or point a newer or older helper at your recovery
copy. Make and inspect the copy inside the workspace; T3 Coder keeps no thread data on your
computer.
