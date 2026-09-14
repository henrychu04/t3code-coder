# Settings and project overrides

The **Workspace** and **Project** selectors at the top of Settings choose where changes apply.
They start at **All workspaces** and **All projects** and stay selected when you change categories
or search for a setting. Choose one workspace to edit it, or leave **All workspaces** to edit the
selected connected workspaces together. Offline workspaces keep their current settings; this is a
bulk edit, not a synchronized global default.

Choose a project to override settings for its checkouts in the selected workspaces. A layers icon
beside each scoped setting shows the built-in default, workspace value, and project override.
Open it to inspect those values in each workspace. Reset a project override to inherit again.
Settings that do not support project overrides become read-only while a project is selected.

Rows show **Mixed** when selected targets disagree. Changing a value applies the edited setting to
the selected connected targets. In **Projects**, only fields you edit are saved; untouched mixed
values remain unchanged. Failed saves retain the form draft for retry.

Changing a workspace value preserves project overrides. The layers menu lists projects that
have overrides: select one to open its scope, or choose **Reset all** to make those projects inherit
that setting again. Browser preferences such as appearance ignore the workspace/project selection.
Provider settings show one workspace at a time, using the active workspace until you pick another.

## Project details

Open the project picker in the sidebar and select the project's settings button, or use
**Project settings** in a new-thread header. **Settings → Projects → Project details** also links
to each checkout's page. Changes on that page apply only to that checkout, even when the sidebar
groups several checkouts together, and stay stored in its Linux Coder workspace.

Edit the project name, default model, current-checkout/new-worktree default, automatic pull, or
scripts, then choose **Save project settings**. Model and checkout defaults apply to new threads.
**Reload settings** discards unsaved changes and reads the latest displayed settings. If another
client changes these settings while the form is open, reload before saving.

## Default merge method

Choose **Default merge method** to prefer merge, squash, or rebase for this project's GitLab
merge requests. This setting saves immediately in the selected Coder workspace. Choose
**Last used in this workspace** to clear the project override.

The merge-request panel uses your current selection, then the project default, then the last
method selected in that workspace. If GitLab disallows a method, the panel selects an allowed
one. Choosing a default does not merge a request or bypass GitLab permissions.

## Keep the default branch current

Enable **Automatically pull** to keep the default-branch checkout up to date with its configured
upstream. T3 Coder only pulls when it can fast-forward and the checkout has no changed files,
untracked files, or local commits. It skips checkouts on another branch or without an upstream.
Resolve local work yourself before automatic pulls can resume.

## Scripts

Saving a script does not execute it. At most one script can be selected to run automatically when
a new worktree is created. That script runs inside the Coder workspace through the existing helper
and terminal mechanism. There are no local-host script runners or browser-preview controls.

Desktop file picking and upstream project-image selection are not included. Deployment-wide
authentication and GitLab preferences remain under global settings.

## Workspace defaults

Open **Settings → Projects** to set the default model, checkout mode, automatic pull, and scripts.
Choose a workspace and, optionally, a project using the shared scope selectors. Saving applies
only edited fields to the selected connected targets. Offline workspaces retain their settings.
A model and its provider must be available in every selected workspace.

Defaults apply to projects that inherit the corresponding preference. Existing project model and
checkout overrides, explicit automatic-pull choices, and existing scripts are preserved. Changing
the model default affects new threads; it does not change existing conversations. Automatic pull
runs at helper startup and retains the clean-checkout, default-branch, and fast-forward checks.

Open a checkout under **Project details** to edit its preferences. Turning off the model override
or choosing **Use default** for checkout mode restores inheritance. **Use workspace automatic-pull
default** and **Use workspace default scripts** reset those individual overrides. Editing inherited
scripts creates an independent project list; an explicit empty list disables scripts for that
project. Saving scripts does not execute them.

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
