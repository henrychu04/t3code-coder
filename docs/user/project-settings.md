# Settings and project overrides

The workspace and project menus in the Settings breadcrumb choose where changes apply.
They start at **All workspaces** and **All projects** and stay selected when you change categories
or search for a setting. Choose one workspace to edit it, or leave **All workspaces** to edit the
selected connected workspaces together. Offline workspaces keep their current settings; this is a
bulk edit, not a synchronized global default.

Choose a project to override settings for its checkouts in the selected workspaces. A layers icon
beside each scoped setting shows the built-in default, workspace value, and project override.
Open it to inspect those values in each workspace. Reset a project override to inherit again.
Settings that do not support project overrides become read-only while a project is selected.

Rows show **Mixed** when selected targets disagree. Changing a value applies the edited setting to
the selected connected targets. When action lists differ, adding an action preserves each workspace’s existing list.
Failed action saves retain the editor draft for retry.

Changing a workspace value preserves project overrides. The layers menu lists projects that
have overrides: select one to open its scope, or choose **Reset all** to make those projects inherit
that setting again. Browser preferences such as appearance ignore the workspace/project selection.
Provider settings show one workspace at a time, using the active workspace until you pick another.
Appearance and Coder connections hide these scope menus because their controls do not use project scope.

Use **Search settings** in the sidebar to find a control by name or keyword. Press `/` outside a
text field or dialog to focus search, use the arrow keys to choose a result, and press Enter to
open it. Escape clears the search before leaving Settings. Search results preserve the selected
workspace, project, and checkout.

## Project details

Open the project picker in the sidebar and select the project's settings button, or use
**Project settings** in a new-thread header. The settings sidebar stays visible with **Projects**
selected. This category appears while a project is selected and holds its name, icon, actions,
checkouts, and removal controls. The breadcrumb selects the workspace, project, and checkout;
choose **All checkouts** to edit the selected project group.

The name saves when you leave its field or press Enter. Group edits apply to the selected
checkouts; all selected workspaces must be connected for name and icon changes. Model, permissions,
and checkout defaults live in **General**. Automatic pull and merge preferences live in
**GitLab source control**. Those same controls edit project overrides while a project is selected.

## Default merge method

Choose **Default merge method** to prefer merge, squash, or rebase for this project's GitLab
merge requests. This setting saves immediately in the selected Coder workspace. Choose
**Last used in this workspace** to clear the project override.

The merge-request panel uses your current selection, then the project default, then the last
method selected in that workspace. If GitLab disallows a method, the panel selects an allowed
one. Choosing a default does not merge a request or bypass GitLab permissions.

Choose **Monogram** in the icon picker to set one or two letters or numbers and a color.

When no image is found, web and desktop show a two-character monogram with a color
from the icon palette, derived from the saved project name. For example, `Nebula` becomes `NA`,
`Silver Orchard` becomes `SO`, and `M7 Forge` becomes `M7`.

## Keep the default branch current

Enable **Automatically pull** to keep the default-branch checkout up to date with its configured
upstream. T3 Coder only pulls when it can fast-forward and the checkout has no changed files,
untracked files, or local commits. It skips checkouts on another branch or without an upstream.
Resolve local work yourself before automatic pulls can resume.

## Scripts

Saving a script does not execute it. At most one script can be selected to run automatically when
a new worktree is created. That script runs inside the Coder workspace through the existing helper
and terminal mechanism. There are no local-host script runners or browser-preview controls.

**Choose icon** opens the searchable Lucide catalog, color palette, and emoji picker. The reset
button clears the choice. Automatic icons use upstream’s name-based monograms, such as `SO` for
`Silver Orchard`. Choices are saved on workspace project records and appear on connected clients. Desktop file picking and project-image selection are not included. Deployment-wide
authentication and GitLab preferences remain under global settings.

## Workspace defaults

Open **Settings → General → New threads** to choose the default model and checkout mode.
**Settings → GitLab source control → Repositories** contains automatic pull. These controls save
immediately for the selected scope. **Settings → General → Default actions** contains the
workspace's default scripts when All projects is selected. Use **Add action**, or the edit button beside an existing action;
**Save action** or **Save changes** saves the dialog.
Choose a workspace and, optionally, a project using the shared scope menus. Only edited settings
apply to the selected connected targets. Offline workspaces retain their settings.
A model and its provider must be available in every selected workspace.

Defaults apply to projects that inherit the corresponding preference. Existing project model and
checkout overrides, explicit automatic-pull choices, and existing scripts are preserved. Changing
the model default affects new threads; it does not change existing conversations. Automatic pull
runs at helper startup and retains the clean-checkout, default-branch, and fast-forward checks.

Use the reset button beside a setting to restore workspace inheritance. Editing inherited actions
creates an independent project list; an explicit empty list disables actions for that project.
Saving actions does not execute them.

## Permissions, responses, and workflow overrides

A project can override default permissions for new threads, response streaming, generated thread
names, source-control writing style and writer model, starting new worktrees from origin, and
automatic settlement rules. These controls save
immediately in the selected Coder workspace. Reset an override to inherit the workspace value;
changing the workspace default preserves explicit project choices.

Source-control preferences include repository conventions, Conventional Commits, custom
instructions, merge-request templates, and an optional dedicated writer model. Each project can
restore the workspace writing style or writer-model choice independently.

Existing project preferences migrate once into the override model. Resetting a preference remains
an inheritance choice after reconnects and restarts. Existing threads keep their chosen model and
permission mode.

## Provider usage

Provider settings show availability and authentication status for each workspace. Context/token
usage and runtime rate-limit errors remain visible in conversations. This fork supports API-backed
usage and does not include subscription-quota dashboards. See [Usage and limits](./providers.md#usage-and-limits).

## Project management

Select a project with **All checkouts** to rename its selected checkouts together. Individual
checkouts can be removed from the Checkouts section. The Danger section removes the selected
checkout or the entire selected project group. Confirmation describes the entries and history
being deleted. Repository files remain on disk; entries outside the selection are unaffected.

## Custom themes

Open **Settings → Appearance** and choose **Create theme**, or duplicate a library theme.
The upstream editor has guided Canvas and Accent controls, advanced color roles, and an inspector
for picking colors from the app. Its live preview and draft remain open as you navigate, so you can
judge colors in threads and other pages. Save to apply the theme; closing without saving restores
your saved colors. The library supports editing, duplicating, removing, and mixing light/dark
palettes. Custom themes are browser preferences. File imports and exports are not available.

## Repository configuration

A checkout's `t3.json` can share actions and the default checkout mode with other users of the
repository. In **Projects**, use **Import scripts** to add an action from the representative checkout
to every selected connected checkout. Select one checkout to import from that specific repository. Reading the configuration does not run any scripts. Existing action names (ignoring case) or
commands are omitted from the import menu. Invalid configuration shows a warning; after fixing
it in the workspace, use **Refresh t3.json**.

For new threads, an explicit project override wins, followed by `defaultThreadEnvMode` in
`t3.json`, followed by the workspace default. General shows the repository default when one is
available. Supported modes are `local` and `worktree`. The configuration is read again when new
threads need the default. Preview URLs and file-based icons are not supported.

## Workspace themes

The active workspace can publish themes from `<stateDir>/themes/<id>.json`, where `stateDir` is
the helper's configured state directory. Appearance shows those themes alongside the built-in
library. Select a theme to follow workspace updates, or duplicate it to create an editable browser
copy. A published theme can provide `name`, `appearance` (`light` or `dark`), and `canvas` and
`accent` hex colors; full `colors` and light/dark `variants` are also supported. The file's name
supplies its ID. Built-in IDs are reserved.

Published themes update over the workspace connection. Their palettes are held in browser memory;
only the selected ID is saved as a preference. A live theme-editor preview remains visible while
published themes change. Published cards cannot be edited or removed through the browser.

## Coder connections

**Settings → Coder connections** lists Coder domains, workspace connections, and port forwards.
Use **Add domain** or **Add forward** to open an editor. Existing entries have an actions menu
with edit and removal controls. Changes apply when you save the dialog; a failed save keeps your
entries available for correction and retry. Domain sign-in still takes place in the terminal
running T3 Coder.

Workspace rows show runtime status and scheduled stops. Use **Start** or **Reconnect** on the row;
its actions menu contains update, restart, stop, and removal controls. Operation failures appear
beside the affected entry, with expandable technical details. Scheduled checks on this page pause while it
is in a hidden browser tab and refresh when the tab becomes visible.

Port forwards can be edited without removing and recreating them. Local ports must be unique
within each protocol. A failed forward stays stopped until you explicitly restart it or change
its configuration. Removing a workspace connection also removes its saved forwards.

These connection settings belong to this computer and do not use workspace or project scope.
Settings search includes domains, workspace connections, and port forwarding even when no
workspace is connected.

## GitLab workspace status

**Settings → GitLab source control → Workspace GitLab status** shows installation, authentication,
and write access for the connected workspaces selected in the breadcrumb. Use **Check status**
to refresh a workspace and **Check write access** to run its write probe. Errors remain beside
the affected workspace. Project-detail links on this page follow the selected scope as well.

## Storage cleanup

Open **Settings → Storage** to configure retention for selected Coder workspaces. Cleanup is off
by default. Enabled policies run when the helper starts, when settings change, and hourly while
the helper is running. Offline workspaces retain their settings and resume cleanup on reconnect.

Worktree rules can remove T3-managed checkouts after inactivity, after their branch is merged,
when unchanged from the remote default branch, or after deleting their last thread. Active sessions,
terminals, shared checkouts, uncommitted changes, and ignored files other than `node_modules`
prevent removal. Branches and conversation history stay; resuming a thread recreates its worktree.
Choose a project to inherit the workspace policy, turn cleanup off, or define custom rules.

Saved image artifacts and rotated logs have separate workspace-wide retention periods. Artifact
retention applies to legacy copies in `$HOME/.t3-coder/artifacts`: expired links stop opening.
Submitted composer attachments, current workspace source images, and current logs are kept.

## Theme shortcuts

Use **Change theme** in the command palette, or `mod+alt+a`, to select a theme without leaving chat.
**Change appearance** selects System, Light, or Dark independently. `mod+alt+shift+a` cycles those
modes. Customize both shortcuts in **Settings → Keyboard shortcuts**.
