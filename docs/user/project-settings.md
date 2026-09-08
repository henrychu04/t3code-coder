# Project settings

Open the project picker in the sidebar and select the project's settings button. A new-thread
header also has a **Project settings** button. Global **Settings → GitLab source control** links
to each project's page.

The page follows upstream T3 Code's dedicated project-settings layout. Select the Coder workspace
and project in the page header. Changes apply only to that checkout, even when the sidebar groups
several checkouts together. Settings remain stored in the selected Linux Coder workspace.

Edit the project name, default model, current-checkout/new-worktree default, automatic pull, or
project scripts, then choose **Save project settings**. Model and checkout defaults apply to new
threads. **Reload settings** discards unsaved form changes and reads the latest displayed settings.
If another client changes these settings while the form is open, reload before saving.

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
Choose one Coder workspace or **All connected workspaces**. The form starts with the first selected
workspace's values; saving applies those values to the selected connected workspaces. Offline
workspaces retain their settings. A model must be available in every selected workspace.

Defaults apply to projects that inherit the corresponding preference. Existing project model and
checkout overrides, explicit automatic-pull choices, and existing scripts are preserved. Changing
the model default affects new threads; it does not change existing conversations. Automatic pull
runs at helper startup and retains the clean-checkout, default-branch, and fast-forward checks.

Open a project under **Project overrides** to edit its preferences. Turning off the model override
or choosing **Use default** for checkout mode restores inheritance. **Use workspace automatic-pull
default** and **Use workspace default scripts** reset those individual overrides. Editing inherited
scripts creates an independent project list; an explicit empty list disables scripts for that
project. Saving scripts does not execute them.

## Provider usage

Provider settings show availability and authentication status for each workspace. Context/token
usage and runtime rate-limit errors remain visible in conversations. This fork supports API-backed
usage and does not include subscription-quota dashboards. See [Usage and limits](./providers.md#usage-and-limits).
