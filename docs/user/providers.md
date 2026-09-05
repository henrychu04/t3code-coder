# Codex and Claude Code

T3 Coder uses the Codex and Claude Code installations already available in the connected Coder
workspace. It does not run a provider on the local computer, install a provider in the workspace,
or copy provider credentials between them.

## Provider availability

Each provider is checked independently.

| Status          | What it means                                                                    |
| --------------- | -------------------------------------------------------------------------------- |
| Ready           | The CLI responded, its authentication is usable, and it can contribute models.   |
| Unauthenticated | The CLI is installed, but you must sign in inside the workspace before using it. |
| Unavailable     | The CLI is missing, disabled, incompatible, or could not be checked.             |

Only ready providers contribute models to the model picker. An unavailable provider remains visible
with an explanation where that context is useful, but it cannot be selected for new work.

Only one provider needs to be installed for the workspace to connect. If Codex is unavailable and
Claude is ready, Claude continues to work; the reverse is also true. There is no automatic
mid-thread or mid-turn fallback. Existing work remains tied to its provider so T3 Coder does not
silently change agent behavior or conversation history.

## Sign in

Provider authentication belongs to the workspace. Open a workspace terminal and use the provider's
normal command:

```bash
codex login
claude auth login
```

Reconnect after signing in so the provider status and capabilities are checked again.

## Models and controls

The model picker is capability-driven rather than a hard-coded compatibility list:

- Codex models, reasoning choices, and service tiers come from the workspace Codex app server.
- Claude models and supported access modes come from the workspace Claude Code installation.
- A model appears only while its provider is ready.
- The current and older model sections follow the upstream model lifecycle list bundled with the
  T3 Coder release.
- Existing threads retain their recorded provider and model selection unless the user explicitly
  changes a supported option.

The access menu follows the same principle. It shows the modes supported by the selected provider
and model. Workspace Codex configuration requirements can restrict which modes are offered.

See [Access modes](./permission-modes.md) for what each mode means.

## Commands and skills

Type `/` in the composer to search available commands. Type `$` to search available skills.
T3 Coder uses the inventory reported by the selected workspace provider and project, so the list
can differ between Codex and Claude or between workspaces.

Codex sub-agent activity includes model and reasoning information when Codex reports it. T3 Coder
leaves missing metadata blank rather than copying the parent agent's settings.

Codex can also surface asynchronous questions while it continues working. Answering one records
the resolution and starts a follow-up message in the same thread; unanswered questions remain
available even after a long activity history. Context compaction is available for both Codex and
Claude through the context meter and `/compact` command.

## Images

You can paste PNG, JPEG, or WebP images into a message. T3 Coder validates and places them in its
workspace attachment area. Codex receives validated images as native image input. This exception
does not enable general file uploads.

## Deliberately disabled integrations

T3-managed Codex and Claude sessions do not use MCP servers. Codex app integrations and the Claude
browser integration are also disabled. Skills and native provider commands remain available; they
are distinct from MCP and app integrations.

## Provider settings

The Providers page always shows which workspace you are editing. On the first visit it selects the
workspace from your current conversation when possible, otherwise the first configured workspace.
It remembers an explicit selection while T3 Coder remains open and lets you switch workspaces at
any time. A stopped or unavailable workspace remains selected and must be started from Coder
connections before its provider settings can be read or changed.

Provider configuration and text-generation defaults are stored in the selected workspace. Model
favorites, hidden models, and model ordering are also kept separately for each workspace.

The default Codex and Claude settings use the workspace's standard executables, provider homes,
and existing logins. Most users should leave them unchanged. Each provider can be enabled or
disabled independently.

Additional provider instances let a workspace expose another Codex or Claude installation,
identity, or configuration without replacing the default. The same settings experience is used
for both providers, while each provider shows only the choices it supports.

The Models section also lets you add, edit, and remove custom model IDs, give them display names,
and configure the controls exposed for those models. Existing custom model IDs remain valid
without conversion. These definitions are stored in the selected workspace; they do not install
a model or grant access to one that the workspace provider cannot use.

These settings change how T3 Coder uses software and state already present in the workspace. They
do not install a provider, perform login, or copy provider state to the local computer.

## Subscription limits

The selected workspace provider shows its reported subscription windows, percentage used, and
reset times. Codex and Claude Code read these through their workspace CLI processes using existing
logins. API-key accounts may not have subscription windows.

These snapshots refresh with provider health checks, rather than continuously during a turn.
The **Checked** time identifies the snapshot; an unavailable read is not shown as zero usage.
There are no external usage hubs, pricing lookups, or reset-credit redemption actions.

When Claude reports a blocking usage limit during a turn, the conversation shows a warning.
Claude's own safety fallback notifications are also shown; T3 Coder does not initiate a provider
or account switch.
