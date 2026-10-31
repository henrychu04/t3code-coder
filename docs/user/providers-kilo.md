# Kilo Code

T3 Coder can use the Kilo Code CLI installed in your Coder workspace. It runs Kilo Code's ACP
command (`kilo acp`) through upstream T3 Code's ACP provider, so Kilo Code brings its own models,
tools, and sign-in, while T3 Coder provides projects, threads, checkpoints, and task delegation.
Kilo Code runs only in the workspace; T3 Coder never installs it or asks for its credentials.

## Set Up Kilo Code

1. Install the Kilo Code CLI in the Coder workspace, usually through its template, so `kilo` is on
   the workspace's `PATH`.
2. Run `kilo` once in a workspace terminal and finish the sign-in or API-key setup you normally
   use. Kilo Code keeps it in its own workspace configuration.
3. Open **Settings → Providers**, enable Kilo Code, and refresh the provider. To add another
   instance, select **Add provider** and choose **Kilo Code**.

A workspace can connect with Kilo Code alone; Claude Code, Codex, and Pi are optional.

If `kilo` is not on the workspace's `PATH`, set **Kilo executable** to its absolute path. T3 Coder
launches it directly with `acp`, without expanding shell expressions.

If Kilo Code reports that it is not signed in, sign in to Kilo Code in a workspace terminal and
refresh the provider. T3 Coder has no Kilo Code sign-in or sign-out of its own.

## Models and options

The model picker lists the models Kilo Code reports. If it reports none, or hides some, add your
own model IDs under **Custom models** in the instance settings.

Other settings Kilo Code offers, such as reasoning effort or its mode, appear in the composer's
model options menu like they do for the other providers. Kilo Code's own plan and build modes
follow T3 Coder's Plan and Build toggle. Models and options that change while Kilo Code is running
update the picker without waiting for another provider probe.

## Commands and skills

Slash commands Kilo Code provides appear under **Provider** in the `/` menu while a session is
running. Commands it names with a `$` prefix appear in T3 Coder's `$` skill menu instead.

## Native sessions

To resume a conversation you started with Kilo Code outside T3 Coder, open the Kilo Code
instance under **Settings → Providers**, choose a project, and select **List sessions**.
Importing one creates a deterministic T3 thread backed by that Kilo Code session. Importing the
same session again returns the existing thread, including when another client performs the import.

The thread keeps the session's title and last-update value as provider metadata without
overwriting a title you set in T3 Coder. Kilo Code sessions cannot be deleted from T3 Coder; manage
them with Kilo Code in the workspace.

## Permissions and terminals

Kilo Code reads files, edits, and runs commands itself, under its own sandbox and approval rules.
It starts in its own default mode, and its mode picker in the model options menu switches it.

When Kilo Code asks for approval, T3 Coder answers by the thread's
[permission mode](./permission-modes.md): **Supervised** shows the request in the conversation,
**Auto-accept edits** approves edits and shows the rest, and **Auto** and **Full access** approve
automatically. File reads and searches never wait for approval. T3 Coder shows the commands,
output, and exit status Kilo Code reports but does not run or stop its terminals.

Kilo Code can use T3 tools, such as delegated tasks and scheduled work, through the thread's T3
tool command, which T3 Coder describes in the first prompt of each thread.

## Checkpoints

Checkpoint rollback restores your files as usual. Kilo Code cannot rewind its own conversation
over ACP, so the next turn after a rollback starts a fresh Kilo Code session that no longer
remembers the conversation from before the checkpoint.

Kilo Code instances are not used for T3 Coder's own text generation, such as thread titles,
commit messages, branch names, or merge request descriptions. Configure Codex, Claude Code, or
Pi for those actions.
