# Keyboard shortcuts

Edit shortcuts from **Settings → Keyboard shortcuts**. The page lists every command, its current
shortcut, whether it is a default or your own, and warns about conflicts.

Your shortcuts are stored in the workspace, so they follow your work rather than the browser you
happen to be using. The page needs a workspace connection to save; if saving fails, reconnect and
try again.

## Defaults

`mod` means `cmd` on macOS and `ctrl` on Windows and Linux.

| Shortcut         | Command                                |
| ---------------- | -------------------------------------- |
| `mod+k`          | Command palette                        |
| `mod+b`          | Toggle sidebar                         |
| `mod+alt+b`      | Toggle right panel                     |
| `mod+j`          | Toggle terminal                        |
| `mod+p`          | Search project files                   |
| `shift` `shift`  | Search project files (project open)    |
| `mod+shift+f`    | Find text in project                   |
| `mod+f`          | Find in current file                   |
| `mod+g`          | Go to line and column                  |
| `mod+d`          | Toggle diff (or split terminal, when the terminal has focus) |
| `mod+s`          | Stash composer draft                   |
| `mod+n`          | New thread                             |
| `mod+shift+o`    | New thread                             |
| `mod+shift+n`    | New thread in current project          |
| `mod+shift+m`    | Open model picker                      |
| `mod+1`…`mod+9`  | Go to thread *n*                       |
| `mod+shift+[`    | Previous thread                        |
| `mod+shift+]`    | Next thread                            |
| `mod+shift+s`    | Settle or un-settle current thread     |
| `mod+shift+p`    | Pin or unpin current thread            |

When the terminal has focus, `mod+n` opens a new terminal and `mod+w` closes the current one;
`mod+shift+d` splits the terminal vertically.

When the model picker is open, `mod+1`…`mod+9` choose the *n*-th model instead of jumping to a
thread.

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
