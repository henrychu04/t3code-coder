# Codex and Claude Code

T3 Coder uses the Codex and Claude Code installations already available in the connected Coder
workspace. It does not run a provider on the local computer, install a provider in the workspace,
or copy provider credentials between them.

This fork supports API-backed usage only. Subscription-backed ChatGPT and Claude consumer plans
are outside the supported product scope. This describes the supported configuration, rather than
a runtime check that rejects every other authentication mode.

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

## API authentication

Configure API access through the workspace's Codex or Claude Code configuration and your
organization's credential-management process. Credentials belong in the workspace provider
configuration, never in T3 Coder's browser or local gateway. T3 Coder does not collect API keys.

Reconnect after updating authentication so provider status and capabilities are checked again.

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
available even after a long activity history. Dismiss an asynchronous question to close it without
sending anything to Codex; blocking questions still require an answer or interruption. Context compaction is available for both Codex and
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
and existing API authentication. Most users should leave them unchanged. Each provider can be enabled or
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

## Usage and limits

Provider settings show availability and authentication status, without subscription-quota panels.
The conversation retains context/token usage and provider-reported runtime limit errors. These
are not API spend, credit balances, or billing limits; consult your API billing system for those.
T3 Coder does not provide a billing dashboard, external usage hubs, or pricing lookups.

When Claude reports a blocking usage limit during a turn, the conversation shows a warning.
Claude's own safety fallback notifications are also shown; T3 Coder does not initiate a provider
or account switch.

When Codex reports a usage-limit failure, the conversation names the exhausted window and its
reset time when available. These are provider runtime errors, not an API billing dashboard.

Claude verbose output is supported for generated titles, branch names, commit messages, and merge
request descriptions. These metadata requests run in the workspace with executable tools, hooks,
skills, and configured MCP servers disabled; title generation also runs outside the project folder.
