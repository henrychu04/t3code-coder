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

## Images

You can paste PNG, JPEG, or WebP images into a message. T3 Coder validates and places them in its
workspace attachment area. Codex receives validated images as native image input. This exception
does not enable general file uploads.

## Deliberately disabled integrations

T3-managed Codex and Claude sessions do not use MCP servers. Codex app integrations and the Claude
browser integration are also disabled. Skills and native provider commands remain available; they
are distinct from MCP and app integrations.

## Provider settings

The default Codex and Claude settings use the workspace's standard executables, provider homes,
and existing logins. Most users should leave them unchanged. Each provider can be enabled or
disabled independently.

Additional provider instances let a workspace expose another Codex or Claude installation,
identity, or configuration without replacing the default. The same settings experience is used
for both providers, while each provider shows only the choices it supports.

These settings change how T3 Coder uses software and state already present in the workspace. They
do not install a provider, perform login, or copy provider state to the local computer.
