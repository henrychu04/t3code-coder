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
