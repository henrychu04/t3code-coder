# Keyboard shortcuts

Edit shortcuts from **Settings → Keyboard shortcuts**. The page lists every command, its current
shortcut, whether it is a default or your own, and warns about conflicts.

Your shortcuts are stored in the workspace, so they follow your work rather than the browser you
happen to be using. The page needs a workspace connection to save; if saving fails, reconnect and
try again.

## Defaults

`mod` means `cmd` on macOS and `ctrl` on Windows and Linux.

| Shortcut        | Command                                                      |
| --------------- | ------------------------------------------------------------ |
| `mod+k`         | Command palette                                              |
| `mod+b`         | Toggle sidebar                                               |
| `mod+alt+b`     | Toggle right panel                                           |
| `mod+j`         | Toggle terminal                                              |
| `mod+p`         | Search project files                                         |
| `shift` `shift` | Search project files (project open)                          |
| `mod+shift+f`   | Find text in project                                         |
| `mod+f`         | Find in current file                                         |
| `mod+g`         | Go to line and column                                        |
| `mod+d`         | Toggle diff (or split terminal, when the terminal has focus) |
| `mod+s`         | Stash composer draft                                         |
| `mod+n`         | New thread                                                   |
| `mod+shift+o`   | New thread                                                   |
| `mod+shift+n`   | New thread in current project                                |
| `mod+shift+m`   | Open model picker                                            |
| `mod+1`…`mod+9` | Go to thread _n_                                             |
| `mod+shift+[`   | Previous thread                                              |
| `mod+shift+]`   | Next thread                                                  |
| `mod+shift+s`   | Settle or un-settle current thread                           |
| `mod+shift+p`   | Pin or unpin current thread                                  |

When the terminal has focus, `mod+n` opens a new terminal and `mod+w` closes the current one;
`mod+shift+d` splits the terminal vertically.

When the model picker is open, `mod+1`…`mod+9` choose the _n_-th model instead of jumping to a
thread.

`thread.stop` interrupts the running turn in the focused thread. It has no default shortcut;
assign one in **Settings → Keyboard shortcuts**.

## How rules work

A shortcut is a rule with three parts:

- `key` — the shortcut string, like `mod+j` or `ctrl+shift+d`
- `command` — the command to run
- `when` — optional condition controlling when the shortcut is active

### `when` conditions

`when` is an expression evaluated against the current UI state. Available keys include
`terminalFocus`, `terminalOpen`, `fileOpen`, `fileViewerFocus`, `projectOpen`, and
`modelPickerOpen`. Combine them with `!`, `&&`, `||`, and parentheses:

- `terminalFocus` — only while the terminal has focus
- `!terminalFocus` — everywhere except the terminal
- `terminalOpen && !terminalFocus` — terminal is visible but does not have focus

A condition the current screen cannot evaluate is false.

### Precedence

Rules are evaluated in order and the last matching rule wins — including across different
commands. That is how the defaults above work: a later rule for one command can take a key away
from an earlier rule for another, depending on context. The settings page warns when your rules
conflict with each other or with a default.

## Command palette

`mod+k` opens the command palette (when the terminal does not have focus). It searches commands
and your threads' messages, so it doubles as a way to find that thing Claude said earlier.

The authoritative command list is always the one in **Settings → Keyboard shortcuts** for the
build you are running — use that rather than any copied table.

## Copy the current reference

**Cmd+Shift+C** on macOS or **Ctrl+Shift+C** on Windows runs `thread.copyReference` outside terminal
focus. It copies the visible merge request's link first, then the thread's linked or discovered
merge-request link, then the thread ID. On the merge-request page it copies only the selected MR's
link. If that panel's URL is still unavailable, the copy action is unavailable until the URL resolves; it never substitutes a different reference. The command palette also offers this action.

## Composer controls

Use `mod+shift+m` to choose a model, `mod+shift+h` for the Coder workspace,
`mod+shift+e` for effort, `mod+shift+a` for permissions, `mod+shift+x` for checkout mode,
and `mod+shift+g` for the Git branch. Use `mod+shift+l` to reuse the previous worktree.

In the model picker, Left in an empty search field or Shift+Tab reaches the provider list.
Up/Down moves, Enter chooses, and Right returns to search. `mod+shift+up` and
`mod+shift+down` switch providers directly and clear the search.

With a merge request open, `mod+shift+c` copies its URL and `mod+shift+k` copies its number
with a `#` prefix. These shortcuts leave terminal input alone and can be changed in Settings.

## Selected workspaces

The displayed bindings come from the representative workspace. Add, edit, remove, and reset apply
to every selected connected workspace. A failed save keeps successful changes in the other
workspaces; reconnect and retry. Reset uses each workspace's own current rules.

You can configure **Stop current thread**, **Pin or unpin current thread**, and **Copy MR URL or
thread ID**. Stop has no default shortcut.

## Project actions

Saved project actions appear as **Run project action: name**. Assign a shortcut to run that action
in a new terminal in the active thread's checkout or worktree. The thread must already exist in the
workspace. Commands use the active project's effective actions, including inherited workspace
defaults. Bindings use `script.{id}.run`, so matching action IDs in different projects run each
project's own command. Legacy action IDs that cannot be represented as a shortcut remain editable.

New action shortcuts default to `!terminalFocus` so they do not intercept terminal input.
