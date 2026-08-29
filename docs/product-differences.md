# Product decisions and upstream differences

T3 Coder is the Coder-workspace edition of [T3 Code](https://github.com/pingdotgg/t3code).
Upstream T3 Code is the source of truth for shared agent behavior and user experience. This fork
keeps upstream behavior unless the Coder deployment model, the supported product scope, or the
security boundary requires a deliberate change.

This is a product comparison, not a commit-by-commit ledger. Maintainers review upstream changes
against these decisions and record new intentional differences here.

## Kept from upstream

- The browser-based project, thread, conversation, terminal, review, and settings experience.
- Codex and Claude Code conversations, including streaming responses, approvals, questions,
  interruption, resumption, context information, and provider-reported sub-agent activity.
- Provider-aware model selection. Models, reasoning choices, service tiers, skills, commands, and
  access modes appear when the selected workspace provider reports them.
- Repository-local Git status, diffs, branches, worktrees, commits, checkpoints, and revert flows.
- Thread organization, keyboard shortcuts, appearance preferences, and project-aware search.

## Adjusted for Coder

### The workspace is the development environment

Upstream normally controls providers and repositories on the machine running its server. T3 Coder
controls them inside an authenticated Linux Coder workspace instead. The browser remains local,
but provider sessions, repositories, terminals, and durable T3 state belong to the workspace.

### Providers are workspace capabilities

T3 Coder supports Codex and Claude Code when their CLIs are available in the workspace. The app
does not install either provider or move its credentials to the local computer. A workspace can
connect with either provider present.

The model picker offers models only from providers that are enabled, available, and ready. If
Codex is missing or unauthenticated, Claude remains usable when it is ready, and the reverse is
also true. T3 Coder may choose a ready provider for a new draft, but it never silently changes the
provider for an existing thread or a turn already in progress.

### Access choices reflect workspace policy

The access menu uses the same product modes as upstream, but only shows modes supported by the
selected provider and model. Codex configuration requirements can remove modes that the workspace
does not allow. Until provider capabilities are known, T3 Coder offers only the conservative
supervised choices.

### Workspace lifecycle is explicit

T3 Coder shows Coder workspace state, health, latency, resource use, idle-stop timing, and template
updates. Starting, stopping, restarting, or updating a workspace is an explicit user action.
Configured TCP or UDP forwards are explicit rules and always bind to local loopback.

### Source control stays inside the repository

Local Git workflows remain available. Networked source-control actions—fetch, pull, push, creating
pull requests, and hosted-provider integrations—are left to approved workspace tooling.

### File access is contained

The Files surface lists, reads, searches, and edits text files inside the active project. It does
not provide general upload, download, export, synchronization, or access to arbitrary local or
workspace paths. Pasted prompt images and turn-scoped screenshot artifacts are narrow,
validated exceptions.

## Improved for this product

- Workspace connection diagnostics make authentication, preflight, helper startup, reconnecting,
  health, and latency visible instead of presenting them as a generic connection failure.
- Workspace lifecycle controls avoid implicitly starting stopped workspaces and preserve clear
  state while actions are running or fail.
- The Files surface and project search provide a focused way to inspect and edit workspace code
  without turning the app into a file-transfer client.
- Bounded caches, resumable terminal traffic, paged thread history, and explicit oversized-diff
  results keep long-running sessions responsive.
- Screenshot artifacts let users review visual verification without introducing a browser-preview
  service or a general file-download path.
- The smaller distribution is easier to review because unsupported clients, services, providers,
  and external integrations are absent.

## Deliberately unavailable

- Electron and other native desktop packaging, iOS and Android clients, and a hosted web client.
- Relay, Tailscale, Cloudflare, OAuth, Clerk, generic SSH environments, and public or non-loopback
  application listeners.
- Providers other than workspace-installed Codex and Claude Code.
- MCP servers, Codex app integrations, the Claude browser integration, and the packaged Anthropic
  Agent SDK.
- General-purpose uploads, downloads, exports, drag-and-drop transfer, clipboard text transfer,
  and background file synchronization.
- Git fetch, pull, push, pull-request creation, and hosted source-control integrations.
- Browser preview, automatic updates, T3-owned telemetry, and automatic browser launch.

These are product boundaries, not temporary error states. Restoring one requires an explicit
product decision and a corresponding security review.

## How upstream changes are handled

When upstream changes shared Codex, Claude, composer, thread, review, or settings behavior, the
default decision is to carry it forward. A change is adapted only when necessary to keep work in
Coder or preserve the documented boundary. A change is omitted only when it belongs to a
deliberately unavailable product area.

The [maintainer architecture](./internals/coder-only.md) defines the implementation boundary, and
[Security and data handling](./compliance-review.md) provides review evidence for these product
decisions.
