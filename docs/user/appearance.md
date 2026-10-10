# Appearance and themes

Open **Settings → Appearance** to choose a theme and follow the system appearance or stay in light
or dark mode. To use different themes for light and dark mode, select the corresponding preview
within each theme. Appearance preferences are saved separately in each browser.

Use **Change theme** in the command palette to select a theme without leaving chat.
Press **Cmd+Option+A** on macOS or **Ctrl+Alt+A** on Windows/Linux to open the theme picker directly.
Use **Change appearance** in the command palette to choose System, Light, or Dark independently of
the theme. **Cmd+Option+Shift+A** on macOS or **Ctrl+Alt+Shift+A** on Windows/Linux cycles through
those modes. Customize these shortcuts under **Settings → Keybindings**.

## Composer context

Git-backed projects show branch and worktree controls below the composer while you create a thread.
The controls retreat as the composer docks after you send the first message.

Turn on **Composer context** to keep those controls visible after the thread starts.

## Motion

The main sidebar, right panel, and terminal drawer open and close immediately by default. Move the
**Panel animations** slider above 0 ms to add motion, up to 400 ms, unless reduced motion is enabled
in your operating system. Moving between threads always snaps to the selected thread's panel state
without replaying its transitions.

## Custom themes

Choose **Create theme** to adjust a palette, or **Add theme** to import T3 Code or VS Code theme
JSON files. Pick or drop the files, or paste their JSON; several files import together, and VS Code
light and dark variants of one theme are paired. The browser reads the files itself and keeps the
imported themes with your other appearance preferences; nothing is sent to the workspace. The
theme editor's color picker lets you select an area of the app to find the color to change.
Export your theme as JSON to share it.

## Workspace themes

A connected workspace can publish themes for every browser that connects to it. Select a published
theme in **Settings → Appearance** to follow its palette as the workspace updates it.
**Duplicate** makes an independent copy you can edit. A saved custom theme with the same ID takes
precedence. If the workspace stops publishing the selected theme, T3 Coder falls back to its
standard theme. T3 Coder does not carry upstream's `t3 theme` command, so a workspace cannot set a
default theme for its browsers.

### Publish a theme

Save a theme JSON file into `~/.t3-coder/userdata/themes/` in the workspace. The filename supplies
the theme ID, so keep it stable when updating its colors. Do not use `system`, `light`, `dark`, or a
built-in theme's ID. The workspace publishes at most 32 files of up to 32 KiB each.

For an integration that generates a palette, this shorter format also works:

```json
{
  "name": "Nightfall",
  "appearance": "dark",
  "canvas": "#1a1b26",
  "accent": "#7aa2f7",
  "colors": {
    "terminalSelection": "#292e42",
    "error": "#f7768e"
  }
}
```

Set `appearance` to `light` or `dark` and supply hex colors for `canvas` and `accent`. T3 Coder
generates the rest. The optional `colors` overrides use the names in the theme editor's advanced
view.

Write updates to a temporary file and rename it into place so browsers never read a partial theme.
Invalid files are not published.
