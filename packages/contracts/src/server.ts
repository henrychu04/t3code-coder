import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ServerProviderUsageLimits } from "./providerUsageLimits.ts";

import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  KeybindingCommand,
  KeybindingValue,
  KeybindingWhen,
  ResolvedKeybindingsConfig,
} from "./keybindings.ts";
import { ModelCapabilities } from "./model.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ServerSettings } from "./settings.ts";

const KeybindingsMalformedConfigIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.malformed-config"),
  message: TrimmedNonEmptyString,
});
const KeybindingsInvalidEntryIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.invalid-entry"),
  message: TrimmedNonEmptyString,
  index: Schema.Number,
});

export const ServerConfigIssue = Schema.Union([
  KeybindingsMalformedConfigIssue,
  KeybindingsInvalidEntryIssue,
]);
export type ServerConfigIssue = typeof ServerConfigIssue.Type;
const ServerConfigIssues = ForwardCompatibleArray(ServerConfigIssue);

export const ServerProviderState = Schema.Literals(["ready", "warning", "error", "disabled"]);
export type ServerProviderState = typeof ServerProviderState.Type;
export const ServerProviderAuthStatus = Schema.Literals([
  "authenticated",
  "unauthenticated",
  "unknown",
]);
export type ServerProviderAuthStatus = typeof ServerProviderAuthStatus.Type;

// This is Claude Code authentication inside the remote workspace, not local
// browser authentication.
export const ServerProviderAuth = Schema.Struct({
  status: ServerProviderAuthStatus,
  type: Schema.optional(TrimmedNonEmptyString),
  label: Schema.optional(TrimmedNonEmptyString),
  email: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderAuth = typeof ServerProviderAuth.Type;

export const ServerProviderModel = Schema.Struct({
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  shortName: Schema.optional(TrimmedNonEmptyString),
  subProvider: Schema.optional(TrimmedNonEmptyString),
  isCustom: Schema.Boolean,
  isDefault: Schema.optional(Schema.Boolean),
  isLegacy: Schema.optional(Schema.Boolean),
  capabilities: Schema.NullOr(ModelCapabilities),
});
export type ServerProviderModel = typeof ServerProviderModel.Type;
export const ServerProviderSlashCommandInput = Schema.Struct({ hint: TrimmedNonEmptyString });
export type ServerProviderSlashCommandInput = typeof ServerProviderSlashCommandInput.Type;
export const ServerProviderSlashCommand = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  input: Schema.optional(ServerProviderSlashCommandInput),
});
export type ServerProviderSlashCommand = typeof ServerProviderSlashCommand.Type;
export const ServerProviderSlashCommandsInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  cwd: TrimmedNonEmptyString,
});
export type ServerProviderSlashCommandsInput = typeof ServerProviderSlashCommandsInput.Type;
export const ServerProviderSlashCommands = Schema.Array(ServerProviderSlashCommand);
export type ServerProviderSlashCommands = typeof ServerProviderSlashCommands.Type;
export const ServerProviderSkill = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  path: TrimmedNonEmptyString,
  scope: Schema.optional(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
  displayName: Schema.optional(TrimmedNonEmptyString),
  shortDescription: Schema.optional(TrimmedNonEmptyString),
  /**
   * The skill is hidden from the agent's own skill tool, so only the user can
   * start it — Claude Code's `disable-model-invocation`. Composers must offer
   * it as a slash command; naming it in prose does nothing.
   */
  userInvocationOnly: Schema.optional(Schema.Boolean),
  /**
   * The mirror of {@link ServerProviderSkill.userInvocationOnly}: Claude Code's
   * `user-invocable: false` keeps the skill out of its own slash commands, so
   * only the agent can start it. Composers must not offer it under `/`.
   */
  userInvocable: Schema.optional(Schema.Boolean),
});
export type ServerProviderSkill = typeof ServerProviderSkill.Type;

export const ServerProviderWorkspaceSnapshot = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  checkedAt: IsoDateTime,
  slashCommands: Schema.Array(ServerProviderSlashCommand),
  skills: Schema.Array(ServerProviderSkill),
});
export type ServerProviderWorkspaceSnapshot = typeof ServerProviderWorkspaceSnapshot.Type;

export const ServerProviderAvailability = Schema.Literals(["available", "unavailable"]);
export type ServerProviderAvailability = typeof ServerProviderAvailability.Type;
export const ServerProviderContinuation = Schema.Struct({ groupKey: TrimmedNonEmptyString });
export type ServerProviderContinuation = typeof ServerProviderContinuation.Type;

export const ServerProvider = Schema.Struct({
  usageLimits: Schema.optional(ServerProviderUsageLimits),
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  accentColor: Schema.optional(TrimmedNonEmptyString),
  badgeLabel: Schema.optional(TrimmedNonEmptyString),
  continuation: Schema.optional(ServerProviderContinuation),
  showInteractionModeToggle: Schema.optional(Schema.Boolean),
  // The driver streams context window usage, so a started thread will have a
  // meter once its activities load. Clients reserve the meter's space on it.
  reportsContextWindow: Schema.optional(Schema.Boolean),
  requiresNewThreadForModelChange: Schema.optional(Schema.Boolean),
  enabled: Schema.Boolean,
  installed: Schema.Boolean,
  version: Schema.NullOr(TrimmedNonEmptyString),
  status: ServerProviderState,
  auth: ServerProviderAuth,
  checkedAt: IsoDateTime,
  message: Schema.optional(TrimmedNonEmptyString),
  availability: Schema.optional(ServerProviderAvailability),
  unavailableReason: Schema.optional(TrimmedNonEmptyString),
  models: Schema.Array(ServerProviderModel),
  slashCommands: Schema.Array(ServerProviderSlashCommand).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  workspaceSnapshots: Schema.optionalKey(Schema.Array(ServerProviderWorkspaceSnapshot)),
  skills: Schema.Array(ServerProviderSkill).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type ServerProvider = typeof ServerProvider.Type;
export const ServerProviders = ForwardCompatibleArray(ServerProvider);
export type ServerProviders = typeof ServerProviders.Type;
const isProviderAvailable = (snapshot: ServerProvider): boolean =>
  snapshot.availability !== "unavailable";

export const EnvironmentThemeColor = Schema.String.check(
  Schema.isPattern(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/),
);
export type EnvironmentThemeColor = typeof EnvironmentThemeColor.Type;

/**
 * Matches the client-side theme id rule, so a published id is selectable.
 * The appearance keywords are excluded outright: a published `dark.json`
 * would otherwise capture every client whose stored preference is the stock
 * `"dark"`, retinting people who never chose it.
 */
export const EnvironmentThemeId = Schema.String.check(
  Schema.isPattern(/^(?!(?:system|light|dark)$)[a-z0-9](?:[a-z0-9-]{0,47})$/),
);
export type EnvironmentThemeId = typeof EnvironmentThemeId.Type;

/**
 * Role colors as published. Values are any CSS color the client's theme
 * parser accepts (exported theme files use oklch), canonicalized client-side;
 * roles a build does not know are dropped there, so a machine may publish
 * roles a newer client added without breaking an older one. Keys must still
 * be role-shaped and values color-sized, so the record stays open to future
 * vocabulary without being an arbitrary-payload channel.
 */
const EnvironmentThemeColors = Schema.Record(
  Schema.String.check(Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/)),
  TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
);

const environmentThemeFields = {
  /**
   * Standard exported theme files (the Download button's output) carry
   * `version: 1`; the seeded short form a desktop generates has no version.
   */
  version: Schema.optional(Schema.Literal(1)),
  /** Shown on the theme card, e.g. the desktop theme's own name. */
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(48)),
  appearance: Schema.Literals(["light", "dark"]),
  /**
   * Seed colors. When present, clients derive the full palette from them with
   * the guided theme editor's generator and layer `colors` on top; when
   * absent, `colors` is the palette, as in an exported theme file.
   */
  canvas: Schema.optional(EnvironmentThemeColor),
  accent: Schema.optional(EnvironmentThemeColor),
  colors: Schema.optional(EnvironmentThemeColors),
  /** The other appearance's palette, as exported theme files carry it. */
  variants: Schema.optional(
    Schema.Struct({
      light: Schema.optional(EnvironmentThemeColors),
      dark: Schema.optional(EnvironmentThemeColors),
    }),
  ),
};

/** One published theme file. The id is the filename, not part of the content,
 * so a file cannot claim another file's identity; an embedded `id` is ignored. */
export const EnvironmentThemeFile = Schema.Struct(environmentThemeFields);
export type EnvironmentThemeFile = typeof EnvironmentThemeFile.Type;

export const EnvironmentTheme = Schema.Struct({
  /** The publishing filename without its extension, stable across recolors. */
  id: EnvironmentThemeId,
  ...environmentThemeFields,
});
export type EnvironmentTheme = typeof EnvironmentTheme.Type;

/**
 * Whether a theme file carries anything to render. A file with neither seeds
 * nor colors would show as the stock palette wearing a name, which reads as a
 * bug rather than a theme — the CLI and the server watcher both reject it,
 * through this one predicate so they cannot drift.
 */
export function environmentThemeFileHasColors(file: EnvironmentThemeFile): boolean {
  return (
    (file.canvas !== undefined && file.accent !== undefined) ||
    (file.colors !== undefined && Object.keys(file.colors).length > 0)
  );
}

export const ServerConfig = Schema.Struct({
  environment: ExecutionEnvironmentDescriptor,
  cwd: TrimmedNonEmptyString,
  keybindingsConfigPath: TrimmedNonEmptyString,
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
  providers: ServerProviders,
  environmentThemes: Schema.optional(Schema.Array(EnvironmentTheme).check(Schema.isMaxLength(32))),
  settings: ServerSettings,
  reasoningMessages: Schema.optionalKey(Schema.Boolean),
});
export type ServerConfig = typeof ServerConfig.Type;

const ServerUpsertKeybindingReplaceTarget = Schema.Struct({
  key: KeybindingValue,
  command: KeybindingCommand,
  when: Schema.optional(KeybindingWhen),
});
export const ServerUpsertKeybindingInput = Schema.Struct({
  key: KeybindingValue,
  command: KeybindingCommand,
  when: Schema.optional(KeybindingWhen),
  replace: Schema.optional(ServerUpsertKeybindingReplaceTarget),
});
export type ServerUpsertKeybindingInput = typeof ServerUpsertKeybindingInput.Type;
export const ServerRemoveKeybindingInput = ServerUpsertKeybindingReplaceTarget;
export type ServerRemoveKeybindingInput = typeof ServerRemoveKeybindingInput.Type;
export const ServerUpsertKeybindingResult = Schema.Struct({
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
});
export type ServerUpsertKeybindingResult = typeof ServerUpsertKeybindingResult.Type;
export const ServerRemoveKeybindingResult = ServerUpsertKeybindingResult;
export type ServerRemoveKeybindingResult = typeof ServerRemoveKeybindingResult.Type;

export const ServerConfigKeybindingsUpdatedPayload = Schema.Struct({
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
});
export type ServerConfigKeybindingsUpdatedPayload =
  typeof ServerConfigKeybindingsUpdatedPayload.Type;
export const ServerConfigProviderUpdatedPayload = Schema.Struct({ provider: ServerProvider });
export type ServerConfigProviderUpdatedPayload = typeof ServerConfigProviderUpdatedPayload.Type;
export const ServerConfigProviderRemovedPayload = Schema.Struct({ instanceId: ProviderInstanceId });
export type ServerConfigProviderRemovedPayload = typeof ServerConfigProviderRemovedPayload.Type;
export const ServerConfigSettingsUpdatedPayload = Schema.Struct({ settings: ServerSettings });
export type ServerConfigSettingsUpdatedPayload = typeof ServerConfigSettingsUpdatedPayload.Type;

export const ServerConfigStreamSnapshotEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("snapshot"),
  config: ServerConfig,
});
export type ServerConfigStreamSnapshotEvent = typeof ServerConfigStreamSnapshotEvent.Type;
export const ServerConfigStreamKeybindingsUpdatedEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("keybindingsUpdated"),
  payload: ServerConfigKeybindingsUpdatedPayload,
});
export type ServerConfigStreamKeybindingsUpdatedEvent =
  typeof ServerConfigStreamKeybindingsUpdatedEvent.Type;
export const ServerConfigStreamProviderUpdatedEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("providerUpdated"),
  payload: ServerConfigProviderUpdatedPayload,
});
export type ServerConfigStreamProviderUpdatedEvent =
  typeof ServerConfigStreamProviderUpdatedEvent.Type;
export const ServerConfigStreamProviderRemovedEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("providerRemoved"),
  payload: ServerConfigProviderRemovedPayload,
});
export type ServerConfigStreamProviderRemovedEvent =
  typeof ServerConfigStreamProviderRemovedEvent.Type;
export const ServerConfigStreamSettingsUpdatedEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("settingsUpdated"),
  payload: ServerConfigSettingsUpdatedPayload,
});
export type ServerConfigStreamSettingsUpdatedEvent =
  typeof ServerConfigStreamSettingsUpdatedEvent.Type;
export const ServerConfigStreamEnvironmentThemesUpdatedEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("environmentThemesUpdated"),
  payload: Schema.Struct({ themes: Schema.Array(EnvironmentTheme).check(Schema.isMaxLength(32)) }),
});
export const ServerConfigStreamEvent = Schema.Union([
  ServerConfigStreamSnapshotEvent,
  ServerConfigStreamEnvironmentThemesUpdatedEvent,
  ServerConfigStreamKeybindingsUpdatedEvent,
  ServerConfigStreamProviderUpdatedEvent,
  ServerConfigStreamProviderRemovedEvent,
  ServerConfigStreamSettingsUpdatedEvent,
]);
export type ServerConfigStreamEvent = typeof ServerConfigStreamEvent.Type;

export const ServerLifecycleReadyPayload = Schema.Struct({
  at: IsoDateTime,
  environment: ExecutionEnvironmentDescriptor,
});
export type ServerLifecycleReadyPayload = typeof ServerLifecycleReadyPayload.Type;
export const ServerLifecycleWelcomePayload = Schema.Struct({
  environment: ExecutionEnvironmentDescriptor,
  cwd: TrimmedNonEmptyString,
  projectName: TrimmedNonEmptyString,
  bootstrapProjectId: Schema.optional(ProjectId),
  bootstrapThreadId: Schema.optional(ThreadId),
});
export type ServerLifecycleWelcomePayload = typeof ServerLifecycleWelcomePayload.Type;
export const ServerLifecycleStreamWelcomeEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("welcome"),
  payload: ServerLifecycleWelcomePayload,
});
export type ServerLifecycleStreamWelcomeEvent = typeof ServerLifecycleStreamWelcomeEvent.Type;
export const ServerLifecycleStreamReadyEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("ready"),
  payload: ServerLifecycleReadyPayload,
});
export type ServerLifecycleStreamReadyEvent = typeof ServerLifecycleStreamReadyEvent.Type;
export const ServerLifecycleStreamEvent = Schema.Union([
  ServerLifecycleStreamWelcomeEvent,
  ServerLifecycleStreamReadyEvent,
]);
export type ServerLifecycleStreamEvent = typeof ServerLifecycleStreamEvent.Type;
